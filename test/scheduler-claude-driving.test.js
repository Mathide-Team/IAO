'use strict';

// test/scheduler-claude-driving.test.js — Couverture du pilotage de Claude
// par scheduler/index.js (issue #90, tâche 55.21) : diagnoseClaudePage,
// runClaudeJob, _uploadFileViaCDP et collectClaudeResponse.
// Tout est simulé : app Electron (userData temporaire), webContents
// (executeJavaScript scripté) et debugger CDP. Aucun accès réseau.

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const { Scheduler } = require('../scheduler/index');
const adapter = require('../lib/claude-adapter');

// Scripts injectés par l'adaptateur : identifiés par valeur pour savoir à
// quelle étape du pilotage répond chaque appel à executeJavaScript.
const DETECT = adapter.buildClaudeDetectionScript();
const UPLOAD = adapter.buildFileUploadScript();
const DISMISS = adapter.buildPopupDismissScript();
const COLLECT = adapter.buildResponseCollectionScript();

const ZIP = 'C:/tmp/source.zip';
const SELECTOR = 'input[type="file"]';

// --- Outils de simulation ---------------------------------------------------

function createApp() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iao-drive-'));
  return { getPath: function() { return tmpDir; } };
}

function createScheduler() {
  const scheduler = new Scheduler(createApp(), {});
  // Hors heures calmes et sans délai anti-détection, quelle que soit l'heure.
  scheduler.quietHoursCheck = function() { return false; };
  scheduler.config.minDelayMs = 0;
  scheduler.config.maxDelayMs = 0;
  return scheduler;
}

function cleanup(scheduler) {
  try { fs.rmSync(scheduler.dir, { recursive: true, force: true }); } catch (_) {}
}

function logs(scheduler) {
  return scheduler.log.map(function(l) { return l.message; });
}

function hasLog(scheduler, fragment) {
  return logs(scheduler).some(function(m) { return m.indexOf(fragment) !== -1; });
}

// Résultat de détection : page saine par défaut, surchargeable.
function detection(overrides) {
  return Object.assign({
    continueButton: { found: false },
    downloadButton: { found: false },
    newChatButton: { found: true, selector: '[data-testid="new-chat"]' },
    chatInput: { found: true, selector: '[data-testid="chat-input"]' },
    fileUpload: { found: true, selector: SELECTOR },
    sendButton: { found: true, selector: '[data-testid="send-button"]' },
    assistantMessages: { count: 0 },
    quotaMessage: { detected: false },
    popups: { count: 0 }
  }, overrides || {});
}

// debugger CDP simulé qui enregistre les commandes reçues.
function createDebugger(opts) {
  const o = opts || {};
  const dbg = {
    calls: [],
    attached: false,
    attach: async function(protocol) {
      dbg.calls.push(['attach', protocol]);
      dbg.attached = true;
    },
    detach: async function() {
      dbg.calls.push(['detach']);
      dbg.attached = false;
      if (o.detachThrows) throw new Error('detach impossible');
    },
    sendCommand: async function(cmd, params) {
      dbg.calls.push([cmd, params]);
      if (cmd === 'DOM.getDocument') return { root: { nodeId: 1 } };
      if (cmd === 'DOM.querySelector') {
        if (Object.prototype.hasOwnProperty.call(o, 'node')) return o.node;
        return { nodeId: 2 };
      }
      return {};
    }
  };
  return dbg;
}

// webContents scripté. `detect` est consommé dans l'ordre (le dernier résultat
// est répété) ; upload/dismiss/collect/inject sont des valeurs ou des
// fonctions ; `throwOn` liste les étapes qui lèvent une erreur.
function createWebContents(opts) {
  const o = opts || {};
  const detects = (o.detect || [detection()]).slice();
  const wc = {
    scripts: [],
    debugger: Object.prototype.hasOwnProperty.call(o, 'debugger') ? o.debugger : createDebugger(),
    executeJavaScript: async function(script) {
      wc.scripts.push(script);
      let step = 'inject';
      if (script === DETECT) step = 'detect';
      else if (script === UPLOAD) step = 'upload';
      else if (script === DISMISS) step = 'dismiss';
      else if (script === COLLECT) step = 'collect';
      if (o.throwOn && o.throwOn.indexOf(step) !== -1) throw new Error('boom ' + step);
      if (step === 'detect') {
        const d = detects.length > 1 ? detects.shift() : detects[0];
        return typeof d === 'string' ? d : JSON.stringify(d);
      }
      const v = o[step];
      if (typeof v === 'function') return v();
      return v;
    },
    count: function(script) {
      return wc.scripts.filter(function(s) { return s === script; }).length;
    }
  };
  return wc;
}

