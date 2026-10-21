'use strict';

// test/scheduler-completeness-coverage.test.js — Couverture de
// Scheduler.analyzeCompleteness / _autoDetectCompleteness (issue #91, tâche 55.22).
// Cas visés : job sans fichier, ZIP absent / illisible, ZIP sans FEATURES.md,
// ZIP incomplet, ZIP complet, transitions d'état refusées, et absence de tout
// shell (issue #275). userData temporaire, aucun accès réseau.

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const childProcess = require('child_process');

const { Scheduler } = require('../scheduler/index');
const core = require('../scheduler/core');

// --- Helpers ---------------------------------------------------------------

function makeScheduler() {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'iao-cov-'));
  const scheduler = new Scheduler({ getPath: function () { return userData; } }, {});
  scheduler._userData = userData;
  return scheduler;
}

function cleanup(scheduler) {
  try { fs.rmSync(scheduler._userData, { recursive: true, force: true }); } catch (_) {}
}

function addJob(scheduler, fields) {
  scheduler.jobSeq += 1;
  const job = core.buildJobRecord(Object.assign({
    id: core.nextJobId(scheduler.jobSeq),
    profile: 'profil_1',
    service: 'claude',
    status: 'COMPLETED'
  }, fields));
  scheduler.jobs.push(job);
  return job;
}

// Crée un vrai ZIP avec la commande système `zip` (comme les tests existants).
function makeZip(scheduler, files) {
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'iao-covsrc-'));
  Object.keys(files).forEach(function (rel) {
    const full = path.join(src, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, files[rel], 'utf-8');
  });
  const zipPath = path.join(scheduler._userData, 'projet-' + scheduler.jobSeq + '-' + Date.now() + '.zip');
  childProcess.execFileSync('zip', ['-q', '-r', zipPath, '.'], { cwd: src, stdio: 'pipe' });
  fs.rmSync(src, { recursive: true, force: true });
  return zipPath;
}

const COMPLETE = '# FEATURES\n\n- [x] A\n- [x] B\n';
const INCOMPLETE = '# FEATURES\n\n- [x] A\n- [ ] B\n- [~] C\n';

function lastLog(scheduler) {
  return JSON.stringify(scheduler.log);
}

// --- analyzeCompleteness ---------------------------------------------------

test('analyzeCompleteness : job sans fichier associé', function () {
  const s = makeScheduler();
  const job = addJob(s, {});
  job.outputZip = null;
  job.file_path = null;
  assert.deepStrictEqual(s.analyzeCompleteness(job.id), { error: 'Aucun fichier associé à ce job.' });
  cleanup(s);
});

test('analyzeCompleteness : job inconnu → erreur explicite', function () {
  const s = makeScheduler();
  assert.throws(function () { s.analyzeCompleteness('job_inexistant'); }, /introuvable/);
  cleanup(s);
});

test('analyzeCompleteness : ZIP absent ou illisible → aucun FEATURES.md', function () {
  const s = makeScheduler();
  const absent = addJob(s, { file_path: path.join(s._userData, 'nexiste-pas.zip') });
  assert.deepStrictEqual(s.analyzeCompleteness(absent.id), { error: 'Aucun FEATURES.md trouvé dans le ZIP.' });

  const bogus = path.join(s._userData, 'corrompu.zip');
  fs.writeFileSync(bogus, 'ceci n\'est pas un zip');
  const corrupt = addJob(s, { file_path: bogus });
  assert.deepStrictEqual(s.analyzeCompleteness(corrupt.id), { error: 'Aucun FEATURES.md trouvé dans le ZIP.' });
  cleanup(s);
});

test('analyzeCompleteness : ZIP sans FEATURES.md', function () {
  const s = makeScheduler();
  const zip = makeZip(s, { 'index.js': '// rien', 'docs/notes.md': 'notes' });
  const job = addJob(s, { file_path: zip });
  assert.deepStrictEqual(s.analyzeCompleteness(job.id), { error: 'Aucun FEATURES.md trouvé dans le ZIP.' });
  cleanup(s);
});

