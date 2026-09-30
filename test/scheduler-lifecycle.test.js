'use strict';

// test/scheduler-lifecycle.test.js — Cycle de vie manuel des jobs du
// Scheduler (issue #85) : continueProject, markDelivered, pauseJob et
// resumeJob. Cas couverts : job inconnu, statut invalide, cas nominal.
// `app` Electron simulé, userData temporaire, aucun accès réseau.

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const { Scheduler } = require('../scheduler/index');
const core = require('../scheduler/core');

// --- Aides -----------------------------------------------------------------

function createScheduler() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iao-lifecycle-'));
  const app = { getPath: () => tmpDir };
  const scheduler = new Scheduler(app, {});
  scheduler._tmpDir = tmpDir;
  // Le vrai tryAutoLaunch lance l'automatisation Claude (hors périmètre) :
  // on le remplace par un espion.
  scheduler.autoLaunchCalls = 0;
  scheduler.tryAutoLaunch = function () { scheduler.autoLaunchCalls += 1; return null; };
  return scheduler;
}

function cleanup(scheduler) {
  fs.rmSync(scheduler._tmpDir, { recursive: true, force: true });
}

function addJob(scheduler, status, extra) {
  scheduler.jobSeq += 1;
  const job = core.buildJobRecord(Object.assign({
    id: core.nextJobId(scheduler.jobSeq),
    profile: 'profil_0',
    service: 'claude',
    status
  }, extra || {}));
  scheduler.jobs.push(job);
  return job;
}

function account(profile, lastAutomationAt) {
  return { profile, automation: { enabled: true, lastAutomationAt } };
}

function readJSON(file) {
  return JSON.parse(fs.readFileSync(file, 'utf-8'));
}

function lastLog(scheduler) {
  return scheduler.log[scheduler.log.length - 1].message;
}

// --- _findJob ---------------------------------------------------------------

test('_findJob renvoie le job correspondant', () => {
  const s = createScheduler();
  try {
    const job = addJob(s, 'COMPLETED');
    assert.strictEqual(s._findJob(job.id), job);
  } finally { cleanup(s); }
});

// --- Job inconnu : les quatre méthodes lèvent la même erreur ------------------

for (const method of ['continueProject', 'markDelivered', 'pauseJob', 'resumeJob']) {
  test(method + ' lève une erreur pour un job inconnu', () => {
    const s = createScheduler();
    try {
      assert.throws(() => s[method]('job_999'), /Job introuvable : job_999/);
      assert.strictEqual(s.autoLaunchCalls, 0);
    } finally { cleanup(s); }
  });
}

// --- continueProject --------------------------------------------------------

test('continueProject : profil disponible -> RESUME_REQUIRED, profil attribué et persisté', () => {
  const s = createScheduler();
  try {
    s.accountsSnapshot = [account('profil_1', 0)];
    const job = addJob(s, 'COMPLETED');
    const before = Date.now();

    const result = s.continueProject(job.id);

    assert.strictEqual(result, job);
    assert.strictEqual(job.status, 'RESUME_REQUIRED');
    assert.strictEqual(job.profile, 'profil_1');
    assert.ok(s.accountsSnapshot[0].automation.lastAutomationAt >= before);
    assert.ok(job.lastActivityAt);
    assert.match(lastLog(s), /reprise programmée sur le profil « profil_1 »/);
    // Persistance : jobs.json ET instantané des comptes.
    assert.strictEqual(readJSON(s.jobsPath)[0].status, 'RESUME_REQUIRED');
    assert.ok(readJSON(s.accountsPath)[0].automation.lastAutomationAt >= before);
  } finally { cleanup(s); }
});

