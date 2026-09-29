'use strict';

// test/scheduler-downloads.test.js — Surveillance des téléchargements de
// scheduler/index.js (issue #84, tâche 55.15) : _watchPartition et
// _onWillDownload. `app` et `session` Electron sont simulés, le userData est
// un dossier temporaire, aucun accès réseau.

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { EventEmitter } = require('events');

const { Scheduler } = require('../scheduler/index');

// --- Helpers ---------------------------------------------------------------

function makeScheduler(t) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'iao-dl-'));
  t.after(() => fs.rmSync(userData, { recursive: true, force: true }));
  // Le code testé journalise volontiers : on garde la sortie des tests propre.
  t.mock.method(console, 'log', () => {});
  const errors = t.mock.method(console, 'error', () => {});

  const sessions = {};
  const electronSession = {
    fromPartition(name) {
      if (electronSession.failWith) throw electronSession.failWith;
      sessions[name] = sessions[name] || new EventEmitter();
      return sessions[name];
    },
    failWith: null
  };
  const app = { getPath: () => userData };
  const scheduler = new Scheduler(app, electronSession);
  return { scheduler, sessions, electronSession, userData, errors };
}

// Faux DownloadItem : EventEmitter + accesseurs Electron.
function makeItem({ filename = 'projet.zip', url = 'https://claude.ai/files/projet.zip', savePath } = {}) {
  const item = new EventEmitter();
  item.getFilename = () => filename;
  item.getURL = () => url;
  item.getSavePath = () => savePath;
  return item;
}

const claudeTab = { getURL: () => 'https://claude.ai/chat/abc' };

function logMessages(scheduler) {
  return scheduler.log.map(l => l.message);
}

// --- _watchPartition -------------------------------------------------------

test('_watchPartition : un profil vide ou inconnu est ignoré', (t) => {
  const { scheduler, sessions } = makeScheduler(t);
  scheduler._watchPartition(undefined);
  scheduler._watchPartition(null);
  scheduler._watchPartition('');
  assert.strictEqual(scheduler.watchedPartitions.size, 0);
  assert.deepStrictEqual(Object.keys(sessions), []);
});

test('_watchPartition : enregistre un écouteur will-download une seule fois par profil', (t) => {
  const { scheduler, sessions } = makeScheduler(t);
  scheduler._watchPartition('profil_1');
  scheduler._watchPartition('profil_1'); // déjà surveillé -> sans effet

  assert.ok(scheduler.watchedPartitions.has('profil_1'));
  assert.deepStrictEqual(Object.keys(sessions), ['persist:profil_1']);
  assert.strictEqual(sessions['persist:profil_1'].listenerCount('will-download'), 1);
  const activations = logMessages(scheduler).filter(m => m.includes('Surveillance des téléchargements activée'));
  assert.strictEqual(activations.length, 1);
  assert.match(activations[0], /profil_1/);
});

test('_watchPartition : l\'écouteur transmet profil, item et webContents à _onWillDownload', (t) => {
  const { scheduler, sessions } = makeScheduler(t);
  const calls = [];
  scheduler._onWillDownload = (profile, item, wc) => calls.push([profile, item, wc]);
  scheduler._watchPartition('profil_2');

  const item = makeItem();
  sessions['persist:profil_2'].emit('will-download', {}, item, claudeTab);
  assert.strictEqual(calls.length, 1);
  assert.deepStrictEqual(calls[0], ['profil_2', item, claudeTab]);
});

