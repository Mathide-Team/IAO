'use strict';

// test/scheduler-branches-coverage.test.js — issue #55 : dernières branches et
// fonctions non couvertes de scheduler/index.js (mesure Node 22 sur dev
// @ dbf4245 : 95,24 % branches, 98,31 % fonctions).
//
// - échecs d'écriture (_persistJobs, _persistConfig, _logActivity,
//   _persistProjects) et rotation du journal au-delà de 500 entrées ;
// - replis de setConfig sur des valeurs non numériques ;
// - _executeAutomation : profil absent (« ? »), tâche « running » sans prompt
//   ni ZIP, et les deux reprises programmées après les heures calmes
//   (callbacks de setTimeout, horloge simulée par mock.timers) ;
// - _pollClaudeResponse quand collectClaudeResponse lève ;
// - gardes d'executeTask, _getLastAutomationTime mémorisé, createProject
//   sans nom, resolveProfileFromSession (doublon, partition invalide).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Scheduler } = require('../scheduler/index');
const core = require('../scheduler/core');

function createScheduler(t, session) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iao-branches-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  t.mock.method(console, 'log', () => {});
  const scheduler = new Scheduler({ getPath: () => tmpDir }, session || {});
  scheduler.quietHoursCheck = () => false;
  scheduler.quietHoursRemainingMs = () => 0;
  return { scheduler, tmpDir };
}

function addJob(scheduler, opts) {
  scheduler.jobSeq += 1;
  const job = core.buildJobRecord(Object.assign({
    id: core.nextJobId(scheduler.jobSeq),
    profile: 'profil_1',
    service: 'claude',
    status: 'RESUME_REQUIRED'
  }, opts || {}));
  scheduler.jobs.push(job);
  return job;
}

// Chemin dont le dossier parent n'existe pas : toute écriture échoue (ENOENT).
function unwritable(tmpDir, name) {
  return path.join(tmpDir, 'absent', 'sous-dossier', name);
}

// --- Échecs d'écriture et rotation du journal --------------------------------

test('_persistJobs : un échec d\'écriture est journalisé sans lever', (t) => {
  const { scheduler, tmpDir } = createScheduler(t);
  const errors = t.mock.method(console, 'error', () => {});
  scheduler.jobsPath = unwritable(tmpDir, 'jobs.json');
  assert.doesNotThrow(() => scheduler._persistJobs());
  assert.match(errors.mock.calls[0].arguments[0], /échec écriture jobs/);
});

test('_persistConfig : un échec d\'écriture est journalisé sans lever', (t) => {
  const { scheduler, tmpDir } = createScheduler(t);
  const errors = t.mock.method(console, 'error', () => {});
  scheduler.configPath = unwritable(tmpDir, 'config.json');
  assert.doesNotThrow(() => scheduler._persistConfig());
  assert.match(errors.mock.calls[0].arguments[0], /échec écriture config/);
});

test('_persistProjects : un échec d\'écriture est journalisé sans lever', (t) => {
  const { scheduler, tmpDir } = createScheduler(t);
  const errors = t.mock.method(console, 'error', () => {});
  scheduler.projectsPath = unwritable(tmpDir, 'projects.json');
  assert.doesNotThrow(() => scheduler._persistProjects());
  assert.match(errors.mock.calls[0].arguments[0], /échec écriture projets/);
});

test('_logActivity : un échec d\'écriture est journalisé, l\'entrée reste en mémoire', (t) => {
  const { scheduler, tmpDir } = createScheduler(t);
  const errors = t.mock.method(console, 'error', () => {});
  scheduler.logPath = unwritable(tmpDir, 'activity.json');
  scheduler._logActivity('message test');
  assert.equal(scheduler.log.at(-1).message, 'message test');
  assert.match(errors.mock.calls[0].arguments[0], /échec écriture journal/);
});

