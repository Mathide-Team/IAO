'use strict';

// test/scheduler-completeness-coverage.test.js — Couverture de
// Scheduler.analyzeCompleteness / _autoDetectCompleteness (issue #91, tâche 55.22).
// Cas visés : job sans fichier, ZIP absent / illisible, ZIP sans FEATURES.md,
// ZIP incomplet, ZIP complet, transitions d'état refusées, et stratégie
// Windows (PowerShell simulé). userData temporaire, `child_process` simulé
// uniquement pour la branche Windows, aucun accès réseau.

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
  childProcess.execSync('zip -r "' + zipPath + '" .', { cwd: src, stdio: 'pipe' });
  fs.rmSync(src, { recursive: true, force: true });
  return zipPath;
}

const COMPLETE = '# FEATURES\n\n- [x] A\n- [x] B\n';
const INCOMPLETE = '# FEATURES\n\n- [x] A\n- [ ] B\n- [~] C\n';

function lastLog(scheduler) {
  return JSON.stringify(scheduler.log);
}

// Remplace temporairement process.platform et child_process.execSync.
function withWindowsPlatform(fakeExecSync, fn) {
  const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  const realExec = childProcess.execSync;
  Object.defineProperty(process, 'platform', { value: 'win32' });
  childProcess.execSync = fakeExecSync;
  try {
    return fn();
  } finally {
    childProcess.execSync = realExec;
    Object.defineProperty(process, 'platform', realPlatform);
  }
}

// Simule « Expand-Archive » : extrait l'arbre `tree` dans le DestinationPath.
function fakePowerShell(tree, calls) {
  return function (command) {
    if (calls) calls.push(command);
    const m = /-DestinationPath '([^']+)'/.exec(command);
    const dest = m[1];
    Object.keys(tree).forEach(function (rel) {
      const full = path.join(dest, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, tree[rel], 'utf-8');
    });
    if (!Object.keys(tree).length) fs.mkdirSync(dest, { recursive: true });
    return Buffer.from('');
  };
}

// --- analyzeCompleteness : Linux / macOS ----------------------------------

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

// --- analyzeCompleteness : stratégie Windows (PowerShell simulé) -----------

test('analyzeCompleteness (Windows) : FEATURES.md trouvé dans un sous-dossier imbriqué', function () {
  const s = makeScheduler();
  const job = addJob(s, { file_path: 'C:\\livraisons\\projet.zip' });
  const calls = [];
  const res = withWindowsPlatform(
    fakePowerShell({ 'a/vide/x.txt': 'x', 'b/c/features.md': COMPLETE, 'racine.txt': 'r' }, calls),
    function () { return s.analyzeCompleteness(job.id); }
  );
  assert.strictEqual(res.analysis.complete, true);
  assert.match(calls[0], /Expand-Archive -LiteralPath 'C:\\livraisons\\projet\.zip'/);
  cleanup(s);
});

test('analyzeCompleteness (Windows) : FEATURES.md à la racine, échec du nettoyage toléré', function () {
  const s = makeScheduler();
  const job = addJob(s, { file_path: 'C:\\projet.zip' });
  const realRm = fs.rmSync;
  fs.rmSync = function () { throw new Error('EBUSY'); };
  let res;
  try {
    res = withWindowsPlatform(
      fakePowerShell({ 'FEATURES.md': INCOMPLETE }),
      function () { return s.analyzeCompleteness(job.id); }
    );
  } finally {
    fs.rmSync = realRm;
  }
  assert.strictEqual(res.analysis.complete, false);
  assert.strictEqual(res.analysis.pending, 1);
  cleanup(s);
});

test('analyzeCompleteness (Windows) : archive sans FEATURES.md', function () {
  const s = makeScheduler();
  const job = addJob(s, { file_path: 'C:\\projet.zip' });
  const res = withWindowsPlatform(
    fakePowerShell({ 'src/index.js': '// x' }),
    function () { return s.analyzeCompleteness(job.id); }
  );
  assert.deepStrictEqual(res, { error: 'Aucun FEATURES.md trouvé dans le ZIP.' });
  cleanup(s);
});

test('analyzeCompleteness (Windows) : PowerShell échoue', function () {
  const s = makeScheduler();
  const job = addJob(s, { file_path: 'C:\\projet.zip' });
  const res = withWindowsPlatform(
    function () { throw new Error('powershell introuvable'); },
    function () { return s.analyzeCompleteness(job.id); }
  );
  assert.deepStrictEqual(res, { error: 'Aucun FEATURES.md trouvé dans le ZIP.' });
  cleanup(s);
});

// --- Dossier temporaire unique (test intermittent du 30/09/2026) -----------
// 'iao-zip-' + Date.now() : deux analyses dans la même milliseconde
// partageaient le dossier ; un FEATURES.md resté d'un nettoyage raté était
// relu par l'analyse suivante. mkdtempSync garantit un dossier unique.

test('analyzeCompleteness (Windows) : dossier unique même à Date.now() constant', function () {
  const s = makeScheduler();
  const job = addJob(s, { file_path: 'C:\\projet.zip' });
  const realNow = Date.now;
  const realRm = fs.rmSync;
  const dests = [];
  Date.now = function () { return 1700000000000; };
  try {
    fs.rmSync = function () { throw new Error('EBUSY'); }; // 1re analyse : nettoyage raté
    const first = withWindowsPlatform(
      fakePowerShell({ 'FEATURES.md': COMPLETE }, dests),
      function () { return s.analyzeCompleteness(job.id); }
    );
    fs.rmSync = realRm;
    assert.strictEqual(first.analysis.complete, true);
    const second = withWindowsPlatform(
      fakePowerShell({ 'src/index.js': '// x' }, dests),
      function () { return s.analyzeCompleteness(job.id); }
    );
    assert.deepStrictEqual(second, { error: 'Aucun FEATURES.md trouvé dans le ZIP.' });
  } finally {
    Date.now = realNow;
    fs.rmSync = realRm;
  }
  const dirs = dests.map(c => /-DestinationPath '([^']+)'/.exec(c)[1]);
  assert.notStrictEqual(dirs[0], dirs[1], 'deux dossiers distincts');
  fs.rmSync(dirs[0], { recursive: true, force: true }); // reste du nettoyage simulé raté
  assert.strictEqual(fs.existsSync(dirs[1]), false, '2e dossier nettoyé');
  cleanup(s);
});

test('analyzeCompleteness (Windows) : dossier temporaire supprimé si PowerShell échoue', function () {
  const s = makeScheduler();
  const job = addJob(s, { file_path: 'C:\\projet.zip' });
  let dest = null;
  const res = withWindowsPlatform(
    function (command) {
      dest = /-DestinationPath '([^']+)'/.exec(command)[1];
      assert.strictEqual(fs.existsSync(dest), true, 'dossier créé avant PowerShell');
      throw new Error('powershell introuvable');
    },
    function () { return s.analyzeCompleteness(job.id); }
  );
  assert.deepStrictEqual(res, { error: 'Aucun FEATURES.md trouvé dans le ZIP.' });
  assert.strictEqual(fs.existsSync(dest), false, 'dossier temporaire nettoyé');
  cleanup(s);
});
