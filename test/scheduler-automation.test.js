'use strict';

// test/scheduler-automation.test.js — Tests de l'automatisation Claude
// (lot 18/09/2026). Teste _executeAutomation, _failJob, _pollClaudeResponse
// et executeTask avec des mocks de webContents.
// Invariant 11 : toute fonction pure va dans lib/ ou scheduler/core.js.

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const { Scheduler } = require('../scheduler/index');

// --- Mock d'app Electron --------------------------------------------------

function createMockApp() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iao-test-'));
  return {
    getPath: function(name) {
      if (name === 'userData') return tmpDir;
      return tmpDir;
    },
    _tmpDir: tmpDir
  };
}

function createMockWebContents() {
  var self = {
    _scripts: [],
    _injectedResults: [],
    _nextResult: null,
    debugger: {
      _attached: false,
      attach: async function(protocol) { this._attached = true; },
      detach: async function() { this._attached = false; },
      sendCommand: async function(cmd, params) {
        if (cmd === 'DOM.getDocument') return { root: { nodeId: 1 } };
        if (cmd === 'DOM.querySelector') return { nodeId: 2 };
        if (cmd === 'DOM.setFileInputFiles') return {};
        return {};
      }
    },
    executeJavaScript: async function(script) {
      self._scripts.push(script);
      if (self._nextResult) {
        var r = self._nextResult;
        self._nextResult = null;
        return r;
      }
      // Résultat par défaut : détection réussie, pas de quota
      return JSON.stringify({
        continueButton: { found: true, selector: '[data-testid="continue-button"]' },
        downloadButton: { found: false },
        newChatButton: { found: true, selector: '[data-testid="new-chat"]' },
        chatInput: { found: true, selector: '[data-testid="chat-input"]' },
        fileUpload: { found: true, selector: 'input[type="file"]' },
        sendButton: { found: true, selector: '[data-testid="send-button"]' },
        assistantMessages: { count: 1 },
        quotaMessage: { detected: false },
        popups: { count: 0 }
      });
    },
    setResult: function(result) { self._nextResult = result; }
  };
  return self;
}

// Rend les tests d'automatisation déterministes quelle que soit l'heure
// d'exécution : force « hors heures calmes ». Sans cela, un `npm test` lancé
// entre 15h00 et 20h30 (heure de Paris) échouait sur 3 tests (runClaudeJob
// renvoie quiet_hours, executeTask ne passe pas en RUNNING) — trouvé par le
// build Electron réel du 18/09/2026 (voir CHANGES.md).
function disableQuietHours(scheduler) {
  scheduler.quietHoursCheck = function() { return false; };
}

// Nettoyage après chaque test
function cleanup(scheduler) {
  try {
    var dir = scheduler.dir;
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  } catch (_) {}
}

// --- Tests ----------------------------------------------------------------

test('Scheduler peut être instancié avec un mock app', () => {
  var app = createMockApp();
  var scheduler = new Scheduler(app, {});
  assert.ok(scheduler);
  assert.strictEqual(scheduler.jobs.length, 0);
  assert.strictEqual(scheduler.projects.length, 0);
  assert.ok(scheduler._openWebviews instanceof Map);
  cleanup(scheduler);
});

test('registerWebview enregistre un webContents par profil', () => {
  var app = createMockApp();
  var scheduler = new Scheduler(app, {});
  var wc = createMockWebContents();
  scheduler.registerWebview('profil_1', wc);
  assert.ok(scheduler._openWebviews.get('profil_1') === wc);
  scheduler.unregisterWebview('profil_1');
  assert.ok(!scheduler._openWebviews.has('profil_1'));
  cleanup(scheduler);
});