test('_logActivity : le journal est tronqué aux 500 dernières entrées', (t) => {
  const { scheduler } = createScheduler(t);
  scheduler.log = Array.from({ length: 500 }, (_, i) => ({ ts: '', message: 'ancien ' + i }));
  scheduler._logActivity('nouveau');
  assert.equal(scheduler.log.length, 500);
  assert.equal(scheduler.log[0].message, 'ancien 1');
  assert.equal(scheduler.log.at(-1).message, 'nouveau');
});

// --- setConfig : replis ----------------------------------------------------

test('setConfig : valeurs non numériques -> valeurs courantes conservées', (t) => {
  const { scheduler } = createScheduler(t);
  scheduler.config.maxConcurrentJobs = 3;
  scheduler.config.profileAgeThresholdHours = 7;
  const cfg = scheduler.setConfig({ maxConcurrentJobs: 'abc', profileAgeThresholdHours: 'xyz' });
  assert.equal(cfg.maxConcurrentJobs, 3);
  assert.equal(cfg.profileAgeThresholdHours, 7);
});

// --- _executeAutomation ------------------------------------------------------

test('_executeAutomation : profil absent -> « ? » dans le journal, puis échec sans webview', async (t) => {
  const { scheduler } = createScheduler(t);
  const job = addJob(scheduler, { profile: undefined });
  await scheduler._executeAutomation(job);
  assert.ok(scheduler.log.some((e) => e.message.includes('(profil « ? »)')));
  assert.equal(job.status, 'ERROR');
});

test('_executeAutomation : tâche « running » sans prompt ni ZIP -> prompt de livraison par défaut', async (t) => {
  const { scheduler } = createScheduler(t);
  const job = addJob(scheduler, { projectId: 'proj_001', sourceZip: '/tmp/job.zip' });
  const task = { id: 'task_003', assignedProfile: 'profil_1', status: 'running' };
  scheduler.projects.push({
    id: 'proj_001',
    name: 'P',
    tasks: [
      { id: 'task_001', assignedProfile: 'autre', status: 'assigned', prompt: 'non' },
      { id: 'task_002', assignedProfile: 'profil_1', status: 'done', prompt: 'non' },
      task
    ]
  });
  scheduler._openWebviews.set('profil_1', {});
  let received = null;
  scheduler.runClaudeJob = async (profile, prompt, zip) => {
    received = { profile, prompt, zip };
    return { error: 'selecteur' };
  };
  await scheduler._executeAutomation(job);
  assert.match(received.prompt, /^Continue les features à faire\.[\s\S]*Livraison du zip horodaté \d{8}-\d{6} sans passer à la suite\.$/);
  assert.equal(received.zip, '/tmp/job.zip', 'la tâche sans ZIP garde celui du job');
  assert.equal(job.errorReason, 'Erreur Claude : selecteur');
});

test('_executeAutomation : heures calmes au lancement -> reprise programmée après la pause', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { scheduler } = createScheduler(t);
  const job = addJob(scheduler);
  scheduler.quietHoursCheck = () => true;
  scheduler.quietHoursRemainingMs = () => 60000;

  await scheduler._executeAutomation(job);
  assert.equal(job.status, 'RESUME_REQUIRED', 'aucune transition pendant la pause');

  const relances = [];
  scheduler._executeAutomation = async (j) => { relances.push(j.id); };
  t.mock.timers.tick(60000);
  assert.deepEqual(relances, []);
  t.mock.timers.tick(1000);
  assert.deepEqual(relances, [job.id]);
});

test('_executeAutomation : heures calmes pendant l\'exécution -> reprise programmée (waitMs absent = 0)', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { scheduler } = createScheduler(t);
  const job = addJob(scheduler);
  scheduler._openWebviews.set('profil_1', {});
  scheduler.runClaudeJob = async () => ({ error: 'quiet_hours' });

  await scheduler._executeAutomation(job);
  assert.ok(scheduler.log.some((e) => e.message.includes('Reprise dans 0 min')));

  const relances = [];
  scheduler._executeAutomation = async (j) => { relances.push(j.id); };
  t.mock.timers.tick(1000);
  assert.deepEqual(relances, [job.id]);
});