test('_watchPartition : une erreur dans le traitement d\'un téléchargement est journalisée sans remonter', (t) => {
  const { scheduler, sessions, errors } = makeScheduler(t);
  scheduler._onWillDownload = () => { throw new Error('boum'); };
  scheduler._watchPartition('profil_3');

  assert.doesNotThrow(() => sessions['persist:profil_3'].emit('will-download', {}, makeItem(), claudeTab));
  assert.strictEqual(errors.mock.callCount(), 1);
  assert.match(String(errors.mock.calls[0].arguments[0]), /erreur de traitement d'un téléchargement/);
  assert.strictEqual(errors.mock.calls[0].arguments[1].message, 'boum');
});

test('_watchPartition : un échec de session.fromPartition est journalisé sans lever', (t) => {
  const { scheduler, electronSession, errors } = makeScheduler(t);
  electronSession.failWith = new Error('partition indisponible');

  assert.doesNotThrow(() => scheduler._watchPartition('profil_4'));
  assert.strictEqual(errors.mock.callCount(), 1);
  assert.match(String(errors.mock.calls[0].arguments[0]), /échec de la surveillance du profil/);
  assert.strictEqual(errors.mock.calls[0].arguments[1], 'profil_4');
  // Aucune activation journalisée : la surveillance n'a pas démarré.
  assert.ok(!logMessages(scheduler).some(m => m.includes('Surveillance des téléchargements activée')));
});

// --- _onWillDownload : filtrages -------------------------------------------

test('_onWillDownload : ordonnanceur désactivé -> aucun suivi', (t) => {
  const { scheduler } = makeScheduler(t);
  scheduler.config.enabled = false;
  const item = makeItem();
  scheduler._onWillDownload('profil_1', item, claudeTab);

  assert.strictEqual(scheduler.jobs.length, 0);
  assert.strictEqual(item.listenerCount('done'), 0);
});

test('_onWillDownload : un fichier qui n\'est pas un .zip est ignoré', (t) => {
  const { scheduler } = makeScheduler(t);
  scheduler.config.enabled = true;
  const item = makeItem({ filename: 'notes.pdf', url: 'https://claude.ai/files/notes.pdf' });
  scheduler._onWillDownload('profil_1', item, claudeTab);

  assert.strictEqual(scheduler.jobs.length, 0);
  assert.strictEqual(item.listenerCount('done'), 0);
});

// --- _onWillDownload : création du job -------------------------------------

test('_onWillDownload : un .zip crée un job DOWNLOADING rattaché au profil et au service', (t) => {
  const { scheduler } = makeScheduler(t);
  scheduler.config.enabled = true;
  const item = makeItem();
  scheduler._onWillDownload('profil_1', item, claudeTab);

  assert.strictEqual(scheduler.jobs.length, 1);
  const job = scheduler.jobs[0];
  assert.strictEqual(job.status, 'DOWNLOADING');
  assert.strictEqual(job.profile, 'profil_1');
  assert.strictEqual(job.service, 'claude');
  assert.strictEqual(job.attempts, 1);
  assert.strictEqual(scheduler.jobSeq, 1);
  assert.strictEqual(item.listenerCount('done'), 1);
  assert.ok(logMessages(scheduler).some(m => m.includes('Téléchargement détecté : projet.zip (profil profil_1, service claude)')));
  // Le registre est persisté (JSON + CSV).
  const saved = JSON.parse(fs.readFileSync(scheduler.jobsPath, 'utf-8'));
  assert.strictEqual(saved.length, 1);
  assert.ok(fs.existsSync(scheduler.csvPath));
});

test('_onWillDownload : service inconnu (webContents fermé ou hôte hors liste) -> service « ? »', (t) => {
  const { scheduler } = makeScheduler(t);
  scheduler.config.enabled = true;

  // webContents dont l'URL est invalide : new URL() lève, l'hôte reste null.
  scheduler._onWillDownload('profil_1', makeItem(), { getURL: () => 'pas une url' });
  // webContents dont l'URL n'appartient à aucun service connu.
  scheduler._onWillDownload('profil_1', makeItem(), { getURL: () => 'https://exemple.org/page' });

  assert.strictEqual(scheduler.jobs.length, 2);
  assert.strictEqual(scheduler.jobs[0].service, null);
  assert.strictEqual(scheduler.jobs[1].service, null);
  const detected = logMessages(scheduler).filter(m => m.startsWith('Téléchargement détecté'));
  assert.strictEqual(detected.length, 2);
  detected.forEach(m => assert.match(m, /service \?\)\./));
  // Les identifiants de jobs s'incrémentent.
  assert.notStrictEqual(scheduler.jobs[0].id, scheduler.jobs[1].id);
});

// --- _onWillDownload : événement « done » ----------------------------------