// Correctif du lot « test Electron réel du 18/09/2026 » : sur Electron 43,
// guestContents.getWebPreferences() renvoie undefined pour un guest, l'ancien
// câblage (lecture directe de la partition) n'enregistrait donc AUCUNE webview.
// Le profil est désormais résolu par comparaison de session.
test('resolveProfileFromSession identifie le profil d\'une webview par sa session', () => {
  var app = createMockApp();
  var scheduler = new Scheduler(app, {});
  // Simule les sessions persist: par profil (le module session réel d'Electron
  // n'est pas disponible sous node --test ; en réel, ce chemin est couvert par
  // test-electron/popups-continue.js — test B4).
  var sessions = {
    'persist:profil_1': { fake: 'session-profil_1' },
    'persist:profil_2': { fake: 'session-profil_2' }
  };
  scheduler._session = { fromPartition: function(p) { return sessions[p] || null; } };
  scheduler.accountsSnapshot = [
    { id: 'a1', profile: 'profil_1' },
    { id: 'a2', profile: 'profil_2' }
  ];

  assert.ok(scheduler.resolveProfileFromSession(sessions['persist:profil_1']) === 'profil_1');
  assert.ok(scheduler.resolveProfileFromSession(sessions['persist:profil_2']) === 'profil_2');
  // Session inconnue -> null (webview non enregistrée)
  assert.ok(scheduler.resolveProfileFromSession({ fake: 'inconnue' }) === null);
  assert.ok(scheduler.resolveProfileFromSession(null) === null);
  // Un profil connu uniquement via watchedPartitions est aussi résolu
  scheduler.watchedPartitions.add('profil_3');
  sessions['persist:profil_3'] = { fake: 'session-profil_3' };
  assert.ok(scheduler.resolveProfileFromSession(sessions['persist:profil_3']) === 'profil_3');
  cleanup(scheduler);
});
test('diagnoseClaudePage exécute le script de détection', async () => {
  var app = createMockApp();
  var scheduler = new Scheduler(app, {});
  var wc = createMockWebContents();
  scheduler.registerWebview('profil_1', wc);

  var result = await scheduler.diagnoseClaudePage('profil_1');
  assert.ok(result);
  assert.ok(result.chatInput);
  assert.ok(result.chatInput.found);
  assert.ok(wc._scripts.length > 0);
  cleanup(scheduler);
});

test('diagnoseClaudePage renvoie une erreur sans webview', async () => {
  var app = createMockApp();
  var scheduler = new Scheduler(app, {});
  var result = await scheduler.diagnoseClaudePage('inexistant');
  assert.ok(result.error);
  cleanup(scheduler);
});

test('runClaudeJob exécute la séquence détection-upload-injection', async () => {
  var app = createMockApp();
  var scheduler = new Scheduler(app, {});
  disableQuietHours(scheduler);
  scheduler.setConfig({ minDelayMs: 0, maxDelayMs: 0 });
  var wc = createMockWebContents();
  scheduler.registerWebview('profil_1', wc);

  // Simuler les résultats successifs des scripts injectés
  var callCount = 0;
  wc.executeJavaScript = async function(script) {
    callCount++;
    if (callCount === 1) {
      // 1. Détection
      return JSON.stringify({
        chatInput: { found: true, selector: '[data-testid="chat-input"]' },
        fileUpload: { found: true, selector: 'input[type="file"]' },
        sendButton: { found: true, selector: '[data-testid="send-button"]' },
        quotaMessage: { detected: false },
        popups: { count: 0 }
      });
    }
    if (callCount === 2) {
      // 2. Upload script
      return JSON.stringify({ ok: true, selector: 'input[type="file"]', accept: '' });
    }
    if (callCount === 3) {
      // 3. Injection du prompt
      return JSON.stringify({ ok: true, method: 'textarea' });
    }
    return JSON.stringify({ ok: true });
  };

  var result = await scheduler.runClaudeJob('profil_1', 'Test prompt', null);
  assert.ok(result);
  assert.ok(result.ok || result.method);
  cleanup(scheduler);
});

test('runClaudeJob détecte le quota et annule', async () => {
  var app = createMockApp();
  var scheduler = new Scheduler(app, {});
  disableQuietHours(scheduler);
  var wc = createMockWebContents();
  scheduler.registerWebview('profil_1', wc);

  // Le premier appel (détection) renvoie un quota détecté
  wc.setResult(JSON.stringify({
    chatInput: { found: true },
    quotaMessage: { detected: true, time: '20:30' },
    popups: { count: 0 }
  }));

  var result = await scheduler.runClaudeJob('profil_1', 'Test', null);
  assert.ok(result.error);
  assert.strictEqual(result.error, 'quota_exhausted');
  assert.strictEqual(result.quotaTime, '20:30');
  cleanup(scheduler);
});