function setup(wcOpts, schedulerTweaks) {
  const scheduler = createScheduler();
  if (schedulerTweaks) schedulerTweaks(scheduler);
  const wc = createWebContents(wcOpts);
  scheduler.registerWebview('profil_1', wc);
  return { scheduler: scheduler, wc: wc };
}

const OK_INJECT = JSON.stringify({ ok: true, method: 'paste' });

// --- diagnoseClaudePage -------------------------------------------------------

test('diagnoseClaudePage accepte un résultat objet et journalise quota et popups', async () => {
  const ctx = setup({ detect: [detection({ quotaMessage: { detected: true, time: '18:30' }, popups: { count: 2 } })] });
  ctx.wc.executeJavaScript = async function() {
    // Résultat déjà parsé (objet) : pas de JSON.parse.
    return detection({ quotaMessage: { detected: true, time: '18:30' }, popups: { count: 2 } });
  };
  const result = await ctx.scheduler.diagnoseClaudePage('profil_1');
  assert.strictEqual(result.quotaMessage.detected, true);
  assert.ok(hasLog(ctx.scheduler, 'quota détecté (18:30), 2 popup(s).'));
  cleanup(ctx.scheduler);
});

test('diagnoseClaudePage journalise « pas de quota » et 0 popup si le champ popups est absent', async () => {
  const ctx = setup({ detect: [{ quotaMessage: { detected: false } }] });
  const result = await ctx.scheduler.diagnoseClaudePage('profil_1');
  assert.strictEqual(result.quotaMessage.detected, false);
  assert.ok(hasLog(ctx.scheduler, 'pas de quota, 0 popup(s).'));
  cleanup(ctx.scheduler);
});

test('diagnoseClaudePage renvoie l\'erreur si executeJavaScript échoue', async () => {
  const ctx = setup({ throwOn: ['detect'] });
  const result = await ctx.scheduler.diagnoseClaudePage('profil_1');
  assert.deepStrictEqual(result, { error: 'boom detect' });
  assert.ok(hasLog(ctx.scheduler, 'Erreur diagnostic Claude (« profil_1 ») : boom detect'));
  cleanup(ctx.scheduler);
});

test('diagnoseClaudePage renvoie l\'erreur si la détection n\'est pas un JSON valide', async () => {
  const ctx = setup({ detect: ['ceci n\'est pas du JSON'] });
  const result = await ctx.scheduler.diagnoseClaudePage('profil_1');
  assert.ok(typeof result.error === 'string' && result.error.length > 0);
  cleanup(ctx.scheduler);
});

// --- runClaudeJob : détection, popups, blocages ---------------------------------

test('runClaudeJob sans webview ouverte renvoie une erreur', async () => {
  const scheduler = createScheduler();
  const result = await scheduler.runClaudeJob('absent', 'Prompt', null);
  assert.ok(result.error.indexOf('Aucune webview ouverte') === 0);
  cleanup(scheduler);
});

test('runClaudeJob remonte l\'erreur du diagnostic', async () => {
  const ctx = setup({ throwOn: ['detect'] });
  const result = await ctx.scheduler.runClaudeJob('profil_1', 'Prompt', null);
  assert.deepStrictEqual(result, { error: 'boom detect' });
  assert.strictEqual(ctx.wc.count(DISMISS), 0);
  cleanup(ctx.scheduler);
});