test('continueProject : aucun profil disponible -> WAITING_FOR_PROFILE', () => {
  const s = createScheduler();
  try {
    s.accountsSnapshot = [];
    const job = addJob(s, 'COMPLETED');

    s.continueProject(job.id);

    assert.strictEqual(job.status, 'WAITING_FOR_PROFILE');
    assert.strictEqual(job.profile, 'profil_0');
    assert.match(lastLog(s), /aucun profil disponible depuis plus de 5 h, mis en attente/);
    assert.strictEqual(readJSON(s.jobsPath)[0].status, 'WAITING_FOR_PROFILE');
    assert.strictEqual(fs.existsSync(s.accountsPath), false);
  } finally { cleanup(s); }
});

test('continueProject : profil trop récent -> WAITING_FOR_PROFILE', () => {
  const s = createScheduler();
  try {
    s.accountsSnapshot = [account('profil_1', Date.now())];
    const job = addJob(s, 'COMPLETED');

    s.continueProject(job.id);

    assert.strictEqual(job.status, 'WAITING_FOR_PROFILE');
  } finally { cleanup(s); }
});

test('continueProject : statut invalide -> erreur, job inchangé', () => {
  const s = createScheduler();
  try {
    s.accountsSnapshot = [account('profil_1', 0)];
    const job = addJob(s, 'RUNNING');

    assert.throws(() => s.continueProject(job.id), /Transition d'état de job invalide : RUNNING -> PROJECT_PENDING/);
    assert.strictEqual(job.status, 'RUNNING');
    assert.strictEqual(job.profile, 'profil_0');
    assert.strictEqual(s.accountsSnapshot[0].automation.lastAutomationAt, 0);
  } finally { cleanup(s); }
});

// --- markDelivered ----------------------------------------------------------

test('markDelivered : COMPLETED -> DELIVERED, finished_at renseigné', () => {
  const s = createScheduler();
  try {
    const job = addJob(s, 'COMPLETED');
    assert.strictEqual(job.finished_at, null);

    const result = s.markDelivered(job.id);

    assert.strictEqual(result, job);
    assert.strictEqual(job.status, 'DELIVERED');
    assert.ok(!Number.isNaN(Date.parse(job.finished_at)));
    assert.strictEqual(lastLog(s), 'Job ' + job.id + ' marqué comme livré.');
    assert.strictEqual(readJSON(s.jobsPath)[0].status, 'DELIVERED');
  } finally { cleanup(s); }
});

test('markDelivered : conserve un finished_at déjà présent', () => {
  const s = createScheduler();
  try {
    const job = addJob(s, 'RUNNING', { finished_at: '2026-01-02T03:04:05.000Z' });

    s.markDelivered(job.id);

    assert.strictEqual(job.status, 'DELIVERED');
    assert.strictEqual(job.finished_at, '2026-01-02T03:04:05.000Z');
  } finally { cleanup(s); }
});

test('markDelivered : statut invalide -> erreur, job inchangé', () => {
  const s = createScheduler();
  try {
    const job = addJob(s, 'PAUSED');

    assert.throws(() => s.markDelivered(job.id), /Transition d'état de job invalide : PAUSED -> DELIVERED/);
    assert.strictEqual(job.status, 'PAUSED');
    assert.strictEqual(job.finished_at, null);
  } finally { cleanup(s); }
});

// --- pauseJob ---------------------------------------------------------------

test('pauseJob : RUNNING -> PAUSED', () => {
  const s = createScheduler();
  try {
    const job = addJob(s, 'RUNNING', { lastActivityAt: '2020-01-01T00:00:00.000Z' });

    const result = s.pauseJob(job.id);

    assert.strictEqual(result, job);
    assert.strictEqual(job.status, 'PAUSED');
    assert.notStrictEqual(job.lastActivityAt, '2020-01-01T00:00:00.000Z');
    assert.strictEqual(lastLog(s), 'Job ' + job.id + ' mis en pause.');
    assert.strictEqual(readJSON(s.jobsPath)[0].status, 'PAUSED');
  } finally { cleanup(s); }
});

test('pauseJob : WAITING_FOR_PROFILE -> PAUSED', () => {
  const s = createScheduler();
  try {
    const job = addJob(s, 'WAITING_FOR_PROFILE');
    s.pauseJob(job.id);
    assert.strictEqual(job.status, 'PAUSED');
  } finally { cleanup(s); }
});

test('pauseJob : statut invalide -> erreur, job inchangé', () => {
  const s = createScheduler();
  try {
    const job = addJob(s, 'DELIVERED');

    assert.throws(() => s.pauseJob(job.id), /Transition d'état de job invalide : DELIVERED -> PAUSED/);
    assert.strictEqual(job.status, 'DELIVERED');
  } finally { cleanup(s); }
});

// --- resumeJob --------------------------------------------------------------

test('resumeJob : profil disponible -> RESUME_REQUIRED, profil attribué, lancement tenté', () => {
  const s = createScheduler();
  try {
    s.accountsSnapshot = [account('profil_1', 0)];
    const job = addJob(s, 'PAUSED');
    const before = Date.now();

    const result = s.resumeJob(job.id);

    assert.strictEqual(result, job);
    assert.strictEqual(job.status, 'RESUME_REQUIRED');
    assert.strictEqual(job.profile, 'profil_1');
    assert.ok(s.accountsSnapshot[0].automation.lastAutomationAt >= before);
    assert.ok(readJSON(s.accountsPath)[0].automation.lastAutomationAt >= before);
    assert.strictEqual(readJSON(s.jobsPath)[0].status, 'RESUME_REQUIRED');
    assert.strictEqual(lastLog(s), 'Job ' + job.id + ' : reprise demandée.');
    assert.strictEqual(s.autoLaunchCalls, 1);
  } finally { cleanup(s); }
});

test('resumeJob : aucun profil disponible -> WAITING_FOR_PROFILE, lancement tenté', () => {
  const s = createScheduler();
  try {
    s.accountsSnapshot = [];
    const job = addJob(s, 'PAUSED');

    s.resumeJob(job.id);

    assert.strictEqual(job.status, 'WAITING_FOR_PROFILE');
    assert.strictEqual(job.profile, 'profil_0');
    assert.strictEqual(fs.existsSync(s.accountsPath), false);
    assert.strictEqual(s.autoLaunchCalls, 1);
  } finally { cleanup(s); }
});

test('resumeJob : relance manuelle d\'un job ERROR', () => {
  const s = createScheduler();
  try {
    s.accountsSnapshot = [account('profil_2', 0)];
    const job = addJob(s, 'ERROR');

    s.resumeJob(job.id);

    assert.strictEqual(job.status, 'RESUME_REQUIRED');
    assert.strictEqual(job.profile, 'profil_2');
  } finally { cleanup(s); }
});

test('resumeJob : statut invalide -> erreur, job inchangé, aucun lancement', () => {
  const s = createScheduler();
  try {
    s.accountsSnapshot = [account('profil_1', 0)];
    const job = addJob(s, 'DELIVERED');

    assert.throws(() => s.resumeJob(job.id), /Transition d'état de job invalide : DELIVERED -> RESUME_REQUIRED/);
    assert.strictEqual(job.status, 'DELIVERED');
    assert.strictEqual(job.profile, 'profil_0');
    assert.strictEqual(s.accountsSnapshot[0].automation.lastAutomationAt, 0);
    assert.strictEqual(s.autoLaunchCalls, 0);
  } finally { cleanup(s); }
});

test('resumeJob : ERROR sans profil disponible -> transition WAITING_FOR_PROFILE invalide', () => {
  const s = createScheduler();
  try {
    s.accountsSnapshot = [];
    const job = addJob(s, 'ERROR');

    assert.throws(() => s.resumeJob(job.id), /ERROR -> WAITING_FOR_PROFILE/);
    assert.strictEqual(job.status, 'ERROR');
    assert.strictEqual(s.autoLaunchCalls, 0);
  } finally { cleanup(s); }
});