test('_failJob passe un job en ERROR et met à jour la tâche', () => {
  var app = createMockApp();
  var scheduler = new Scheduler(app, {});

  // Créer un projet avec une tâche assignée
  scheduler.createProject('Projet test', []);
  var project = scheduler.projects[0];
  scheduler.createTask(project.id, 'Fais ceci', null);
  var task = project.tasks[0];
  task.assignedProfile = 'profil_1';
  task.status = 'running';

  // Créer un job RUNNING
  scheduler.jobSeq = 1;
  var core = require('../scheduler/core');
  var job = core.buildJobRecord({
    id: 'job_001',
    projectId: project.id,
    profile: 'profil_1',
    status: 'RUNNING'
  });
  scheduler.jobs.push(job);

  // Marquer comme échoué
  scheduler._failJob(job, 'Test d\'erreur');

  assert.strictEqual(job.status, 'ERROR');
  assert.strictEqual(job.errorReason, 'Test d\'erreur');
  assert.strictEqual(task.status, 'failed');
  cleanup(scheduler);
});

test('_pollClaudeResponse poll jusqu\'à obtenir une réponse', async () => {
  var app = createMockApp();
  var scheduler = new Scheduler(app, {});
  var wc = createMockWebContents();
  scheduler.registerWebview('profil_1', wc);

  var callCount = 0;
  wc.executeJavaScript = async function() {
    callCount++;
    if (callCount < 3) {
      // Pas encore de réponse
      return JSON.stringify({ ok: true, response: null });
    }
    // 3e appel : réponse disponible
    return JSON.stringify({ ok: true, response: 'Voici la réponse de Claude.' });
  };

  // Poll avec timeout court et intervalle court pour le test
  var result = await scheduler._pollClaudeResponse('profil_1', 5000, 100);
  assert.ok(result.ok);
  assert.ok(result.response);
  assert.ok(result.response.indexOf('Voici la réponse') !== -1);
  cleanup(scheduler);
});

test('_pollClaudeResponse renvoie ok:false après timeout', async () => {
  var app = createMockApp();
  var scheduler = new Scheduler(app, {});
  var wc = createMockWebContents();
  scheduler.registerWebview('profil_1', wc);

  // Toujours renvoyer null (pas de réponse)
  wc.executeJavaScript = async function() {
    return JSON.stringify({ ok: true, response: null });
  };

  var result = await scheduler._pollClaudeResponse('profil_1', 500, 100);
  assert.ok(!result.ok);
  cleanup(scheduler);
});

test('executeTask crée un job et lance l\'automatisation', async () => {
  var app = createMockApp();
  var scheduler = new Scheduler(app, {});
  disableQuietHours(scheduler);
  scheduler.setConfig({ enabled: true, maxConcurrentJobs: 2, minDelayBetweenAutomationsMinutes: 0, minDelayMs: 0, maxDelayMs: 0, responseTimeoutMs: 5000, responsePollIntervalMs: 150 });

  // Créer un projet + tâche
  scheduler.createProject('Projet auto', []);
  var project = scheduler.projects[0];
  scheduler.createTask(project.id, 'Génère un rapport', null);
  var task = project.tasks[0];
  task.assignedProfile = 'profil_1';
  task.status = 'assigned';

  // Enregistrer une webview mockée
  var wc = createMockWebContents();
  scheduler.registerWebview('profil_1', wc);

  // Mock: tous les scripts renvoient succès
  var callCount = 0;
  var callCount = 0;
  wc.executeJavaScript = async function() {
    callCount++;
    // BASELINE avant l'envoi (appel 1), puis diagnostic, injection, réponse.
    if (callCount === 1) return JSON.stringify({ ok: true, response: 'Ancienne réponse du tour précédent', streaming: false });
    if (callCount === 2) {
      return JSON.stringify({
        chatInput: { found: true }, fileUpload: { found: false },
        sendButton: { found: true }, quotaMessage: { detected: false },
        popups: { count: 0 }
      });
    }
    if (callCount === 3) {
      return JSON.stringify({ ok: true, method: 'textarea' });
    }
    return JSON.stringify({ ok: true, response: 'Résultat de Claude', streaming: false });
  };

  var result = await scheduler.executeTask(project.id, task.id);
  assert.ok(result.ok);
  assert.ok(result.job);
  assert.strictEqual(result.job.status, 'RUNNING');

  // Attendre que l'async se termine (poll rapide : 2 lectures stables)
  await new Promise(function(r) { setTimeout(r, 2000); });

  // Le job devrait être DELIVERED
  var job = scheduler.jobs.find(function(j) { return j.id === result.job.id; });
  assert.ok(job);
  assert.strictEqual(job.status, 'DELIVERED');
  assert.ok(job.response);
  assert.ok(job.response.indexOf('Résultat de Claude') !== -1);

  // La tâche devrait être completed
  var updatedTask = scheduler.projects[0].tasks[0];
  assert.strictEqual(updatedTask.status, 'completed');

  cleanup(scheduler);
});