test('runClaudeJob ferme les popups, re-diagnostique puis injecte le prompt', async () => {
  const ctx = setup({
    detect: [detection({ popups: { count: 2 } }), detection()],
    dismiss: JSON.stringify({ ok: true }),
    inject: OK_INJECT
  });
  const result = await ctx.scheduler.runClaudeJob('profil_1', 'Mon prompt', null);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(ctx.wc.count(DETECT), 2, 'détection avant et après fermeture des popups');
  assert.strictEqual(ctx.wc.count(DISMISS), 1);
  assert.ok(hasLog(ctx.scheduler, 'Fermeture de 2 popup(s) Claude'));
  assert.ok(hasLog(ctx.scheduler, 'Prompt injecté dans Claude (« profil_1 ») via paste.'));
  cleanup(ctx.scheduler);
});

test('runClaudeJob renvoie l\'erreur du plan si la zone de chat est introuvable après les popups', async () => {
  const ctx = setup({
    detect: [detection({ popups: { count: 1 } }), detection({ chatInput: { found: false } })],
    dismiss: JSON.stringify({ ok: true })
  });
  const result = await ctx.scheduler.runClaudeJob('profil_1', 'Prompt', null);
  assert.deepStrictEqual(result, { error: 'element_not_found' });
  assert.ok(hasLog(ctx.scheduler, 'Job Claude bloqué : element_not_found (« profil_1 »).'));
  cleanup(ctx.scheduler);
});

test('runClaudeJob est bloqué directement si la zone de chat est introuvable', async () => {
  const ctx = setup({ detect: [detection({ chatInput: { found: false } })] });
  const result = await ctx.scheduler.runClaudeJob('profil_1', 'Prompt', ZIP);
  assert.deepStrictEqual(result, { error: 'element_not_found' });
  assert.strictEqual(ctx.wc.count(UPLOAD), 0, 'aucun upload quand le job est bloqué');
  cleanup(ctx.scheduler);
});

test('runClaudeJob renvoie no_action_taken si le quota apparaît après la fermeture des popups', async () => {
  const ctx = setup({
    detect: [detection({ popups: { count: 1 } }), detection({ quotaMessage: { detected: true, time: '20:00' } })],
    dismiss: JSON.stringify({ ok: true })
  });
  const result = await ctx.scheduler.runClaudeJob('profil_1', 'Prompt', null);
  assert.deepStrictEqual(result, { ok: false, error: 'no_action_taken' });
  assert.strictEqual(ctx.wc.scripts.length, 3, 'détection, fermeture, détection : rien n\'est injecté');
  cleanup(ctx.scheduler);
});

test('runClaudeJob journalise et renvoie l\'erreur si la fermeture des popups échoue', async () => {
  const ctx = setup({ detect: [detection({ popups: { count: 1 } })], throwOn: ['dismiss'] });
  const result = await ctx.scheduler.runClaudeJob('profil_1', 'Prompt', null);
  assert.deepStrictEqual(result, { error: 'boom dismiss' });
  assert.ok(hasLog(ctx.scheduler, 'Erreur job Claude (« profil_1 ») : boom dismiss'));
  cleanup(ctx.scheduler);
});

// --- runClaudeJob : upload du fichier source ------------------------------------

test('runClaudeJob uploade le ZIP via CDP puis injecte le prompt (avec délais anti-détection)', async () => {
  const dbg = createDebugger();
  const ctx = setup({
    debugger: dbg,
    upload: JSON.stringify({ ok: true, selector: SELECTOR }),
    inject: OK_INJECT
  }, function(s) { s.config.minDelayMs = 1; s.config.maxDelayMs = 1; });
  const result = await ctx.scheduler.runClaudeJob('profil_1', 'Prompt', ZIP);
  assert.strictEqual(result.ok, true);
  assert.ok(hasLog(ctx.scheduler, 'avant upload (« profil_1 »)'));
  assert.ok(hasLog(ctx.scheduler, 'avant envoi (« profil_1 »)'));
  assert.ok(hasLog(ctx.scheduler, 'Fichier uploadé pour Claude (« profil_1 ») : ' + ZIP));
  const setFiles = dbg.calls.filter(function(c) { return c[0] === 'DOM.setFileInputFiles'; });
  assert.strictEqual(setFiles.length, 1);
  assert.deepStrictEqual(setFiles[0][1], { nodeId: 2, files: [ZIP] });
  // L'upload précède l'injection du prompt.
  const uploadIdx = ctx.wc.scripts.indexOf(UPLOAD);
  const injectIdx = ctx.wc.scripts.length - 1;
  assert.ok(uploadIdx > 0 && uploadIdx < injectIdx);
  cleanup(ctx.scheduler);
});

