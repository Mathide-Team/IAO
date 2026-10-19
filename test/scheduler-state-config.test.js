'use strict';

// Ce fichier teste l'ancien flux (ZIP, jobs, projets), désactivé par défaut
// depuis #199 (lot 1) : on le réactive pour tout le fichier.
process.env.IAO_ORDONNANCEUR_ANCIEN = '1';

// test/scheduler-state-config.test.js — Couverture de scheduler/index.js :
// getState, syncAccounts, setEnabled, setConfig (issue #82, tâche 55.13).
// `app`/`session` Electron simulés, userData temporaire, aucun accès réseau.

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const { Scheduler } = require('../scheduler/index');

function createMockApp() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iao-state-'));
  return { getPath: () => tmpDir, _tmpDir: tmpDir };
}

// Session simulée : enregistre les partitions surveillées.
function createMockSession() {
  const partitions = [];
  return {
    partitions,
    fromPartition(name) {
      partitions.push(name);
      return { on() {} };
    }
  };
}

function create() {
  const app = createMockApp();
  const session = createMockSession();
  const scheduler = new Scheduler(app, session);
  return { app, session, scheduler };
}

function cleanup(ctx) {
  fs.rmSync(ctx.app._tmpDir, { recursive: true, force: true });
}

function readJSON(file) {
  return JSON.parse(fs.readFileSync(file, 'utf-8'));
}

test.beforeEach(() => {
  // _logActivity écrit sur la console : on la coupe pour garder un rapport lisible.
  test.mock.method(console, 'log', () => {});
});

test.afterEach(() => {
  test.mock.restoreAll();
});

// --- getState ---------------------------------------------------------------

test('getState : état vide (aucun job, projet ni journal)', () => {
  const ctx = create();
  try {
    const state = ctx.scheduler.getState();
    assert.strictEqual(state.config, ctx.scheduler.config);
    assert.deepStrictEqual(state.jobs, []);
    assert.deepStrictEqual(state.projects, []);
    assert.deepStrictEqual(state.log, []);
    assert.deepStrictEqual(state.counters, { active: 0, waiting: 0, deliveredToday: 0 });
  } finally { cleanup(ctx); }
});

test('getState : compteurs actifs / en attente / livrés aujourd\'hui', () => {
  const ctx = create();
  try {
    const now = new Date();
    const yesterday = new Date(now.getTime() - 48 * 3600 * 1000);
    ctx.scheduler.jobs = [
      { id: 'job_1', status: 'RUNNING', lastActivityAt: now.toISOString() },
      { id: 'job_2', status: 'RESUME_REQUIRED', lastActivityAt: now.toISOString() },
      { id: 'job_3', status: 'DOWNLOADING', lastActivityAt: now.toISOString() },
      { id: 'job_4', status: 'WAITING_FOR_PROFILE', lastActivityAt: now.toISOString() },
      { id: 'job_5', status: 'PROJECT_PENDING', lastActivityAt: now.toISOString() },
      { id: 'job_6', status: 'COMPLETED', lastActivityAt: now.toISOString() },
      { id: 'job_7', status: 'PAUSED', lastActivityAt: now.toISOString() },
      // livré aujourd'hui -> compté
      { id: 'job_8', status: 'DELIVERED', finished_at: now.toISOString(), lastActivityAt: now.toISOString() },
      // livré il y a 48 h -> non compté
      { id: 'job_9', status: 'DELIVERED', finished_at: yesterday.toISOString(), lastActivityAt: yesterday.toISOString() },
      // livré sans finished_at -> non compté
      { id: 'job_10', status: 'DELIVERED', lastActivityAt: yesterday.toISOString() },
      // statut hors compteurs
      { id: 'job_11', status: 'ERROR', lastActivityAt: yesterday.toISOString() }
    ];
    const { counters } = ctx.scheduler.getState();
    assert.deepStrictEqual(counters, { active: 3, waiting: 4, deliveredToday: 1 });
  } finally { cleanup(ctx); }
});

test('getState : jobs et projets triés par activité décroissante, sans muter les originaux', () => {
  const ctx = create();
  try {
    ctx.scheduler.jobs = [
      { id: 'job_1', status: 'PAUSED', lastActivityAt: '2026-09-01T10:00:00.000Z' },
      { id: 'job_2', status: 'PAUSED', lastActivityAt: '2026-09-03T10:00:00.000Z' },
      { id: 'job_3', status: 'PAUSED', lastActivityAt: '2026-09-02T10:00:00.000Z' }
    ];
    ctx.scheduler.projects = [
      { id: 'proj_1', lastActivityAt: '2026-09-01T10:00:00.000Z' },
      { id: 'proj_2', lastActivityAt: '2026-09-05T10:00:00.000Z' },
      { id: 'proj_3', lastActivityAt: '2026-09-03T10:00:00.000Z' }
    ];
    const state = ctx.scheduler.getState();
    assert.deepStrictEqual(state.jobs.map(j => j.id), ['job_2', 'job_3', 'job_1']);
    assert.deepStrictEqual(state.projects.map(p => p.id), ['proj_2', 'proj_3', 'proj_1']);
    // Les tableaux internes gardent leur ordre d'origine.
    assert.deepStrictEqual(ctx.scheduler.jobs.map(j => j.id), ['job_1', 'job_2', 'job_3']);
    assert.deepStrictEqual(ctx.scheduler.projects.map(p => p.id), ['proj_1', 'proj_2', 'proj_3']);
  } finally { cleanup(ctx); }
});