test('executeTask échoue sans webview ouverte', async () => {
  var app = createMockApp();
  var scheduler = new Scheduler(app, {});
  scheduler.setConfig({ enabled: true, maxConcurrentJobs: 2, minDelayBetweenAutomationsMinutes: 0, minDelayMs: 0, maxDelayMs: 0 });

  scheduler.createProject('Projet test', []);
  var project = scheduler.projects[0];
  scheduler.createTask(project.id, 'Test', null);
  var task = project.tasks[0];
  task.assignedProfile = 'profil_1';
  task.status = 'assigned';

  // Pas de webview enregistrée
  var result = await scheduler.executeTask(project.id, task.id);
  assert.ok(!result.ok);
  assert.ok(result.error);
  assert.ok(result.error.indexOf('webview') !== -1);

  cleanup(scheduler);
});

test('collectClaudeResponse exécute le script de collecte', async () => {
  var app = createMockApp();
  var scheduler = new Scheduler(app, {});
  var wc = createMockWebContents();
  scheduler.registerWebview('profil_1', wc);

  wc.setResult(JSON.stringify({ ok: true, response: 'Réponse collectée' }));

  var result = await scheduler.collectClaudeResponse('profil_1');
  assert.ok(result.ok);
  assert.strictEqual(result.response, 'Réponse collectée');
  cleanup(scheduler);
});

// --- Heures calmes (15h-20h30 Paris) — déterminisme et report -------------
// Ces tests couvrent le correctif du 18/09/2026 : avant, un `npm test` lancé
// pendant la pause parisienne échouait (3 tests) et ne terminait jamais (le
// setTimeout de report retenait le process). Voir CHANGES.md, lot « test
// Electron réel du zip livré ».

test('runClaudeJob renvoie quiet_hours pendant la pause 15h-20h30 Paris', async () => {
  var app = createMockApp();
  var scheduler = new Scheduler(app, {});
  // Force « heures calmes actives » (peu importe l'heure réelle)
  scheduler.quietHoursCheck = function() { return true; };
  scheduler.quietHoursRemainingMs = function() { return 60000; };
  var wc = createMockWebContents();
  scheduler.registerWebview('profil_1', wc);

  var result = await scheduler.runClaudeJob('profil_1', 'Test', null);
  assert.strictEqual(result.error, 'quiet_hours');
  assert.strictEqual(result.waitMs, 60000);
  cleanup(scheduler);
});

test('_executeAutomation reporte le job pendant les heures calmes (sans RUNNING, timer unref)', async () => {
  var app = createMockApp();
  var scheduler = new Scheduler(app, {});
  scheduler.quietHoursCheck = function() { return true; };
  scheduler.quietHoursRemainingMs = function() { return 60000; };

  var core = require('../scheduler/core');
  var job = core.buildJobRecord({ id: 'job_001', profile: 'profil_1', status: 'RESUME_REQUIRED' });
  scheduler.jobs.push(job);

  // Pendant la pause : le job est REPORTÉ (il reste RESUME_REQUIRED, aucun
  // lancement), et le timer de reprise ne retient pas le process (unref).
  var before = job.started_at;
  await scheduler._executeAutomation(job);
  assert.strictEqual(job.status, 'RESUME_REQUIRED');
  assert.strictEqual(job.started_at, before); // jamais démarré
  assert.ok(!scheduler.log.some(function(e) {
    return e.message.indexOf('lancement de l\'automatisation') !== -1;
  }));
  assert.ok(scheduler.log.some(function(e) {
    return e.message.indexOf('heures calmes') !== -1;
  }));
  cleanup(scheduler);
});

// --- #206 lot 2 : les événements stats (quota, temps de réponse) sont notés ---

