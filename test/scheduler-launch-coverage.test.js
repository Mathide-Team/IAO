'use strict';

// test/scheduler-launch-coverage.test.js — Couverture de pickDownloadsDir,
// pickDeliveryDir (issue #83), tryAutoLaunch et launchJob (issue #86).
// Teste les VRAIES implémentations (pas des mocks) avec electron.dialog
// simulé et _executeAutomation stubbé pour éviter le flux CDP complet.

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const { Scheduler } = require('../scheduler/index');
const core = require('../scheduler/core');

// --- Helpers ---------------------------------------------------------------

function createMockApp() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iao-launch-'));
  return {
    getPath: function (name) {
      if (name === 'userData') return tmpDir;
      return tmpDir;
    },
    _tmpDir: tmpDir
  };
}

function cleanup(scheduler) {
  try {
    if (scheduler._app && scheduler._app._tmpDir) {
      fs.rmSync(scheduler._app._tmpDir, { recursive: true, force: true });
    }
  } catch (_) {}
}

// Crée un scheduler avec quiet hours désactivé et _executeAutomation stubbé
function createTestScheduler() {
  const app = createMockApp();
  const scheduler = new Scheduler(app, {});
  scheduler.quietHoursCheck = function () { return false; };
  scheduler.quietHoursRemainingMs = function () { return 0; };
  // Stub _executeAutomation pour éviter le flux CDP complet
  scheduler._executeAutomationCalls = [];
  scheduler._executeAutomation = async function (job) {
    scheduler._executeAutomationCalls.push(job.id);
  };
  return scheduler;
}

// Ajoute un job RESUME_REQUIRED au scheduler
function addResumeJob(scheduler, opts) {
  scheduler.jobSeq += 1;
  var job = core.buildJobRecord(Object.assign({
    id: core.nextJobId(scheduler.jobSeq),
    profile: 'profil_1',
    service: 'claude',
    status: 'RESUME_REQUIRED'
  }, opts || {}));
  scheduler.jobs.push(job);
  return job;
}

// Mock electron.dialog dans le cache de require
function mockDialog(result) {
  var electronPath = require.resolve('electron');
  var orig = require.cache[electronPath];
  require.cache[electronPath] = {
    id: electronPath,
    filename: electronPath,
    loaded: true,
    exports: {
      dialog: {
        showOpenDialog: async function (win, opts) {
          return result;
        }
      }
    }
  };
  return function restore() {
    if (orig) require.cache[electronPath] = orig;
    else delete require.cache[electronPath];
  };
}

// --- Issue #83 : pickDownloadsDir / pickDeliveryDir ------------------------

test('pickDownloadsDir retourne la config inchangée si dialog annulé', async () => {
  const scheduler = createTestScheduler();
  const restore = mockDialog({ canceled: true, filePaths: [] });
  try {
    const config = await scheduler.pickDownloadsDir(null);
    assert.strictEqual(config.downloadsDir, null);
  } finally {
    restore();
    cleanup(scheduler);
  }
});

test('pickDownloadsDir met à jour downloadsDir si dossier choisi', async () => {
  const scheduler = createTestScheduler();
  const restore = mockDialog({ canceled: false, filePaths: ['/tmp/downloads'] });
  try {
    const config = await scheduler.pickDownloadsDir(null);
    assert.strictEqual(config.downloadsDir, '/tmp/downloads');
  } finally {
    restore();
    cleanup(scheduler);
  }
});

test('pickDeliveryDir retourne la config inchangée si dialog annulé', async () => {
  const scheduler = createTestScheduler();
  const restore = mockDialog({ canceled: true, filePaths: [] });
  try {
    const config = await scheduler.pickDeliveryDir(null);
    assert.strictEqual(config.deliveryDir, null);
  } finally {
    restore();
    cleanup(scheduler);
  }
});

test('pickDeliveryDir met à jour deliveryDir si dossier choisi', async () => {
  const scheduler = createTestScheduler();
  const restore = mockDialog({ canceled: false, filePaths: ['/tmp/delivery'] });
  try {
    const config = await scheduler.pickDeliveryDir(null);
    assert.strictEqual(config.deliveryDir, '/tmp/delivery');
  } finally {
    restore();
    cleanup(scheduler);
  }
});