test('getState : journal limité aux 100 dernières entrées, plus récente en premier', () => {
  const ctx = create();
  try {
    ctx.scheduler.log = [];
    for (let i = 1; i <= 120; i++) ctx.scheduler.log.push({ ts: 't' + i, message: 'm' + i });
    const { log } = ctx.scheduler.getState();
    assert.strictEqual(log.length, 100);
    assert.strictEqual(log[0].message, 'm120');
    assert.strictEqual(log[99].message, 'm21');
    assert.strictEqual(ctx.scheduler.log.length, 120);
  } finally { cleanup(ctx); }
});

// --- syncAccounts -----------------------------------------------------------

test('syncAccounts : entrée non tableau -> instantané vide et persisté', () => {
  const ctx = create();
  try {
    ctx.scheduler.syncAccounts({ not: 'an array' });
    assert.deepStrictEqual(ctx.scheduler.accountsSnapshot, []);
    assert.deepStrictEqual(readJSON(ctx.scheduler.accountsPath), []);
    assert.deepStrictEqual(ctx.session.partitions, []);
    ctx.scheduler.syncAccounts(undefined);
    assert.deepStrictEqual(ctx.scheduler.accountsSnapshot, []);
  } finally { cleanup(ctx); }
});

test('syncAccounts : ajout de comptes, valeurs par défaut et surveillance des partitions', () => {
  const ctx = create();
  try {
    ctx.scheduler.setEnabled(true); // #181 : surveillance seulement ordonnanceur démarré
    ctx.scheduler.syncAccounts([
      { id: 'a1', name: 'Alice', profile: 'profil_1' },
      { id: 'a2', name: 'Bob', profile: 'profil_2', automation: { enabled: false, lastUsedAt: '1700', lastAutomationAt: 900 } },
      // automation non objet -> ignoré
      { id: 'a3', name: 'Carol', profile: 'profil_3', automation: 'oops' }
    ]);
    assert.deepStrictEqual(ctx.scheduler.accountsSnapshot, [
      { id: 'a1', name: 'Alice', profile: 'profil_1', automation: { enabled: true, lastUsedAt: 0, lastAutomationAt: 0 } },
      { id: 'a2', name: 'Bob', profile: 'profil_2', automation: { enabled: false, lastUsedAt: 1700, lastAutomationAt: 900 } },
      { id: 'a3', name: 'Carol', profile: 'profil_3', automation: { enabled: true, lastUsedAt: 0, lastAutomationAt: 0 } }
    ]);
    assert.deepStrictEqual(readJSON(ctx.scheduler.accountsPath), ctx.scheduler.accountsSnapshot);
    assert.deepStrictEqual(ctx.session.partitions, ['persist:profil_1', 'persist:profil_2', 'persist:profil_3']);
    assert.ok(ctx.scheduler.watchedPartitions.has('profil_2'));
  } finally { cleanup(ctx); }
});

test('syncAccounts : lastAutomationAt connu du main est préservé, celui du renderer est ignoré', () => {
  const ctx = create();
  try {
    ctx.scheduler.syncAccounts([{ id: 'a1', name: 'Alice', profile: 'profil_1', automation: { lastAutomationAt: 100 } }]);
    // Le process main met à jour la valeur (continueProject/resumeJob).
    ctx.scheduler.accountsSnapshot[0].automation.lastAutomationAt = 5000;
    ctx.scheduler.syncAccounts([{ id: 'a1', name: 'Alice 2', profile: 'profil_1', automation: { enabled: false, lastUsedAt: 42, lastAutomationAt: 1 } }]);
    const acc = ctx.scheduler.accountsSnapshot[0];
    assert.strictEqual(acc.name, 'Alice 2');
    assert.strictEqual(acc.automation.lastAutomationAt, 5000);
    assert.strictEqual(acc.automation.lastUsedAt, 42);
    assert.strictEqual(acc.automation.enabled, false);
  } finally { cleanup(ctx); }
});