test('runClaudeJob : quota détecté -> événement noté dans statsStore (jamais bloquant)', async () => {
  var app = createMockApp();
  var scheduler = new Scheduler(app, {});
  disableQuietHours(scheduler);
  var wc = createMockWebContents();
  scheduler.registerWebview('profil_1', wc);
  var notations = [];
  scheduler.statsStore = {
    noterQuota: async (e) => { notations.push(['quota', e]); return { ok: true }; },
    noterReponse: async (e) => { notations.push(['reponse', e]); return { ok: true }; }
  };
  // Diagnostic de page : quota détecté.
  wc.executeJavaScript = async function() {
    return JSON.stringify({
      chatInput: { found: true }, fileUpload: { found: false },
      sendButton: { found: true }, quotaMessage: { detected: true, time: '18:30' },
      popups: { count: 0 }
    });
  };
  var res = await scheduler.runClaudeJob('profil_1', 'Fais un résumé', null);
  assert.strictEqual(res.error, 'quota_exhausted');
  assert.strictEqual(res.quotaTime, '18:30');
  assert.strictEqual(notations.length, 1);
  assert.strictEqual(notations[0][0], 'quota');
  assert.strictEqual(notations[0][1].profil, 'profil_1');
  assert.strictEqual(notations[0][1].service, 'claude');
  assert.ok(Number.isFinite(notations[0][1].date));
  // Sans statsStore : aucun levée (le chemin reste couvert).
  scheduler.statsStore = null;
  var res2 = await scheduler.runClaudeJob('profil_1', 'Fais un résumé', null);
  assert.strictEqual(res2.error, 'quota_exhausted');
  cleanup(scheduler);
});

test('_executeAutomation : réponse collectée -> temps de réponse noté (statsStore)', async () => {
  var app = createMockApp();
  var scheduler = new Scheduler(app, {});
  disableQuietHours(scheduler);
  // Délais de poll injectables (config) : tests rapides et déterministes.
  scheduler.setConfig({ enabled: true, maxConcurrentJobs: 2, minDelayBetweenAutomationsMinutes: 0, minDelayMs: 0, maxDelayMs: 0, responseTimeoutMs: 5000, responsePollIntervalMs: 150 });
  var notations = [];
  scheduler.statsStore = {
    noterQuota: async () => ({ ok: true }),
    noterReponse: async (e) => { notations.push(e); return { ok: true }; }
  };
  scheduler.createProject('Projet stats', []);
  var project = scheduler.projects[0];
  scheduler.createTask(project.id, 'Génère un rapport', null);
  var task = project.tasks[0];
  task.assignedProfile = 'profil_1';
  task.status = 'assigned';
  var wc = createMockWebContents();
  scheduler.registerWebview('profil_1', wc);
  var callCount = 0;
  wc.executeJavaScript = async function() {
    callCount++;
    // Appel 1 : BASELINE capturée AVANT l'envoi (réponse du tour précédent,
    // génération terminée). Puis diagnostic, injection, et la nouvelle réponse
    // — disponible immédiatement (réponse rapide) : c'est le cas qui
    // échouerait si la baseline était capturée APRÈS l'envoi.
    if (callCount === 1) return JSON.stringify({ ok: true, response: 'Ancienne réponse du tour précédent', streaming: false });
    if (callCount === 2) {
      return JSON.stringify({
        chatInput: { found: true }, fileUpload: { found: false },
        sendButton: { found: true }, quotaMessage: { detected: false },
        popups: { count: 0 }
      });
    }
    if (callCount === 3) return JSON.stringify({ ok: true, method: 'textarea' });
    return JSON.stringify({ ok: true, response: 'Résultat de Claude', streaming: false });
  };
  var result = await scheduler.executeTask(project.id, task.id);
  assert.ok(result.ok);
  // Réponse rapide : acceptée dès le premier poll (150 ms) — génération finie.
  await new Promise(function(r) { setTimeout(r, 1200); });
  var job = scheduler.jobs.find(function(j) { return j.id === result.job.id; });
  assert.strictEqual(job.status, 'DELIVERED');
  assert.strictEqual(notations.length, 1, 'une mesure de temps de réponse');
  assert.strictEqual(notations[0].profil, 'profil_1');
  assert.strictEqual(notations[0].service, 'claude');
  assert.ok(Number.isFinite(notations[0].debut));
  assert.ok(notations[0].fin >= notations[0].debut);
  cleanup(scheduler);
});

