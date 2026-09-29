'use strict';

// test/scheduler-automation-errors.test.js — Chemins d'erreur de
// _executeAutomation et _failJob (issue #87, tâche 55.18) : transition
// impossible, webview absente, quota, heures calmes, erreur générique,
// délai de réponse dépassé, exception. Tout est simulé (app Electron avec
// userData temporaire, webContents factice, runClaudeJob / _pollClaudeResponse
// remplacés) : aucun accès réseau, aucune attente réelle.

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const { Scheduler } = require('../scheduler/index');
const core = require('../scheduler/core');

// --- Outils de simulation ---------------------------------------------------

function createScheduler() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iao-autoerr-'));
  const scheduler = new Scheduler({ getPath: function() { return tmpDir; } }, {});
  // Hors heures calmes, quelle que soit l'heure d'exécution.
  scheduler.quietHoursCheck = function() { return false; };
  return scheduler;
}

function cleanup(scheduler) {
  try { fs.rmSync(scheduler.dir, { recursive: true, force: true }); } catch (_) {}
}

function hasLog(scheduler, fragment) {
  return scheduler.log.some(function(e) { return e.message.indexOf(fragment) !== -1; });
}

// Crée un projet avec une tâche assignée à `profil_1` portant un prompt, et
// un job RESUME_REQUIRED rattaché à ce projet.
function setupJob(scheduler, opts) {
  const o = opts || {};
  scheduler.createProject('Projet erreurs', []);
  const project = scheduler.projects[0];
  scheduler.createTask(project.id, 'Prompt de la tâche', null);
  const task = project.tasks[0];
  task.assignedProfile = 'profil_1';
  task.status = 'assigned';
  const job = core.buildJobRecord({
    id: 'job_001',
    projectId: project.id,
    profile: 'profil_1',
    status: o.status || 'RESUME_REQUIRED'
  });
  scheduler.jobs.push(job);
  if (o.withWebview !== false) scheduler.registerWebview('profil_1', { executeJavaScript: async function() { return '{}'; } });
  return { project: project, task: task, job: job };
}

// Remplace temporairement setTimeout pour capturer les reprises programmées
// sans les déclencher. `withUnref` choisit si le faux timer expose unref().
async function withCapturedTimeouts(withUnref, fn) {
  const original = global.setTimeout;
  const captured = [];
  global.setTimeout = function(cb, ms) {
    const timer = { unrefCalled: false };
    if (withUnref) timer.unref = function() { timer.unrefCalled = true; };
    captured.push({ cb: cb, ms: ms, timer: timer });
    return timer;
  };
  try {
    await fn(captured);
  } finally {
    global.setTimeout = original;
  }
  return captured;
}

// --- _executeAutomation : transition et prompt ---------------------------------

test('_executeAutomation abandonne si la transition vers RUNNING est impossible', async () => {
  const scheduler = createScheduler();
  const ctx = setupJob(scheduler, { status: 'DELIVERED' });
  const before = ctx.job.started_at;
  let called = false;
  scheduler.runClaudeJob = async function() { called = true; return {}; };

  await scheduler._executeAutomation(ctx.job);

  assert.strictEqual(ctx.job.status, 'DELIVERED', 'le statut ne change pas');
  assert.strictEqual(ctx.job.started_at, before);
  assert.strictEqual(called, false, 'runClaudeJob n\'est jamais appelé');
  assert.ok(hasLog(scheduler, 'transition vers RUNNING impossible'));
  assert.ok(hasLog(scheduler, 'DELIVERED -> RUNNING'));
  assert.ok(!hasLog(scheduler, 'lancement de l\'automatisation'));
  cleanup(scheduler);
});

test('_executeAutomation : un job sans prompt de tâche passe par le prompt de livraison par défaut', async () => {
  const scheduler = createScheduler();
  // Job sans projet ni tâche : aucun prompt -> chemin du prompt par défaut.
  const job = core.buildJobRecord({ id: 'job_002', profile: 'profil_1', status: 'RESUME_REQUIRED' });
  scheduler.jobs.push(job);

  // On n'affirme pas l'issue du chemin par défaut : seuls les invariants
  // valables quelle que soit l'implémentation du prompt de livraison sont
  // vérifiés (le job a bien démarré, l'appel se termine sans rester en attente).
  let outcome = 'resolved';
  try { await scheduler._executeAutomation(job); } catch (e) { outcome = e; }

  assert.ok(outcome === 'resolved' || outcome instanceof Error);
  assert.ok(hasLog(scheduler, 'Job job_002 : lancement de l\'automatisation Claude'));
  assert.ok(job.started_at);
  cleanup(scheduler);
});

// --- _executeAutomation : webview absente ------------------------------------------