test('done « completed » : job COMPLETED avec chemin et taille, complétude analysée', (t) => {
  const { scheduler, userData } = makeScheduler(t);
  scheduler.config.enabled = true;
  const savePath = path.join(userData, 'projet.zip');
  fs.writeFileSync(savePath, 'contenu-zip'); // 11 octets
  const analysed = [];
  scheduler._autoDetectCompleteness = (job) => analysed.push(job.id);

  const item = makeItem({ savePath });
  scheduler._onWillDownload('profil_1', item, claudeTab);
  item.emit('done', {}, 'completed');

  const job = scheduler.jobs[0];
  assert.strictEqual(job.status, 'COMPLETED');
  assert.strictEqual(job.file_path, savePath);
  assert.strictEqual(job.file_size, 11);
  assert.ok(job.finished_at);
  assert.strictEqual(job.lastActivityAt, job.finished_at);
  assert.deepStrictEqual(analysed, [job.id]);
  assert.ok(logMessages(scheduler).includes('Téléchargement terminé : projet.zip (11 octets).'));
  const saved = JSON.parse(fs.readFileSync(scheduler.jobsPath, 'utf-8'));
  assert.strictEqual(saved[0].status, 'COMPLETED');
});

test('done « completed » : fichier déjà déplacé ou supprimé -> taille 0, job tout de même COMPLETED', (t) => {
  const { scheduler, userData } = makeScheduler(t);
  scheduler.config.enabled = true;
  scheduler._autoDetectCompleteness = () => {};
  const savePath = path.join(userData, 'disparu.zip'); // jamais créé

  const item = makeItem({ savePath });
  scheduler._onWillDownload('profil_1', item, claudeTab);
  item.emit('done', {}, 'completed');

  const job = scheduler.jobs[0];
  assert.strictEqual(job.status, 'COMPLETED');
  assert.strictEqual(job.file_size, 0);
  assert.ok(logMessages(scheduler).includes('Téléchargement terminé : disparu.zip (0 octets).'));
});

for (const state of ['cancelled', 'interrupted']) {
  test('done « ' + state + ' » : job ERROR, journal d\'échec, pas d\'analyse de complétude', (t) => {
    const { scheduler, userData } = makeScheduler(t);
    scheduler.config.enabled = true;
    const analysed = [];
    scheduler._autoDetectCompleteness = (job) => analysed.push(job.id);
    const savePath = path.join(userData, 'partiel.zip');

    const item = makeItem({ filename: 'partiel.zip', savePath });
    scheduler._onWillDownload('profil_1', item, claudeTab);
    item.emit('done', {}, state);

    const job = scheduler.jobs[0];
    assert.strictEqual(job.status, 'ERROR');
    assert.strictEqual(job.file_path, savePath);
    assert.strictEqual(job.file_size, 0);
    assert.ok(job.finished_at);
    assert.deepStrictEqual(analysed, []);
    assert.ok(logMessages(scheduler).includes('Téléchargement en échec ou annulé : partiel.zip.'));
  });
}

test('done : une transition d\'état invalide est journalisée et le job garde son statut', (t) => {
  const { scheduler, userData, errors } = makeScheduler(t);
  scheduler.config.enabled = true;
  scheduler._autoDetectCompleteness = () => {};
  const savePath = path.join(userData, 'projet.zip');

  const item = makeItem({ savePath });
  scheduler._onWillDownload('profil_1', item, claudeTab);
  // Un job déjà livré (état terminal) ne peut plus passer à COMPLETED.
  scheduler.jobs[0].status = 'DELIVERED';
  assert.doesNotThrow(() => item.emit('done', {}, 'completed'));

  assert.strictEqual(scheduler.jobs[0].status, 'DELIVERED');
  assert.strictEqual(errors.mock.callCount(), 1);
  assert.match(String(errors.mock.calls[0].arguments[0]), /transition invalide sur job/);
  assert.strictEqual(errors.mock.calls[0].arguments[1], scheduler.jobs[0].id);
  assert.match(errors.mock.calls[0].arguments[2].message, /DELIVERED -> COMPLETED/);
});

test('bout en bout : la surveillance d\'une partition suit un téléchargement jusqu\'à COMPLETED', (t) => {
  const { scheduler, sessions, userData } = makeScheduler(t);
  scheduler.config.enabled = true;
  scheduler._autoDetectCompleteness = () => {};
  const savePath = path.join(userData, 'livraison.zip');
  fs.writeFileSync(savePath, 'abc');

  scheduler._watchPartition('profil_9');
  const item = makeItem({ filename: 'livraison.zip', savePath });
  sessions['persist:profil_9'].emit('will-download', {}, item, claudeTab);
  item.emit('done', {}, 'completed');

  assert.strictEqual(scheduler.jobs.length, 1);
  assert.strictEqual(scheduler.jobs[0].profile, 'profil_9');
  assert.strictEqual(scheduler.jobs[0].status, 'COMPLETED');
  assert.strictEqual(scheduler.jobs[0].file_size, 3);
});