test('analyzeCompleteness : ZIP complet, FEATURES.md dans un sous-dossier, outputZip prioritaire', function () {
  const s = makeScheduler();
  const zip = makeZip(s, { 'projet/FEATURES.md': COMPLETE, 'projet/index.js': '// x' });
  const job = addJob(s, { file_path: path.join(s._userData, 'ignore.zip') });
  job.outputZip = zip;
  const res = s.analyzeCompleteness(job.id);
  assert.strictEqual(res.source, 'FEATURES.md');
  assert.strictEqual(res.analysis.complete, true);
  assert.strictEqual(res.analysis.done, 2);
  assert.strictEqual(res.analysis.pending, 0);
  cleanup(s);
});

test('analyzeCompleteness : ZIP incomplet', function () {
  const s = makeScheduler();
  const job = addJob(s, { file_path: makeZip(s, { 'FEATURES.md': INCOMPLETE }) });
  const res = s.analyzeCompleteness(job.id);
  assert.strictEqual(res.analysis.complete, false);
  assert.strictEqual(res.analysis.done, 1);
  assert.strictEqual(res.analysis.pending, 1);
  assert.strictEqual(res.analysis.inProgress, 1);
  cleanup(s);
});

// --- _autoDetectCompleteness ----------------------------------------------

test('_autoDetectCompleteness : pas de FEATURES.md → job laissé en COMPLETED', function () {
  const s = makeScheduler();
  const job = addJob(s, { file_path: makeZip(s, { 'index.js': '// x' }) });
  s._autoDetectCompleteness(job);
  assert.strictEqual(job.status, 'COMPLETED');
  assert.match(lastLog(s), /pas de FEATURES\.md détecté/);
  cleanup(s);
});

test('_autoDetectCompleteness : ZIP complet → DELIVERED et projet terminé', function () {
  const s = makeScheduler();
  s.projects.push({ id: 'proj_1', name: 'Mon projet', status: 'active' });
  const job = addJob(s, { file_path: makeZip(s, { 'FEATURES.md': COMPLETE }) });
  job.projectId = 'proj_1';
  s._autoDetectCompleteness(job);
  assert.strictEqual(job.status, 'DELIVERED');
  assert.strictEqual(job.autoCompleted, true);
  assert.strictEqual(s.projects[0].status, 'completed');
  cleanup(s);
});

test('_autoDetectCompleteness : ZIP complet, projet déjà terminé ou inconnu → projet inchangé', function () {
  const s = makeScheduler();
  s.projects.push({ id: 'proj_2', name: 'Déjà fini', status: 'completed' });
  const zip = makeZip(s, { 'FEATURES.md': COMPLETE });
  const j1 = addJob(s, { file_path: zip });
  j1.projectId = 'proj_2';
  s._autoDetectCompleteness(j1);
  assert.strictEqual(j1.status, 'DELIVERED');
  assert.strictEqual(s.projects[0].status, 'completed');

  const j2 = addJob(s, { file_path: zip });
  j2.projectId = 'proj_inconnu';
  s._autoDetectCompleteness(j2);
  assert.strictEqual(j2.status, 'DELIVERED');
  cleanup(s);
});

test('_autoDetectCompleteness : ZIP incomplet → PROJECT_PENDING avec analyse', function () {
  const s = makeScheduler();
  const job = addJob(s, { file_path: makeZip(s, { 'FEATURES.md': INCOMPLETE }) });
  s._autoDetectCompleteness(job);
  assert.strictEqual(job.status, 'PROJECT_PENDING');
  assert.strictEqual(job.completenessAnalysis.pending, 1);
  assert.match(lastLog(s), /passage en PROJECT_PENDING/);
  cleanup(s);
});

test('_autoDetectCompleteness : transition vers DELIVERED refusée → journalisée, statut inchangé', function () {
  const s = makeScheduler();
  const job = addJob(s, { file_path: makeZip(s, { 'FEATURES.md': COMPLETE }) });
  job.status = 'PENDING';
  assert.strictEqual(core.canTransition('PENDING', 'DELIVERED'), false);
  s._autoDetectCompleteness(job);
  assert.strictEqual(job.status, 'PENDING');
  assert.match(lastLog(s), /transition automatique impossible/);
  cleanup(s);
});