test('pickDownloadsDir ne change rien si filePaths vide sans canceled', async () => {
  const scheduler = createTestScheduler();
  const restore = mockDialog({ canceled: false, filePaths: [] });
  try {
    const config = await scheduler.pickDownloadsDir(null);
    assert.strictEqual(config.downloadsDir, null);
  } finally {
    restore();
    cleanup(scheduler);
  }
});

// --- Issue #86 : tryAutoLaunch ----------------------------------------------

test('tryAutoLaunch renvoie null si aucun job RESUME_REQUIRED', () => {
  const scheduler = createTestScheduler();
  scheduler.config.enabled = true;
  const result = scheduler.tryAutoLaunch();
  assert.strictEqual(result, null);
  assert.strictEqual(scheduler._executeAutomationCalls.length, 0);
  cleanup(scheduler);
});

test('tryAutoLaunch renvoie null si ordonnanceur désactivé', () => {
  const scheduler = createTestScheduler();
  scheduler.config.enabled = false;
  addResumeJob(scheduler);
  const result = scheduler.tryAutoLaunch();
  assert.strictEqual(result, null);
  assert.strictEqual(scheduler._executeAutomationCalls.length, 0);
  cleanup(scheduler);
});

test('tryAutoLaunch renvoie null si limite concurrent atteinte', () => {
  const scheduler = createTestScheduler();
  scheduler.config.enabled = true;
  scheduler.config.maxConcurrentJobs = 1;
  // Un job déjà en RUNNING + un en RESUME_REQUIRED
  addResumeJob(scheduler);
  scheduler.jobs[0].status = 'RUNNING';
  addResumeJob(scheduler);
  const result = scheduler.tryAutoLaunch();
  assert.strictEqual(result, null);
  assert.strictEqual(scheduler._executeAutomationCalls.length, 0);
  cleanup(scheduler);
});

test('tryAutoLaunch lance le job éligible et appelle _executeAutomation', async () => {
  const scheduler = createTestScheduler();
  scheduler.config.enabled = true;
  scheduler.config.maxConcurrentJobs = 2;
  scheduler.config.minDelayBetweenAutomationsMinutes = 0;
  const job = addResumeJob(scheduler);
  const result = scheduler.tryAutoLaunch();
  assert.strictEqual(result, job);
  // _executeAutomation est async, on attend un tick
  await new Promise(function (r) { setTimeout(r, 10); });
  assert.strictEqual(scheduler._executeAutomationCalls.length, 1);
  assert.strictEqual(scheduler._executeAutomationCalls[0], job.id);
  cleanup(scheduler);
});

// --- Issue #86 : launchJob -------------------------------------------------

test('launchJob lance une erreur si job introuvable', () => {
  const scheduler = createTestScheduler();
  scheduler.config.enabled = true;
  assert.throws(function () { scheduler.launchJob('job_inexistant'); }, /introuvable/);
  cleanup(scheduler);
});

test('launchJob refuse si job non RESUME_REQUIRED', () => {
  const scheduler = createTestScheduler();
  scheduler.config.enabled = true;
  const job = addResumeJob(scheduler);
  job.status = 'COMPLETED';
  const result = scheduler.launchJob(job.id);
  assert.strictEqual(result.ok, false);
  assert.match(result.reason, /attente de reprise/);
  cleanup(scheduler);
});

test('launchJob refuse si ordonnanceur désactivé', () => {
  const scheduler = createTestScheduler();
  scheduler.config.enabled = false;
  const job = addResumeJob(scheduler);
  const result = scheduler.launchJob(job.id);
  assert.strictEqual(result.ok, false);
  assert.match(result.reason, /désactivé/);
  cleanup(scheduler);
});

test('launchJob refuse si limite concurrent atteinte', () => {
  const scheduler = createTestScheduler();
  scheduler.config.enabled = true;
  scheduler.config.maxConcurrentJobs = 1;
  const job = addResumeJob(scheduler);
  scheduler.jobs[0].status = 'RUNNING';
  addResumeJob(scheduler);
  const result = scheduler.launchJob(scheduler.jobs[1].id);
  assert.strictEqual(result.ok, false);
  assert.match(result.reason, /concurrent/);
  cleanup(scheduler);
});