test('syncAccounts : valeur précédente non numérique -> 0', () => {
  const ctx = create();
  try {
    ctx.scheduler.syncAccounts([{ id: 'a1', name: 'Alice', profile: 'profil_1' }]);
    ctx.scheduler.accountsSnapshot[0].automation.lastAutomationAt = 'abc';
    ctx.scheduler.syncAccounts([{ id: 'a1', name: 'Alice', profile: 'profil_1' }]);
    assert.strictEqual(ctx.scheduler.accountsSnapshot[0].automation.lastAutomationAt, 0);
  } finally { cleanup(ctx); }
});

test('syncAccounts : comptes supprimés retirés de l\'instantané, partitions déjà surveillées non redoublées', () => {
  const ctx = create();
  try {
    ctx.scheduler.setEnabled(true); // #181 : surveillance seulement ordonnanceur démarré
    ctx.scheduler.syncAccounts([
      { id: 'a1', name: 'Alice', profile: 'profil_1' },
      { id: 'a2', name: 'Bob', profile: 'profil_2' }
    ]);
    assert.strictEqual(ctx.session.partitions.length, 2);
    ctx.scheduler.syncAccounts([{ id: 'a2', name: 'Bob', profile: 'profil_2' }]);
    assert.deepStrictEqual(ctx.scheduler.accountsSnapshot.map(a => a.id), ['a2']);
    assert.deepStrictEqual(readJSON(ctx.scheduler.accountsPath).map(a => a.id), ['a2']);
    // Aucune nouvelle surveillance : profil_2 était déjà observé.
    assert.strictEqual(ctx.session.partitions.length, 2);
    ctx.scheduler.syncAccounts([]);
    assert.deepStrictEqual(ctx.scheduler.accountsSnapshot, []);
  } finally { cleanup(ctx); }
});

// --- setEnabled -------------------------------------------------------------

test('setEnabled : bascule on/off, persiste la config et journalise', () => {
  const ctx = create();
  try {
    const off = ctx.scheduler.setEnabled(false);
    assert.strictEqual(off.enabled, false);
    assert.strictEqual(readJSON(ctx.scheduler.configPath).enabled, false);
    assert.strictEqual(ctx.scheduler.log[ctx.scheduler.log.length - 1].message, 'Ordonnanceur arrêté.');

    const on = ctx.scheduler.setEnabled(1);
    assert.strictEqual(on.enabled, true);
    assert.strictEqual(readJSON(ctx.scheduler.configPath).enabled, true);
    assert.strictEqual(ctx.scheduler.log[ctx.scheduler.log.length - 1].message, 'Ordonnanceur démarré.');
    assert.strictEqual(ctx.scheduler.getState().config.enabled, true);
  } finally { cleanup(ctx); }
});

// --- Démarrage / arrêt manuel (issue #181) -----------------------------------

test('#181 syncAccounts : ordonnanceur arrêté -> aucune partition surveillée', () => {
  const ctx = create();
  try {
    ctx.scheduler.syncAccounts([{ id: 'a1', name: 'Alice', profile: 'profil_1' }]);
    assert.deepStrictEqual(ctx.session.partitions, []);
    assert.strictEqual(ctx.scheduler.watchedPartitions.size, 0);
  } finally { cleanup(ctx); }
});

test('#181 setEnabled(false) : retire les écouteurs will-download et oublie les profils', () => {
  const { EventEmitter } = require('events');
  const app = createMockApp();
  const sessions = {};
  const session = { fromPartition(n) { return (sessions[n] = sessions[n] || new EventEmitter()); } };
  const scheduler = new Scheduler(app, session);
  try {
    scheduler.syncAccounts([{ id: 'a1', profile: 'profil_1' }, { id: 'a2', profile: 'profil_2' }]);
    scheduler.setEnabled(true);
    assert.strictEqual(sessions['persist:profil_1'].listenerCount('will-download'), 1);
    scheduler.setEnabled(false);
    assert.strictEqual(sessions['persist:profil_1'].listenerCount('will-download'), 0);
    assert.strictEqual(sessions['persist:profil_2'].listenerCount('will-download'), 0);
    assert.strictEqual(scheduler.watchedPartitions.size, 0);
    assert.ok(scheduler.log.some(l => l.message === 'Surveillance des téléchargements arrêtée (2 profil(s)).'));
    // Redémarrer rebranche une seule fois chaque profil.
    scheduler.setEnabled(true);
    assert.strictEqual(sessions['persist:profil_1'].listenerCount('will-download'), 1);
  } finally { cleanup({ app }); }
});

test('#181 setEnabled(false) : sans profil surveillé, aucun message de surveillance', () => {
  const ctx = create();
  try {
    ctx.scheduler.setEnabled(false);
    assert.ok(!ctx.scheduler.log.some(l => l.message.startsWith('Surveillance des téléchargements arrêtée')));
  } finally { cleanup(ctx); }
});