test('_autoDetectCompleteness : transition vers PROJECT_PENDING refusée → ignorée', function () {
  const s = makeScheduler();
  const job = addJob(s, { file_path: makeZip(s, { 'FEATURES.md': INCOMPLETE }) });
  job.status = 'PENDING';
  assert.strictEqual(core.canTransition('PENDING', 'PROJECT_PENDING'), false);
  assert.doesNotThrow(function () { s._autoDetectCompleteness(job); });
  assert.strictEqual(job.status, 'PENDING');
  cleanup(s);
});

test('_autoDetectCompleteness : résultat d\'analyse sans erreur ni analyse → aucun effet', function () {
  const s = makeScheduler();
  const job = addJob(s, {});
  s.analyzeCompleteness = function () { return null; };
  s._autoDetectCompleteness(job);
  s.analyzeCompleteness = function () { return {}; };
  s._autoDetectCompleteness(job);
  assert.strictEqual(job.status, 'COMPLETED');
  cleanup(s);
});

// --- Plus aucun shell (issue #275) ----------------------------------------
// L'archive est lue en JavaScript (lib/lecture-zip.js) sur tous les systèmes :
// ni `unzip`, ni PowerShell, ni dossier temporaire. Les anciens tests de la
// branche Windows (PowerShell simulé, dossier temporaire unique) n'ont plus
// d'objet ; ces tests vérifient qu'aucune commande n'est lancée.

function sansShell(fn) {
  const appels = [];
  const reels = {};
  ['exec', 'execSync', 'execFile', 'execFileSync', 'spawn', 'spawnSync'].forEach(function (nom) {
    reels[nom] = childProcess[nom];
    childProcess[nom] = function () { appels.push(nom); throw new Error('aucune commande attendue'); };
  });
  try {
    return { resultat: fn(), appels: appels };
  } finally {
    Object.keys(reels).forEach(function (nom) { childProcess[nom] = reels[nom]; });
  }
}

test('analyzeCompleteness : aucune commande système, sous Linux comme sous Windows', function () {
  const s = makeScheduler();
  const job = addJob(s, { file_path: makeZip(s, { 'b/c/features.md': COMPLETE, 'racine.txt': 'r' }) });
  const linux = sansShell(function () { return s.analyzeCompleteness(job.id); });
  assert.strictEqual(linux.resultat.analysis.complete, true);
  assert.deepStrictEqual(linux.appels, []);

  const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'win32' });
  let windows;
  try {
    windows = sansShell(function () { return s.analyzeCompleteness(job.id); });
  } finally {
    Object.defineProperty(process, 'platform', realPlatform);
  }
  assert.deepStrictEqual(windows.resultat, linux.resultat);
  assert.deepStrictEqual(windows.appels, []);
  cleanup(s);
});

test('analyzeCompleteness : chemin de ZIP au nom hostile, rien n\'est exécuté', function () {
  const s = makeScheduler();
  const origine = process.cwd();
  process.chdir(s._userData);
  try {
    const zip = makeZip(s, { 'FEATURES.md': COMPLETE });
    const hostile = path.join(s._userData, 'livraison$(touch PREUVE)`touch PREUVE`\'.zip');
    fs.renameSync(zip, hostile);
    const job = addJob(s, { file_path: hostile });
    const res = s.analyzeCompleteness(job.id);
    assert.strictEqual(res.analysis.complete, true);
    assert.strictEqual(fs.existsSync(path.join(s._userData, 'PREUVE')), false);
  } finally {
    process.chdir(origine);
    cleanup(s);
  }
});

test('analyzeCompleteness : cause de l\'échec journalisée (elle était avalée)', function () {
  const s = makeScheduler();
  const bogus = path.join(s._userData, 'tronque.zip');
  fs.writeFileSync(bogus, 'ceci n\'est pas un zip, mais assez long pour être lu');
  const job = addJob(s, { file_path: bogus });
  assert.deepStrictEqual(s.analyzeCompleteness(job.id), { error: 'Aucun FEATURES.md trouvé dans le ZIP.' });
  assert.match(lastLog(s), /Analyse de complétude impossible \(tronque\.zip\) : pas une archive ZIP/);
  cleanup(s);
});
