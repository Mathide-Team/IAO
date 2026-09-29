'use strict';

// test/scheduler-index-persistence.test.js — Couverture de scheduler/index.js :
// init(), chargement (_loadSync / _readJSONSync) et _persistAccounts (issue #81).
// `app` et `session` Electron sont simulés ; userData est un dossier temporaire.
// Aucun accès réseau.

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const { Scheduler } = require('../scheduler/index');
const core = require('../scheduler/core');

// Crée un userData temporaire (supprimé en fin de test) et, si demandé,
// y pré-écrit des fichiers du dossier scheduler/ avant l'instanciation.
function setup(t, files) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'iao-sched-idx-'));
  t.after(() => fs.rmSync(userData, { recursive: true, force: true }));
  const dir = path.join(userData, 'scheduler');
  fs.mkdirSync(dir, { recursive: true });
  Object.keys(files || {}).forEach(name => {
    const content = files[name];
    fs.writeFileSync(path.join(dir, name), typeof content === 'string' ? content : JSON.stringify(content), 'utf-8');
  });
  const app = { getPath: () => userData };
  const partitions = [];
  const session = {
    fromPartition(p) {
      partitions.push(p);
      return { on() {} };
    }
  };
  // Silence le journal console du scheduler.
  t.mock.method(console, 'log', () => {});
  const errors = [];
  t.mock.method(console, 'error', (...args) => { errors.push(args); });
  return { app, session, partitions, dir, errors };
}

// --- Chargement : fichiers absents, corrompus, partiels -------------------

test('_loadSync : fichiers absents -> valeurs par défaut et compteurs à 0', (t) => {
  const { app, session } = setup(t);
  const s = new Scheduler(app, session);
  assert.deepStrictEqual(s.config, { ...core.DEFAULT_CONFIG });
  assert.deepStrictEqual(s.jobs, []);
  assert.deepStrictEqual(s.accountsSnapshot, []);
  assert.deepStrictEqual(s.log, []);
  assert.deepStrictEqual(s.projects, []);
  assert.strictEqual(s.jobSeq, 0);
  assert.strictEqual(s.projectSeq, 0);
  assert.strictEqual(s.taskSeq, 0);
});

test('_loadSync : JSON corrompu -> repli sur les valeurs par défaut', (t) => {
  const { app, session } = setup(t, {
    'config.json': '{ pas du json',
    'jobs.json': '[[[',
    'accounts-snapshot.json': '',
    'activity.json': 'nope',
    'projects.json': '{"a":'
  });
  const s = new Scheduler(app, session);
  assert.deepStrictEqual(s.config, { ...core.DEFAULT_CONFIG });
  assert.deepStrictEqual(s.jobs, []);
  assert.deepStrictEqual(s.accountsSnapshot, []);
  assert.deepStrictEqual(s.log, []);
  assert.deepStrictEqual(s.projects, []);
  assert.strictEqual(s.jobSeq, 0);
});

test('_loadSync : config partielle fusionnée avec DEFAULT_CONFIG', (t) => {
  const { app, session } = setup(t, { 'config.json': { enabled: true, minDelayMs: 7 } });
  const s = new Scheduler(app, session);
  assert.strictEqual(s.config.enabled, true);
  assert.strictEqual(s.config.minDelayMs, 7);
  Object.keys(core.DEFAULT_CONFIG).forEach(k => {
    assert.ok(k in s.config, 'clé de config manquante : ' + k);
  });
});

test('_loadSync : jobSeq = plus grand job_N ; ids absents ou non conformes ignorés', (t) => {
  const { app, session } = setup(t, {
    'jobs.json': [
      { id: 'job_3' },
      { id: 'job_12' },
      { id: 'job_7' },
      { id: 'autre_99' },   // ne correspond pas au motif
      { id: 'job_abc' },    // idem
      {}                    // pas d'id
    ]
  });
  const s = new Scheduler(app, session);
  assert.strictEqual(s.jobSeq, 12);
});

test('_loadSync : projectSeq et taskSeq calculés, tâches absentes ou non conformes ignorées', (t) => {
  const { app, session } = setup(t, {
    'projects.json': [
      { id: 'proj_2', tasks: [{ id: 'task_4' }, { id: 'task_9' }, { id: 'bad' }, {}] },
      { id: 'proj_11', tasks: [{ id: 'task_3' }] },
      { id: 'proj_x', tasks: 'pas un tableau' },  // tasks non tableau -> ignoré
      { tasks: [{ id: 'task_5' }] },              // pas d'id de projet, tâches valides
      { id: 'proj_1' }                            // pas de tasks
    ]
  });
  const s = new Scheduler(app, session);
  assert.strictEqual(s.projectSeq, 11);
  assert.strictEqual(s.taskSeq, 9);
});

// --- init() ---------------------------------------------------------------

test('init : surveille chaque profil du snapshot et journalise (ordonnanceur désactivé)', (t) => {
  const { app, session, partitions } = setup(t, {
    'accounts-snapshot.json': [
      { id: 'a1', profile: 'profil_1' },
      { id: 'a2', profile: 'profil_2' }
    ],
    'config.json': { enabled: false }
  });
  const s = new Scheduler(app, session);
  s.init();
  assert.deepStrictEqual(partitions, ['persist:profil_1', 'persist:profil_2']);
  assert.ok(s.watchedPartitions.has('profil_1'));
  assert.ok(s.watchedPartitions.has('profil_2'));
  const last = s.log[s.log.length - 1];
  assert.match(last.message, /Ordonnanceur démarré \(désactivé\)\./);
});

test('init : message « activé » quand la configuration est activée', (t) => {
  const { app, session } = setup(t, { 'config.json': { enabled: true } });
  const s = new Scheduler(app, session);
  s.init();
  const last = s.log[s.log.length - 1];
  assert.match(last.message, /Ordonnanceur démarré \(activé\)\./);
});

test('init : sans compte, aucune partition surveillée', (t) => {
  const { app, session, partitions } = setup(t);
  const s = new Scheduler(app, session);
  s.init();
  assert.deepStrictEqual(partitions, []);
  assert.strictEqual(s.watchedPartitions.size, 0);
});

// --- _persistAccounts -----------------------------------------------------

test('_persistAccounts : écrit l\'instantané des comptes en JSON', (t) => {
  const { app, session } = setup(t);
  const s = new Scheduler(app, session);
  s.accountsSnapshot = [{ id: 'a1', profile: 'profil_1', name: 'Alice' }];
  s._persistAccounts();
  const written = JSON.parse(fs.readFileSync(s.accountsPath, 'utf-8'));
  assert.deepStrictEqual(written, s.accountsSnapshot);
});

test('_persistAccounts : un instantané persisté est relu au chargement suivant', (t) => {
  const { app, session } = setup(t);
  const s1 = new Scheduler(app, session);
  s1.accountsSnapshot = [{ id: 'a9', profile: 'profil_9' }];
  s1._persistAccounts();
  const s2 = new Scheduler(app, session);
  assert.deepStrictEqual(s2.accountsSnapshot, [{ id: 'a9', profile: 'profil_9' }]);
});

test('_persistAccounts : un échec d\'écriture est journalisé sans lever d\'exception', (t) => {
  const { app, session, errors } = setup(t);
  const s = new Scheduler(app, session);
  // Le chemin cible est un dossier : writeFileSync échoue (EISDIR).
  s.accountsPath = s.dir;
  assert.doesNotThrow(() => s._persistAccounts());
  assert.strictEqual(errors.length, 1);
  assert.match(String(errors[0][0]), /échec écriture instantané comptes/);
});