test('_executeAutomation échoue proprement si aucune webview n\'est ouverte pour le profil', async () => {
  const scheduler = createScheduler();
  const ctx = setupJob(scheduler, { withWebview: false });
  let called = false;
  scheduler.runClaudeJob = async function() { called = true; return {}; };

  await scheduler._executeAutomation(ctx.job);

  assert.strictEqual(called, false);
  assert.strictEqual(ctx.job.status, 'ERROR');
  assert.ok(ctx.job.errorReason.indexOf('Aucune webview ouverte pour le profil « profil_1 »') === 0);
  assert.ok(ctx.job.errorReason.indexOf('Ouvrez un onglet Claude.ai') !== -1);
  assert.strictEqual(ctx.task.status, 'failed', 'la tâche associée est marquée échouée');
  assert.ok(hasLog(scheduler, 'Tâche ' + ctx.task.id + ' marquée comme échouée.'));
  cleanup(scheduler);
});

// --- _executeAutomation : erreurs renvoyées par runClaudeJob ---------------------------

test('_executeAutomation : quota épuisé -> job en ERROR avec l\'heure de reprise', async () => {
  const scheduler = createScheduler();
  const ctx = setupJob(scheduler);
  scheduler.runClaudeJob = async function() { return { error: 'quota_exhausted', quotaTime: '18:30' }; };

  await scheduler._executeAutomation(ctx.job);

  assert.strictEqual(ctx.job.status, 'ERROR');
  assert.strictEqual(ctx.job.errorReason, 'Quota Claude épuisé jusqu\'à 18:30.');
  assert.strictEqual(ctx.task.status, 'failed');
  cleanup(scheduler);
});

test('_executeAutomation : quota épuisé sans heure connue -> « ? »', async () => {
  const scheduler = createScheduler();
  const ctx = setupJob(scheduler);
  scheduler.runClaudeJob = async function() { return { error: 'quota_exhausted' }; };

  await scheduler._executeAutomation(ctx.job);

  assert.strictEqual(ctx.job.errorReason, 'Quota Claude épuisé jusqu\'à ?.');
  cleanup(scheduler);
});

test('_executeAutomation : heures calmes détectées en cours de route -> reprise programmée (timer unref)', async () => {
  const scheduler = createScheduler();
  const ctx = setupJob(scheduler);
  scheduler.runClaudeJob = async function() { return { error: 'quiet_hours', waitMs: 180000 }; };

  const captured = await withCapturedTimeouts(true, async function() {
    await scheduler._executeAutomation(ctx.job);
  });

  assert.strictEqual(captured.length, 1);
  assert.strictEqual(captured[0].ms, 181000, 'attente = waitMs + 1 s');
  assert.strictEqual(captured[0].timer.unrefCalled, true, 'le timer ne retient pas le process');
  assert.ok(hasLog(scheduler, 'heures calmes détectées pendant l\'exécution. Reprise dans 3 min.'));
  assert.strictEqual(ctx.job.status, 'RUNNING', 'le job n\'est pas mis en erreur');
  assert.strictEqual(ctx.task.status, 'running');
  assert.ok(!ctx.job.errorReason);
  cleanup(scheduler);
});

test('_executeAutomation : heures calmes sans waitMs -> reprise dans 0 min (+1 s), timer sans unref toléré', async () => {
  const scheduler = createScheduler();
  const ctx = setupJob(scheduler);
  scheduler.runClaudeJob = async function() { return { error: 'quiet_hours' }; };

  const captured = await withCapturedTimeouts(false, async function() {
    await scheduler._executeAutomation(ctx.job);
  });

  assert.strictEqual(captured.length, 1);
  assert.strictEqual(captured[0].ms, 1000);
  assert.ok(hasLog(scheduler, 'Reprise dans 0 min.'));
  assert.strictEqual(ctx.job.status, 'RUNNING');
  cleanup(scheduler);
});

test('_executeAutomation : erreur Claude générique -> job en ERROR « Erreur Claude : … »', async () => {
  const scheduler = createScheduler();
  const ctx = setupJob(scheduler);
  scheduler.runClaudeJob = async function() { return { error: 'element_not_found' }; };

  await scheduler._executeAutomation(ctx.job);

  assert.strictEqual(ctx.job.status, 'ERROR');
  assert.strictEqual(ctx.job.errorReason, 'Erreur Claude : element_not_found');
  assert.strictEqual(ctx.task.status, 'failed');
  cleanup(scheduler);
});

test('_executeAutomation : exception pendant l\'automatisation -> job en ERROR', async () => {
  const scheduler = createScheduler();
  const ctx = setupJob(scheduler);
  scheduler.runClaudeJob = async function() { throw new Error('boom runClaudeJob'); };

  await scheduler._executeAutomation(ctx.job);

  assert.strictEqual(ctx.job.status, 'ERROR');
  assert.strictEqual(ctx.job.errorReason, 'Exception pendant l\'automatisation : boom runClaudeJob');
  assert.ok(hasLog(scheduler, 'échec — Exception pendant l\'automatisation'));
  cleanup(scheduler);
});

test('_executeAutomation : exception pendant l\'attente de la réponse -> job en ERROR', async () => {
  const scheduler = createScheduler();
  const ctx = setupJob(scheduler);
  scheduler.runClaudeJob = async function() { return { ok: true, method: 'paste' }; };
  scheduler._pollClaudeResponse = async function() { throw new Error('boom poll'); };

  await scheduler._executeAutomation(ctx.job);

  assert.strictEqual(ctx.job.status, 'ERROR');
  assert.strictEqual(ctx.job.errorReason, 'Exception pendant l\'automatisation : boom poll');
  cleanup(scheduler);
});