test('launchJob lance l\'automatisation si job éligible', async () => {
  const scheduler = createTestScheduler();
  scheduler.config.enabled = true;
  scheduler.config.maxConcurrentJobs = 2;
  scheduler.config.minDelayBetweenAutomationsMinutes = 0;
  const job = addResumeJob(scheduler);
  const result = scheduler.launchJob(job.id);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.job, job);
  await new Promise(function (r) { setTimeout(r, 10); });
  assert.strictEqual(scheduler._executeAutomationCalls.length, 1);
  cleanup(scheduler);
});

// --- Issue #86 : executeTask avec launchJob (ligne 615-616) -----------------

test('executeTask crée un job et lance l\'automatisation (lignes 615-616)', async () => {
  const scheduler = createTestScheduler();
  scheduler.config.enabled = true;
  scheduler.config.maxConcurrentJobs = 2;
  scheduler.config.minDelayBetweenAutomationsMinutes = 0;

  // Créer un projet avec une tâche assignée
  const project = scheduler.createProject('Projet test', []);
  const task = {
    id: 'task_1',
    projectId: project.id,
    prompt: 'Fais ceci',
    assignedProfile: 'profil_1',
    status: 'assigned',
    sourceZip: null
  };
  project.tasks = [task];

  // Simuler une webview ouverte pour le profil
  scheduler._openWebviews.set('profil_1', { executeJavaScript: async function () { return '{}'; } });

  const result = await scheduler.executeTask(project.id, task.id);
  assert.strictEqual(result.ok, true);
  assert.ok(result.job);
  await new Promise(function (r) { setTimeout(r, 10); });
  assert.strictEqual(scheduler._executeAutomationCalls.length, 1);
  cleanup(scheduler);
});

test('executeTask échoue si pas de webview ouverte', async () => {
  const scheduler = createTestScheduler();
  const project = scheduler.createProject('Projet test', []);
  const task = {
    id: 'task_1',
    projectId: project.id,
    assignedProfile: 'profil_1',
    status: 'assigned'
  };
  project.tasks = [task];

  const result = await scheduler.executeTask(project.id, task.id);
  assert.strictEqual(result.ok, false);
  assert.match(result.error, /webview/);
  cleanup(scheduler);
});

// --- Lignes 388-390 : tryAutoLaunch avec eligibility échouée -----------------

test('tryAutoLaunch journalise si eligibility échoue (lignes 388-390)', () => {
  const scheduler = createTestScheduler();
  scheduler.config.enabled = true;
  scheduler.config.maxConcurrentJobs = 2;
  scheduler.config.minDelayBetweenAutomationsMinutes = 0;

  // Ajouter un job, mais stubber selectNextJobToLaunch pour retourner
  // un job non RESUME_REQUIRED — checkJobLaunchEligibility échouera.
  const job = addResumeJob(scheduler);
  job.status = 'COMPLETED';

  const origSelect = core.selectNextJobToLaunch;
  core.selectNextJobToLaunch = function () { return job; };
  try {
    const result = scheduler.tryAutoLaunch();
    assert.strictEqual(result, null);
  } finally {
    core.selectNextJobToLaunch = origSelect;
  }
  cleanup(scheduler);
});

// --- Lignes 615-616 : executeTask avec launchJob échoué ---------------------

test('executeTask retourne launchResult si launchJob échoue (lignes 615-616)', async () => {
  const scheduler = createTestScheduler();
  // Scheduler désactivé -> launchJob va échouer
  scheduler.config.enabled = false;

  const project = scheduler.createProject('Projet test', []);
  const task = {
    id: 'task_1',
    projectId: project.id,
    assignedProfile: 'profil_1',
    status: 'assigned'
  };
  project.tasks = [task];
  scheduler._openWebviews.set('profil_1', { executeJavaScript: async function () { return '{}'; } });

  const result = await scheduler.executeTask(project.id, task.id);
  assert.strictEqual(result.ok, false);
  cleanup(scheduler);
});