test('_executeAutomation : ancienne réponse + texte qui croît -> une seule mesure, sur le texte final', async () => {
  var app = createMockApp();
  var scheduler = new Scheduler(app, {});
  disableQuietHours(scheduler);
  scheduler.setConfig({ enabled: true, maxConcurrentJobs: 2, minDelayBetweenAutomationsMinutes: 0, minDelayMs: 0, maxDelayMs: 0, responseTimeoutMs: 5000, responsePollIntervalMs: 150 });
  var notations = [];
  scheduler.statsStore = {
    noterQuota: async () => ({ ok: true }),
    noterReponse: async (e) => { notations.push(e); return { ok: true }; }
  };
  scheduler.createProject('Projet stats', []);
  var project = scheduler.projects[0];
  scheduler.createTask(project.id, 'Génère un rapport', null);
  var task = project.tasks[0];
  task.assignedProfile = 'profil_1';
  task.status = 'assigned';
  var wc = createMockWebContents();
  scheduler.registerWebview('profil_1', wc);
  // Séquence : BASELINE (ancienne réponse, appel 1), diagnostic, envoi, puis
  // un texte qui CROÎT avec data-is-streaming présent (génération en cours —
  // une PAUSE de génération garde l'attribut), avant la fin signalée.
  var lectures = [
    JSON.stringify({ ok: true, response: 'Réponse en cou', streaming: true }),
    JSON.stringify({ ok: true, response: 'Réponse en cours (part', streaming: true }), // pause : texte identique, toujours streaming
    JSON.stringify({ ok: true, response: 'Réponse en cours (part', streaming: true }),
    JSON.stringify({ ok: true, response: 'Résultat complet du nouveau tour.', streaming: false })
  ];
  var appel = 0;
  wc.executeJavaScript = async function() {
    appel++;
    if (appel === 1) return JSON.stringify({ ok: true, response: 'Ancienne réponse du tour précédent', streaming: false });
    if (appel === 2) {
      return JSON.stringify({
        chatInput: { found: true }, fileUpload: { found: false },
        sendButton: { found: true }, quotaMessage: { detected: false },
        popups: { count: 0 }
      });
    }
    if (appel === 3) return JSON.stringify({ ok: true, method: 'textarea' });
    return lectures[Math.min(appel - 4, lectures.length - 1)];
  };
  var result = await scheduler.executeTask(project.id, task.id);
  assert.ok(result.ok);
  await new Promise(function(r) { setTimeout(r, 2000); });
  var job = scheduler.jobs.find(function(j) { return j.id === result.job.id; });
  assert.strictEqual(job.status, 'DELIVERED');
  // Une SEULE mesure, sur le texte final avec génération terminée — ni
  // l'ancienne réponse ni le texte partiel/pausing ne comptent.
  assert.strictEqual(notations.length, 1, 'une seule mesure, sur la réponse terminée');
  assert.strictEqual(job.response, 'Résultat complet du nouveau tour.');
  assert.ok(notations[0].fin >= notations[0].debut);
  cleanup(scheduler);
});

test('_executeAutomation : réponse > 5 000 caractères encore en génération -> pas de mesure hâtive', async () => {
  var app = createMockApp();
  var scheduler = new Scheduler(app, {});
  disableQuietHours(scheduler);
  scheduler.setConfig({ enabled: true, maxConcurrentJobs: 2, minDelayBetweenAutomationsMinutes: 0, minDelayMs: 0, maxDelayMs: 0, responseTimeoutMs: 5000, responsePollIntervalMs: 150 });
  var notations = [];
  scheduler.statsStore = {
    noterQuota: async () => ({ ok: true }),
    noterReponse: async (e) => { notations.push(e); return { ok: true }; }
  };
  scheduler.createProject('Projet stats', []);
  var project = scheduler.projects[0];
  scheduler.createTask(project.id, 'Génère un rapport', null);
  var task = project.tasks[0];
  task.assignedProfile = 'profil_1';
  task.status = 'assigned';
  var wc = createMockWebContents();
  scheduler.registerWebview('profil_1', wc);
  // Le préfixe de 5 000 caractères est IDENTIQUE sur deux lectures (la
  // troncature du script de collecte masquerait la suite) mais la génération
  // continue : sans le signal streaming, la mesure serait hâtive.
  var prefixe = new Array(5001).join('a');
  var appel = 0;
  wc.executeJavaScript = async function() {
    appel++;
    if (appel === 1) return JSON.stringify({ ok: true, response: 'Ancienne réponse du tour précédent', streaming: false });
    if (appel === 2) {
      return JSON.stringify({
        chatInput: { found: true }, fileUpload: { found: false },
        sendButton: { found: true }, quotaMessage: { detected: false },
        popups: { count: 0 }
      });
    }
    if (appel === 3) return JSON.stringify({ ok: true, method: 'textarea' });
    if (appel === 4 || appel === 5) return JSON.stringify({ ok: true, response: prefixe, streaming: true });
    return JSON.stringify({ ok: true, response: prefixe, streaming: false });
  };
  var result = await scheduler.executeTask(project.id, task.id);
  assert.ok(result.ok);
  await new Promise(function(r) { setTimeout(r, 2000); });
  var job = scheduler.jobs.find(function(j) { return j.id === result.job.id; });
  assert.strictEqual(job.status, 'DELIVERED');
  // Mesure prise seulement à la fin signalée, pas sur le préfixe stable.
  assert.strictEqual(notations.length, 1);
  assert.ok(notations[0].fin >= notations[0].debut);
  cleanup(scheduler);
});