test('#181 setEnabled(false) : un échec de retrait d\'écouteur est journalisé sans lever', (t) => {
  const ctx = create(); // session simulée sans removeListener
  const errors = t.mock.method(console, 'error', () => {});
  try {
    ctx.scheduler.syncAccounts([{ id: 'a1', profile: 'profil_1' }]);
    ctx.scheduler.setEnabled(true);
    assert.doesNotThrow(() => ctx.scheduler.setEnabled(false));
    assert.strictEqual(errors.mock.callCount(), 1);
    assert.match(String(errors.mock.calls[0].arguments[0]), /arrêt de la surveillance du profil/);
    assert.strictEqual(ctx.scheduler.watchedPartitions.size, 0);
  } finally { cleanup(ctx); }
});

// --- setConfig --------------------------------------------------------------

test('setConfig : fusion partielle, garde-fous numériques et persistance', () => {
  const ctx = create();
  try {
    const before = { ...ctx.scheduler.config };
    // partial absent -> config inchangée mais journalisée
    const same = ctx.scheduler.setConfig();
    assert.strictEqual(same.maxConcurrentJobs, before.maxConcurrentJobs);
    assert.strictEqual(same.profileAgeThresholdHours, before.profileAgeThresholdHours);

    const cfg = ctx.scheduler.setConfig({
      maxConcurrentJobs: -3,
      minDelayBetweenAutomationsMinutes: 'x',
      profileAgeThresholdHours: -1
    });
    assert.ok(cfg.maxConcurrentJobs >= 1);
    assert.strictEqual(cfg.minDelayBetweenAutomationsMinutes, 0);
    assert.ok(cfg.profileAgeThresholdHours >= 0);

    const ok = ctx.scheduler.setConfig({ maxConcurrentJobs: 4, minDelayBetweenAutomationsMinutes: 15, profileAgeThresholdHours: 6 });
    assert.strictEqual(ok.maxConcurrentJobs, 4);
    assert.strictEqual(ok.minDelayBetweenAutomationsMinutes, 15);
    assert.strictEqual(ok.profileAgeThresholdHours, 6);
    assert.deepStrictEqual(readJSON(ctx.scheduler.configPath), ok);
  } finally { cleanup(ctx); }
});

test('état rechargé : un nouveau Scheduler relit config et instantané persistés', () => {
  const ctx = create();
  try {
    ctx.scheduler.setEnabled(false);
    ctx.scheduler.syncAccounts([{ id: 'a1', name: 'Alice', profile: 'profil_1' }]);
    const reloaded = new Scheduler(ctx.app, createMockSession());
    assert.strictEqual(reloaded.config.enabled, false);
    assert.deepStrictEqual(reloaded.accountsSnapshot.map(a => a.id), ['a1']);
  } finally { cleanup(ctx); }
});

// --- reportStartupAccounts (issue #186) -------------------------------------

test('reportStartupAccounts : interface vide, instantané non vide -> warning journalisé et comptes renvoyés', () => {
  const ctx = create();
  try {
    ctx.scheduler.syncAccounts([{ id: 'a1', name: 'Alice', profile: 'profil_1' }, { id: 'a2', name: 'Bob', profile: 'profil_2' }]);
    const lines = [];
    ctx.scheduler.setLogger((scope, level, message) => lines.push([scope, level, message]), false);
    const res = ctx.scheduler.reportStartupAccounts({ status: 'empty', count: 0 });
    assert.strictEqual(res.offerRestore, true);
    assert.deepStrictEqual(res.accounts.map(a => a.id + ':' + a.profile + ':' + a.email), ['a1:profil_1:', 'a2:profil_2:']);
    assert.strictEqual(lines.length, 1);
    assert.strictEqual(lines[0][0], 'scheduler');
    assert.strictEqual(lines[0][1], 'warning');
    assert.match(lines[0][2], /Comptes lus au démarrage : 0 .* instantané de l'ordonnanceur : 2 compte\(s\)/);
  } finally { cleanup(ctx); }
});

test('reportStartupAccounts : comptes présents -> info sur la console sans logger, aucun compte renvoyé', () => {
  const ctx = create();
  try {
    ctx.scheduler.syncAccounts([{ id: 'a1', name: 'Alice', profile: 'profil_1' }]);
    const res = ctx.scheduler.reportStartupAccounts({ status: 'ok', count: 1 });
    assert.deepStrictEqual(res, { offerRestore: false, accounts: [] });
    const logged = console.log.mock.calls.map(c => c.arguments.join(' '));
    assert.ok(logged.some(l => /\[scheduler\] Comptes lus au démarrage : 1 \(stockage de l'interface : ok\)/.test(l)));
  } finally { cleanup(ctx); }
});