test('runClaudeJob continue si l\'upload CDP échoue (debugger indisponible), résultat objet accepté', async () => {
  const ctx = setup({
    debugger: null,
    upload: { ok: true, selector: SELECTOR }, // objet, pas une chaîne JSON
    inject: { ok: true, method: 'type' }
  });
  const result = await ctx.scheduler.runClaudeJob('profil_1', 'Prompt', ZIP);
  assert.strictEqual(result.ok, true);
  assert.ok(hasLog(ctx.scheduler, 'Upload CDP échoué (« profil_1 ») : CDP non disponible sur cette webview.'));
  assert.ok(hasLog(ctx.scheduler, 'l\'utilisateur devra uploader manuellement'));
  assert.ok(!hasLog(ctx.scheduler, 'avant upload'), 'pas de délai quand delayMs vaut 0');
  cleanup(ctx.scheduler);
});

test('runClaudeJob ne tente pas le CDP si le script d\'upload ne renvoie pas ok', async () => {
  const dbg = createDebugger();
  const ctx = setup({
    debugger: dbg,
    upload: JSON.stringify({ ok: false }),
    inject: OK_INJECT
  });
  const result = await ctx.scheduler.runClaudeJob('profil_1', 'Prompt', ZIP);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(dbg.calls.length, 0);
  cleanup(ctx.scheduler);
});

test('runClaudeJob ignore l\'upload si le champ fichier est introuvable', async () => {
  const dbg = createDebugger();
  const ctx = setup({
    debugger: dbg,
    detect: [detection({ fileUpload: { found: false } })],
    inject: OK_INJECT
  });
  const result = await ctx.scheduler.runClaudeJob('profil_1', 'Prompt', ZIP);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(ctx.wc.count(UPLOAD), 0);
  assert.strictEqual(dbg.calls.length, 0);
  cleanup(ctx.scheduler);
});

// --- runClaudeJob : injection du prompt ---------------------------------------------

test('runClaudeJob renvoie tel quel un échec d\'injection sans journal de succès', async () => {
  const ctx = setup({ inject: JSON.stringify({ ok: false, error: 'input_not_found' }) });
  const result = await ctx.scheduler.runClaudeJob('profil_1', 'Prompt', null);
  assert.deepStrictEqual(result, { ok: false, error: 'input_not_found' });
  assert.ok(!hasLog(ctx.scheduler, 'Prompt injecté'));
  cleanup(ctx.scheduler);
});

test('runClaudeJob renvoie unknown si l\'injection ne renvoie rien', async () => {
  const ctx = setup({ inject: null });
  const result = await ctx.scheduler.runClaudeJob('profil_1', 'Prompt', null);
  assert.deepStrictEqual(result, { ok: false, error: 'unknown' });
  cleanup(ctx.scheduler);
});

test('runClaudeJob journalise et renvoie l\'erreur si l\'injection lève une exception', async () => {
  const ctx = setup({ throwOn: ['inject'] });
  const result = await ctx.scheduler.runClaudeJob('profil_1', 'Prompt', null);
  assert.deepStrictEqual(result, { error: 'boom inject' });
  assert.ok(hasLog(ctx.scheduler, 'Erreur job Claude (« profil_1 ») : boom inject'));
  cleanup(ctx.scheduler);
});

// --- _uploadFileViaCDP ----------------------------------------------------------------

test('_uploadFileViaCDP enchaîne attach, getDocument, querySelector, setFileInputFiles, detach', async () => {
  const scheduler = createScheduler();
  const dbg = createDebugger();
  await scheduler._uploadFileViaCDP({ debugger: dbg }, ZIP, SELECTOR);
  assert.deepStrictEqual(dbg.calls, [
    ['attach', '1.3'],
    ['DOM.getDocument', undefined],
    ['DOM.querySelector', { nodeId: 1, selector: SELECTOR }],
    ['DOM.setFileInputFiles', { nodeId: 2, files: [ZIP] }],
    ['detach']
  ]);
  assert.strictEqual(dbg.attached, false);
  cleanup(scheduler);
});