test('_executeAutomation : aucune réponse nouvelle -> délai dépassé, AUCUNE mesure', async () => {
  var app = createMockApp();
  var scheduler = new Scheduler(app, {});
  disableQuietHours(scheduler);
  scheduler.setConfig({ enabled: true, maxConcurrentJobs: 2, minDelayBetweenAutomationsMinutes: 0, minDelayMs: 0, maxDelayMs: 0, responseTimeoutMs: 600, responsePollIntervalMs: 100 });
  var notations = [];
  scheduler.statsStore = {
    noterQuota: async () => ({ ok: true }),
    noterReponse: async (e) => { notations.push(e); return { ok: true }; }
  };
  scheduler.createProject('Projet stats', []);
  var project = scheduler.projects[0];
  scheduler.createTask(project.id, 'Génère un rapport', null);
  var task = project.tasks[0];
  task.assignedProfile = 'profil_1';
  task.status = 'assigned';
  var wc = createMockWebContents();
  scheduler.registerWebview('profil_1', wc);
  var callCount = 0;
  wc.executeJavaScript = async function() {
    callCount++;
    if (callCount === 1) return JSON.stringify({ ok: true, response: 'Ancienne réponse du tour précédent', streaming: false });
    if (callCount === 2) {
      return JSON.stringify({
        chatInput: { found: true }, fileUpload: { found: false },
        sendButton: { found: true }, quotaMessage: { detected: false },
        popups: { count: 0 }
      });
    }
    if (callCount === 3) return JSON.stringify({ ok: true, method: 'textarea' });
    // Rien de nouveau : la réponse collectée reste celle d'avant l'envoi.
    return JSON.stringify({ ok: true, response: 'Ancienne réponse du tour précédent', streaming: false });
  };
  var result = await scheduler.executeTask(project.id, task.id);
  assert.ok(result.ok);
  // Timeout court (600 ms) : le poll expire sans nouveau texte.
  await new Promise(function(r) { setTimeout(r, 1500); });
  var job = scheduler.jobs.find(function(j) { return j.id === result.job.id; });
  // Le job est livré (DELIVERED) mais AUCUNE mesure de temps de réponse :
  // un délai dépassé ne produit jamais un « temps de réponse réussi ».
  assert.strictEqual(job.status, 'DELIVERED');
  assert.strictEqual(notations.length, 0, 'aucune mesure quand le délai est dépassé');
  assert.ok(scheduler.log.some(function(e) {
    return e.message.indexOf('pas de réponse collectée') !== -1;
  }));
  cleanup(scheduler);
});

test('_executeAutomation : réponse partielle jamais stabilisée -> délai dépassé, aucune mesure', async () => {
  var app = createMockApp();
  var scheduler = new Scheduler(app, {});
  disableQuietHours(scheduler);
  scheduler.setConfig({ enabled: true, maxConcurrentJobs: 2, minDelayBetweenAutomationsMinutes: 0, minDelayMs: 0, maxDelayMs: 0, responseTimeoutMs: 600, responsePollIntervalMs: 100 });
  var notations = [];
  scheduler.statsStore = {
    noterQuota: async () => ({ ok: true }),
    noterReponse: async (e) => { notations.push(e); return { ok: true }; }
  };
  scheduler.createProject('Projet stats', []);
  var project = scheduler.projects[0];
  scheduler.createTask(project.id, 'Génère un rapport', null);
  var task = project.tasks[0];
  task.assignedProfile = 'profil_1';
  task.status = 'assigned';
  var wc = createMockWebContents();
  scheduler.registerWebview('profil_1', wc);
  var callCount = 0;
  var callCount = 0;
  wc.executeJavaScript = async function() {
    callCount++;
    // BASELINE avant l'envoi (appel 1), puis diagnostic, injection, et une
    // génération en cours jusqu'au bout du délai (streaming jamais terminé).
    if (callCount === 1) return JSON.stringify({ ok: true, response: 'Ancienne réponse du tour précédent', streaming: false });
    if (callCount === 2) {
      return JSON.stringify({
        chatInput: { found: true }, fileUpload: { found: false },
        sendButton: { found: true }, quotaMessage: { detected: false },
        popups: { count: 0 }
      });
    }
    if (callCount === 3) return JSON.stringify({ ok: true, method: 'textarea' });
    return JSON.stringify({ ok: true, response: 'Réponse partielle n°' + callCount, streaming: true });
  };
  var result = await scheduler.executeTask(project.id, task.id);
  assert.ok(result.ok);
  await new Promise(function(r) { setTimeout(r, 1500); });
  var job = scheduler.jobs.find(function(j) { return j.id === result.job.id; });
  assert.strictEqual(job.status, 'DELIVERED');
  assert.strictEqual(notations.length, 0, 'un texte en génération continue n’est jamais mesuré');
  cleanup(scheduler);
});