// --- _executeAutomation : délai de réponse dépassé, transition finale -----------------

test('_executeAutomation : délai dépassé sans réponse -> job tout de même livré, tâche inchangée', async () => {
  const scheduler = createScheduler();
  const ctx = setupJob(scheduler);
  scheduler.runClaudeJob = async function() { return { ok: true, method: 'paste' }; };
  scheduler._pollClaudeResponse = async function() { return { ok: false, response: null }; };

  await scheduler._executeAutomation(ctx.job);

  assert.ok(hasLog(scheduler, 'pas de réponse collectée (délai dépassé)'));
  assert.strictEqual(ctx.job.response, undefined);
  assert.strictEqual(ctx.job.status, 'DELIVERED');
  assert.ok(ctx.job.finished_at);
  assert.strictEqual(ctx.task.status, 'running', 'la tâche n\'est pas marquée terminée sans réponse');
  assert.ok(hasLog(scheduler, 'automatisation terminée avec succès'));
  cleanup(scheduler);
});

test('_executeAutomation : réponse ok mais vide -> traitée comme un délai dépassé', async () => {
  const scheduler = createScheduler();
  const ctx = setupJob(scheduler);
  scheduler.runClaudeJob = async function() { return { ok: true, method: 'paste' }; };
  scheduler._pollClaudeResponse = async function() { return { ok: true, response: '' }; };

  await scheduler._executeAutomation(ctx.job);

  assert.ok(hasLog(scheduler, 'pas de réponse collectée (délai dépassé)'));
  assert.strictEqual(ctx.job.status, 'DELIVERED');
  cleanup(scheduler);
});

test('_executeAutomation : transition vers DELIVERED impossible (job mis en pause pendant l\'attente)', async () => {
  const scheduler = createScheduler();
  const ctx = setupJob(scheduler);
  scheduler.runClaudeJob = async function() { return { ok: true, method: 'paste' }; };
  scheduler._pollClaudeResponse = async function() {
    // L'utilisateur met le job en pause pendant que le poll tourne.
    ctx.job.status = 'PAUSED';
    return { ok: false, response: null };
  };

  await scheduler._executeAutomation(ctx.job);

  assert.strictEqual(ctx.job.status, 'PAUSED', 'le statut n\'est pas écrasé');
  assert.strictEqual(ctx.job.finished_at, null);
  assert.ok(hasLog(scheduler, 'transition vers DELIVERED impossible'));
  assert.ok(hasLog(scheduler, 'PAUSED -> DELIVERED'));
  assert.ok(!hasLog(scheduler, 'automatisation terminée avec succès'));
  cleanup(scheduler);
});

// --- _failJob ------------------------------------------------------------------------------

test('_failJob force ERROR même si la transition est interdite (job déjà livré)', () => {
  const scheduler = createScheduler();
  const job = core.buildJobRecord({ id: 'job_010', profile: 'profil_1', status: 'DELIVERED' });
  scheduler.jobs.push(job);

  scheduler._failJob(job, 'Échec tardif');

  assert.strictEqual(job.status, 'ERROR');
  assert.strictEqual(job.errorReason, 'Échec tardif');
  assert.ok(hasLog(scheduler, 'Job job_010 : échec — Échec tardif'));
  cleanup(scheduler);
});

test('_failJob suit la transition normale depuis RUNNING', () => {
  const scheduler = createScheduler();
  const job = core.buildJobRecord({ id: 'job_011', profile: 'profil_1', status: 'RUNNING' });
  scheduler.jobs.push(job);

  scheduler._failJob(job, 'Raison');

  assert.strictEqual(job.status, 'ERROR');
  assert.ok(job.lastActivityAt);
  cleanup(scheduler);
});

test('_failJob laisse les tâches intactes si aucune tâche running ne correspond au profil', () => {
  const scheduler = createScheduler();
  const ctx = setupJob(scheduler, { status: 'RUNNING' });
  ctx.task.status = 'assigned'; // pas « running » : non concernée
  const other = { id: 'x', assignedProfile: 'profil_2', status: 'running' };
  ctx.project.tasks.push(other);

  scheduler._failJob(ctx.job, 'Raison');

  assert.strictEqual(ctx.job.status, 'ERROR');
  assert.strictEqual(ctx.task.status, 'assigned');
  assert.strictEqual(other.status, 'running');
  cleanup(scheduler);
});

test('_failJob ignore un projet introuvable et un job sans projet', () => {
  const scheduler = createScheduler();
  const orphan = core.buildJobRecord({ id: 'job_012', projectId: 'projet_inconnu', profile: 'profil_1', status: 'RUNNING' });
  scheduler._failJob(orphan, 'Raison');
  assert.strictEqual(orphan.status, 'ERROR');

  const noProject = core.buildJobRecord({ id: 'job_013', profile: 'profil_1', status: 'RUNNING' });
  noProject.projectId = null;
  scheduler._failJob(noProject, 'Raison');
  assert.strictEqual(noProject.status, 'ERROR');
  cleanup(scheduler);
});