test('_uploadFileViaCDP échoue proprement sans debugger', async () => {
  const scheduler = createScheduler();
  await assert.rejects(
    scheduler._uploadFileViaCDP({}, ZIP, SELECTOR),
    { message: 'CDP non disponible sur cette webview.' }
  );
  cleanup(scheduler);
});

test('_uploadFileViaCDP échoue si le nœud est absent (null) et détache quand même', async () => {
  const scheduler = createScheduler();
  const dbg = createDebugger({ node: null });
  await assert.rejects(
    scheduler._uploadFileViaCDP({ debugger: dbg }, ZIP, SELECTOR),
    { message: 'Input file non trouvé via CDP.' }
  );
  assert.strictEqual(dbg.calls[dbg.calls.length - 1][0], 'detach');
  assert.ok(!dbg.calls.some(function(c) { return c[0] === 'DOM.setFileInputFiles'; }));
  cleanup(scheduler);
});

test('_uploadFileViaCDP échoue si querySelector renvoie nodeId 0 et détache quand même', async () => {
  const scheduler = createScheduler();
  const dbg = createDebugger({ node: { nodeId: 0 } });
  await assert.rejects(
    scheduler._uploadFileViaCDP({ debugger: dbg }, ZIP, SELECTOR),
    { message: 'Input file non trouvé via CDP.' }
  );
  assert.strictEqual(dbg.attached, false);
  cleanup(scheduler);
});

test('_uploadFileViaCDP ignore un échec de detach', async () => {
  const scheduler = createScheduler();
  const dbg = createDebugger({ detachThrows: true });
  await scheduler._uploadFileViaCDP({ debugger: dbg }, ZIP, SELECTOR);
  assert.strictEqual(dbg.calls[dbg.calls.length - 1][0], 'detach');
  cleanup(scheduler);
});

// --- collectClaudeResponse -------------------------------------------------------------

test('collectClaudeResponse journalise la longueur de la réponse collectée', async () => {
  const ctx = setup({ collect: JSON.stringify({ ok: true, response: 'Bonjour' }) });
  const result = await ctx.scheduler.collectClaudeResponse('profil_1');
  assert.strictEqual(result.response, 'Bonjour');
  assert.ok(hasLog(ctx.scheduler, 'Réponse Claude collectée (« profil_1 ») : 7 caractères.'));
  cleanup(ctx.scheduler);
});

test('collectClaudeResponse journalise « aucune réponse » pour une réponse vide (résultat objet)', async () => {
  const ctx = setup({ collect: { ok: true, response: '' } });
  const result = await ctx.scheduler.collectClaudeResponse('profil_1');
  assert.strictEqual(result.ok, true);
  assert.ok(hasLog(ctx.scheduler, 'aucune réponse.'));
  cleanup(ctx.scheduler);
});

test('collectClaudeResponse ne journalise rien si la collecte n\'est pas ok', async () => {
  const ctx = setup({ collect: JSON.stringify({ ok: false, error: 'no_messages' }) });
  const result = await ctx.scheduler.collectClaudeResponse('profil_1');
  assert.deepStrictEqual(result, { ok: false, error: 'no_messages' });
  assert.ok(!hasLog(ctx.scheduler, 'Réponse Claude collectée'));
  cleanup(ctx.scheduler);
});

test('collectClaudeResponse journalise et renvoie l\'erreur si executeJavaScript échoue', async () => {
  const ctx = setup({ throwOn: ['collect'] });
  const result = await ctx.scheduler.collectClaudeResponse('profil_1');
  assert.deepStrictEqual(result, { error: 'boom collect' });
  assert.ok(hasLog(ctx.scheduler, 'Erreur collecte réponse Claude (« profil_1 ») : boom collect'));
  cleanup(ctx.scheduler);
});

test('collectClaudeResponse sans webview ouverte renvoie une erreur', async () => {
  const scheduler = createScheduler();
  const result = await scheduler.collectClaudeResponse('absent');
  assert.ok(result.error.indexOf('Aucune webview ouverte') === 0);
  cleanup(scheduler);
});
