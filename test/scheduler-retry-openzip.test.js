'use strict';

// test/scheduler-retry-openzip.test.js — Couverture de Scheduler#retryJob et
// Scheduler#openZip (issue #88). `app` et `shell` Electron sont simulés, le
// userData est un dossier temporaire : aucun accès réseau, aucune fenêtre.

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const { Scheduler } = require('../scheduler/index');

// --- Helpers ---------------------------------------------------------------

function createScheduler() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iao-retry-'));
  const app = { getPath: function() { return tmpDir; } };
  const scheduler = new Scheduler(app, {});
  return { scheduler, tmpDir };
}

function cleanup(tmpDir) {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
}

// Remplace le module 'electron' (dans Node nu, il ne renvoie que le chemin du
// binaire) par un faux `shell`. Retourne une fonction de restauration.
function mockElectronShell(shell) {
  const resolved = require.resolve('electron');
  const previous = require.cache[resolved];
  require.cache[resolved] = {
    id: resolved, filename: resolved, loaded: true, exports: { shell: shell }
  };
  return function restore() {
    if (previous) require.cache[resolved] = previous;
    else delete require.cache[resolved];
  };
}

// --- retryJob --------------------------------------------------------------

test('retryJob : un job en ERROR repasse en RESUME_REQUIRED, tentative incrémentée et persistée', () => {
  const { scheduler, tmpDir } = createScheduler();
  try {
    scheduler.jobs.push({ id: 'job-1', status: 'ERROR', attempts: 2 });
    const before = Date.now();
    const job = scheduler.retryJob('job-1');

    assert.strictEqual(job, scheduler.jobs[0]);
    assert.strictEqual(job.status, 'RESUME_REQUIRED');
    assert.strictEqual(job.attempts, 3);
    assert.ok(new Date(job.lastActivityAt).getTime() >= before);

    const persisted = JSON.parse(fs.readFileSync(scheduler.jobsPath, 'utf-8'));
    assert.strictEqual(persisted[0].status, 'RESUME_REQUIRED');
    assert.strictEqual(persisted[0].attempts, 3);
    assert.ok(fs.existsSync(scheduler.csvPath));
    assert.ok(scheduler.log.some(function(e) {
      return JSON.stringify(e).indexOf('nouvelle tentative (#3)') !== -1;
    }));
  } finally { cleanup(tmpDir); }
});

test('retryJob : sans compteur attempts, la première tentative vaut 1', () => {
  const { scheduler, tmpDir } = createScheduler();
  try {
    scheduler.jobs.push({ id: 'job-2', status: 'ERROR' });
    assert.strictEqual(scheduler.retryJob('job-2').attempts, 1);
  } finally { cleanup(tmpDir); }
});

test('retryJob : un job non échoué (DELIVERED) lève une erreur de transition', () => {
  const { scheduler, tmpDir } = createScheduler();
  try {
    scheduler.jobs.push({ id: 'job-3', status: 'DELIVERED', attempts: 0 });
    assert.throws(function() { scheduler.retryJob('job-3'); },
      /Transition d'état de job invalide : DELIVERED -> RESUME_REQUIRED/);
    assert.strictEqual(scheduler.jobs[0].status, 'DELIVERED');
  } finally { cleanup(tmpDir); }
});

test('retryJob : job introuvable', () => {
  const { scheduler, tmpDir } = createScheduler();
  try {
    assert.throws(function() { scheduler.retryJob('absent'); }, /Job introuvable : absent/);
  } finally { cleanup(tmpDir); }
});

// --- openZip ---------------------------------------------------------------

test('openZip : ZIP présent (outputZip) → showItemInFolder appelé, retourne true', () => {
  const { scheduler, tmpDir } = createScheduler();
  const calls = [];
  const restore = mockElectronShell({ showItemInFolder: function(p) { calls.push(p); } });
  try {
    scheduler.jobs.push({ id: 'z1', status: 'COMPLETED', outputZip: '/tmp/sortie.zip', file_path: '/tmp/autre.zip' });
    assert.strictEqual(scheduler.openZip('z1'), true);
    assert.deepStrictEqual(calls, ['/tmp/sortie.zip']);
  } finally { restore(); cleanup(tmpDir); }
});

test('openZip : sans outputZip, retombe sur file_path', () => {
  const { scheduler, tmpDir } = createScheduler();
  const calls = [];
  const restore = mockElectronShell({ showItemInFolder: function(p) { calls.push(p); } });
  try {
    scheduler.jobs.push({ id: 'z2', status: 'COMPLETED', file_path: '/tmp/telecharge.zip' });
    assert.strictEqual(scheduler.openZip('z2'), true);
    assert.deepStrictEqual(calls, ['/tmp/telecharge.zip']);
  } finally { restore(); cleanup(tmpDir); }
});

test('openZip : ZIP absent → erreur, shell jamais appelé', () => {
  const { scheduler, tmpDir } = createScheduler();
  const calls = [];
  const restore = mockElectronShell({ showItemInFolder: function(p) { calls.push(p); } });
  try {
    scheduler.jobs.push({ id: 'z3', status: 'DOWNLOADING' });
    assert.throws(function() { scheduler.openZip('z3'); }, /Aucun fichier associé à ce job/);
    assert.strictEqual(calls.length, 0);
  } finally { restore(); cleanup(tmpDir); }
});

test('openZip : job introuvable', () => {
  const { scheduler, tmpDir } = createScheduler();
  const restore = mockElectronShell({ showItemInFolder: function() {} });
  try {
    assert.throws(function() { scheduler.openZip('absent'); }, /Job introuvable : absent/);
  } finally { restore(); cleanup(tmpDir); }
});