test('runClaudeJob : statsStore qui rejette n’empêche rien (catch des hooks)', async () => {
  var app = createMockApp();
  var scheduler = new Scheduler(app, {});
  disableQuietHours(scheduler);
  var wc = createMockWebContents();
  scheduler.registerWebview('profil_1', wc);
  // noterQuota rejette : le .catch(() => {}) du hook avale, aucun impact.
  scheduler.statsStore = {
    noterQuota: async () => { throw new Error('disque plein (test)'); },
    noterReponse: async () => { throw new Error('disque plein (test)'); }
  };
  wc.executeJavaScript = async function() {
    return JSON.stringify({
      chatInput: { found: true }, fileUpload: { found: false },
      sendButton: { found: true }, quotaMessage: { detected: true, time: '18:30' },
      popups: { count: 0 }
    });
  };
  var res = await scheduler.runClaudeJob('profil_1', 'Fais un résumé', null);
  assert.strictEqual(res.error, 'quota_exhausted');
  // Unhandled rejection ne fait pas échouer le test : le catch a bien avalé.
  await new Promise(function(r) { setTimeout(r, 50); });
  cleanup(scheduler);
});

test('_executeAutomation : statsStore qui rejette ne bloque pas la livraison', async () => {
  var app = createMockApp();
  var scheduler = new Scheduler(app, {});
  disableQuietHours(scheduler);
  scheduler.setConfig({ enabled: true, maxConcurrentJobs: 2, minDelayBetweenAutomationsMinutes: 0, minDelayMs: 0, maxDelayMs: 0, responseTimeoutMs: 5000, responsePollIntervalMs: 150 });
  // noterReponse rejette : le .catch(() => {}) du hook avale, la livraison continue.
  scheduler.statsStore = {
    noterReponse: async () => { throw new Error('disque plein (test)'); }
  };
  scheduler.createProject('Projet stats rejet', []);
  var project = scheduler.projects[0];
  scheduler.createTask(project.id, 'Génère un rapport', null);
  var task = project.tasks[0];
  task.assignedProfile = 'profil_1';
  task.status = 'assigned';
  var wc = createMockWebContents();
  scheduler.registerWebview('profil_1', wc);
  var callCount = 0;
  var callCount = 0;
  wc.executeJavaScript = async function() {
    callCount++;
    // BASELINE avant l'envoi (appel 1), puis diagnostic, injection, réponse.
    if (callCount === 1) return JSON.stringify({ ok: true, response: 'Ancienne réponse du tour précédent', streaming: false });
    if (callCount === 2) {
      return JSON.stringify({
        chatInput: { found: true }, fileUpload: { found: false },
        sendButton: { found: true }, quotaMessage: { detected: false },
        popups: { count: 0 }
      });
    }
    if (callCount === 3) return JSON.stringify({ ok: true, method: 'textarea' });
    return JSON.stringify({ ok: true, response: 'Résultat de Claude', streaming: false });
  };
  var result = await scheduler.executeTask(project.id, task.id);
  assert.ok(result.ok);
  await new Promise(function(r) { setTimeout(r, 2000); });
  var job = scheduler.jobs.find(function(j) { return j.id === result.job.id; });
  assert.strictEqual(job.status, 'DELIVERED', 'la mesure qui échoue ne bloque pas la livraison');
  await new Promise(function(r) { setTimeout(r, 50); });
  cleanup(scheduler);
});