// --- _pollClaudeResponse -------------------------------------------------------

test('_pollClaudeResponse : une collecte qui lève est ignorée, le poll continue', async (t) => {
  const { scheduler } = createScheduler(t);
  let appels = 0;
  scheduler.collectClaudeResponse = async () => {
    appels += 1;
    if (appels === 1) throw new Error('page en cours de chargement');
    return { ok: true, response: 'réponse' };
  };
  const res = await scheduler._pollClaudeResponse('profil_1', 1000, 1);
  assert.deepEqual(res, { ok: true, response: 'réponse' });
  assert.equal(appels, 2);
});

// --- executeTask : gardes -------------------------------------------------------

test('executeTask : projet, tâche ou profil manquants -> erreurs explicites', async (t) => {
  const { scheduler } = createScheduler(t);
  scheduler.projects.push({ id: 'proj_001', name: 'P', tasks: [{ id: 'task_001', assignedProfile: null }] });
  await assert.rejects(scheduler.executeTask('proj_999', 'task_001'), /Projet introuvable : proj_999/);
  await assert.rejects(scheduler.executeTask('proj_001', 'task_999'), /Tâche introuvable : task_999/);
  await assert.rejects(scheduler.executeTask('proj_001', 'task_001'), /Tâche non assignée à un profil/);
});

// --- Divers -------------------------------------------------------------------

test('_getLastAutomationTime : renvoie l\'horodatage mémorisé en priorité', (t) => {
  const { scheduler } = createScheduler(t);
  addJob(scheduler, { started_at: '2026-01-01T00:00:00.000Z' });
  scheduler._lastAutomationAt = 1234;
  assert.equal(scheduler._getLastAutomationTime(), 1234);
});

test('createProject : sans nom -> « Projet N »', (t) => {
  const { scheduler } = createScheduler(t);
  const project = scheduler.createProject('', null);
  assert.equal(project.name, 'Projet 1');
  assert.deepEqual(project.allowedAccountIds, []);
});

test('resolveProfileFromSession : doublons ignorés, partition invalide sautée', (t) => {
  const cible = { id: 'session-cible' };
  const vus = [];
  const session = {
    fromPartition(partition) {
      vus.push(partition);
      if (partition === 'persist:casse') throw new Error('partition invalide');
      return partition === 'persist:profil_2' ? cible : {};
    }
  };
  const { scheduler } = createScheduler(t, session);
  scheduler.watchedPartitions = new Set(['profil_1', 'casse']);
  scheduler.accountsSnapshot = [{ profile: 'profil_1' }, { profile: 'profil_2' }];
  assert.equal(scheduler.resolveProfileFromSession(cible), 'profil_2');
  assert.deepEqual(vus, ['persist:profil_1', 'persist:casse', 'persist:profil_2']);
});

test('_executeAutomation : le prompt et le ZIP de la tâche remplacent ceux du job', async (t) => {
  const { scheduler } = createScheduler(t);
  const job = addJob(scheduler, { projectId: 'proj_001', sourceZip: '/tmp/job.zip' });
  const task = { id: 'task_001', assignedProfile: 'profil_1', status: 'assigned', prompt: 'Fais X', sourceZip: '/tmp/tache.zip' };
  scheduler.projects.push({ id: 'proj_001', name: 'P', tasks: [task] });
  scheduler._openWebviews.set('profil_1', {});
  let received = null;
  scheduler.runClaudeJob = async (profile, prompt, zip) => { received = { prompt, zip }; return { error: 'selecteur' }; };
  await scheduler._executeAutomation(job);
  assert.deepEqual(received, { prompt: 'Fais X', zip: '/tmp/tache.zip' });
  assert.equal(task.status, 'failed');
});
