'use strict';
// ---------------------------------------------------------------------------
// test-electron/popups-continue.js — harnais d'intégration Electron RÉEL
// (lot du 18/09/2026 : « test du zip livré avec un build Electron local »).
//
// Usage (Linux, depuis la racine du projet) :
//   xvfb-run -a npx electron --no-sandbox test-electron/popups-continue.js
// ou via npm :
//   npm run test:electron
//
// IMPORTANT — LIMITATION DÉLIBÉRÉE (docs/PROJECT_CONTEXT.md) : AUCUN accès
// réseau réel vers Claude.ai ou un autre service IA. Toutes les pages « IA »
// sont des fichiers LOCAUX dans test-electron/fixtures/ (claude-mock.html,
// guest.html). On ne teste QUE le câblage réel (main.js + index.html +
// scheduler + adaptateur dans un vrai Chromium), jamais le site distant.
//
// Phases :
//   A. Adaptateur (lib/claude-adapter.js) exécuté dans un vrai Chromium sur
//      la fixture locale claude-mock.html :
//        A1. buildClaudeDetectionScript() — détection bouton Continuer,
//            popups, zone de chat, bouton envoyer, absence de quota.
//        A2. buildPopupDismissScript() — fermeture de la popup, puis
//            re-détection : plus aucune popup.
//        A3. buildContinueActionScript() — clic réel sur « Continuer ».
//        A4. planClaudeAutomationStep() — orchestration complète
//            détection -> plan -> exécution (popup d'abord, puis Continuer).
//   B. Application réelle (main.js chargé TEL QUEL + index.html) :
//        B1. La fenêtre charge et l'IPC ordonnanceur répond (jobs seedés).
//        B2. La fenêtre hôte ne peut PAS ouvrir de popup (deny-all).
//        B3. La fenêtre hôte ne peut PAS naviguer vers le web (will-navigate).
//        B4. Une <webview> (partition persist:) est enregistrée auprès du
//            scheduler par did-attach-webview (diagnostic IPC OK).
//        B5. Les popups du guest sont refusées (about:, https hors liste) et
//            un lien web hors liste part vers le navigateur système
//            (shell.openExternal stubbé), pas vers une fenêtre Electron.
//        B6. Bouton « Continuer le projet » : job COMPLETED ->
//            RESUME_REQUIRED avec profil éligible (compte seedé).
//        B7. Bouton « Continuer le projet » sans profil éligible ->
//            WAITING_FOR_PROFILE.
//
// Sortie : lignes « ok - … » / « NOT OK - … » + résumé. Code de sortie 0 si
// tout passe, 1 sinon (2 en cas de timeout global).
// ---------------------------------------------------------------------------

const { app, BrowserWindow } = require('electron');

// Issue #51, lot 3 : sans demande explicite, l'interface suit la langue du
// système (anglais sur un runner anglophone). Les scénarios vérifient les
// libellés français (langue source) : on l'impose.
process.env.IAO_LANG = 'fr';
const path = require('path');
const fs = require('fs');
const os = require('os');

const claudeAdapter = require('../lib/claude-adapter');
const { isAllowedPopup } = require('../lib/popup-guard');
const core = require('../scheduler/core');

// --- Mini framework de test (aucune dépendance) -----------------------------
let passed = 0;
let failed = 0;
const failures = [];

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion échouée');
}

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log('ok - ' + name);
  } catch (e) {
    failed += 1;
    failures.push({ name: name, error: e });
    console.log('NOT OK - ' + name + ' : ' + (e && e.message ? e.message : e));
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Comptage global des webContents créés (pour prouver qu'aucune popup n'ouvre
// de fenêtre) + suivi des guests (webviews) attachés.
let webContentsCreated = 0;
const guestContents = [];
// Collecte des violations CSP (lot CSP 18/09/2026) : dès la création d'une
// webContents (donc AVANT le chargement d'index.html), on écoute la console.
// Motifs précis : « Content Security Policy », « Refused to execute »,
// « Refused to load », « Refused to create a worker ».
const cspViolations = [];
app.on('web-contents-created', (event, contents) => {
  webContentsCreated += 1;
  try {
    contents.on('console-message', (...args) => {
      for (const v of args) {
        if (typeof v === 'string' &&
            (v.indexOf('Content Security Policy') !== -1 || /Refused to (execute|load|create)/.test(v))) {
          cspViolations.push(v);
          return;
        }
      }
    });
  } catch (e) { /* écoute best-effort */ }
  try {
    if (contents.getType() === 'webview') guestContents.push(contents);
  } catch (e) { /* type pas encore déterminable : on ignore */ }
});

// Accélération matérielle coupée : le harnais tourne sous xvfb (headless),
// pas besoin de GPU réel.
app.disableHardwareAcceleration();

// Garde-fou : si le harnais s'enlise, on termine quand même (exit 2).
setTimeout(() => {
  console.error('TIMEOUT global du harnais (240 s) — abandon.');
  process.exit(2);
}, 240000);

async function run() {
  // =========================================================================
  // Phase A — Adaptateur sur la fixture LOCALE claude-mock.html
  // =========================================================================
  console.log('\n--- Phase A : adaptateur (fixture locale claude-mock.html) ---');
  const fixturePath = path.join(__dirname, 'fixtures', 'claude-mock.html');
  const fw = new BrowserWindow({
    show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true }
  });
  await fw.loadFile(fixturePath);
  const inFixture = async (script) => JSON.parse(await fw.webContents.executeJavaScript(script));

  await test('A1 détection : bouton Continuer, popups, zone de chat, bouton envoyer présents (sans quota)', async () => {
    const det = await inFixture(claudeAdapter.buildClaudeDetectionScript());
    assert(det.continueButton && det.continueButton.found, 'bouton « Continuer » non détecté');
    assert(det.continueButton.count === 1, 'bouton « Continuer » : attendu 1, trouvé ' + det.continueButton.count);
    assert(det.popups && det.popups.count >= 1, 'popup non détectée (compte : ' + (det.popups ? det.popups.count : '?') + ')');
    assert(det.chatInput && det.chatInput.found, 'zone de chat non détectée');
    assert(det.sendButton && det.sendButton.found, 'bouton envoyer non détecté');
    assert(det.assistantMessages && det.assistantMessages.found, 'bloc réponse assistant non détecté');
    assert(det.quotaMessage && det.quotaMessage.detected === false, 'quota faussement détecté');
  });

  await test('A2 buildPopupDismissScript : popup fermée en vrai, re-détection à zéro', async () => {
    const res = await inFixture(claudeAdapter.buildPopupDismissScript());
    assert(res.ok === true, 'script de fermeture a échoué');
    assert(res.dismissed >= 1, 'aucune popup fermée (dismissed : ' + res.dismissed + ')');
    const det2 = await inFixture(claudeAdapter.buildClaudeDetectionScript());
    assert(det2.popups && det2.popups.count === 0, 'popup encore présente après fermeture (compte : ' + det2.popups.count + ')');
  });

  await test('A3 buildContinueActionScript : clic réel sur « Continuer »', async () => {
    const res = await inFixture(claudeAdapter.buildContinueActionScript());
    assert(res.ok === true, 'clic « Continuer » refusé : ' + JSON.stringify(res));
    assert(res.method === 'continue_button', 'méthode inattendue : ' + res.method);
    const clicked = await fw.webContents.executeJavaScript(
      '(document.querySelector(\'button[aria-label="Continuer"]\') || {}).dataset ? document.querySelector(\'button[aria-label="Continuer"]\').dataset.clicked : null');
    assert(clicked === 'true', 'le bouton « Continuer » n\'a pas été cliqué (data-clicked : ' + clicked + ')');
  });

  await test('A4 planClaudeAutomationStep : orchestration complète popup d\'abord, puis Continuer (délais nuls)', async () => {
    // Page vierge à nouveau (la popup doit réapparaître)
    await new Promise(resolve => { fw.webContents.once('did-finish-load', resolve); fw.webContents.reload(); });
    const opts = { requestedAction: 'continue', rng: () => 0, minDelayMs: 0, maxDelayMs: 0 };

    // 1. Popup présente -> le plan impose de la fermer AVANT l'action.
    const det1 = await inFixture(claudeAdapter.buildClaudeDetectionScript());
    assert(det1.popups.count >= 1, 'popup attendue sur page rechargée');
    const plan1 = claudeAdapter.planClaudeAutomationStep(det1, opts);
    assert(plan1.action === 'dismiss_popups', 'action attendue dismiss_popups, reçue : ' + plan1.action);
    const res1 = await inFixture(plan1.script);
    assert(res1.ok && res1.dismissed >= 1, 'fermeture de popup non exécutée');

    // 2. Popup fermée -> le plan donne l'action demandée avec délai nul.
    const det2 = await inFixture(claudeAdapter.buildClaudeDetectionScript());
    assert(det2.popups.count === 0, 'popup encore présente');
    const plan2 = claudeAdapter.planClaudeAutomationStep(det2, opts);
    assert(plan2.action === 'continue', 'action attendue continue, reçue : ' + plan2.action);
    assert(plan2.delayMs === 0, 'délai attendu 0, reçu : ' + plan2.delayMs);
    assert(plan2.scriptName === 'buildContinueActionScript', 'builder inattendu : ' + plan2.scriptName);

    // 3. Exécution du script planifié -> clic réel.
    const res2 = await inFixture(plan2.script);
    assert(res2.ok === true && res2.method === 'continue_button', 'clic Continuer non exécuté : ' + JSON.stringify(res2));
    const clicked = await fw.webContents.executeJavaScript('document.querySelector(\'button[aria-label="Continuer"]\').dataset.clicked');
    assert(clicked === 'true', 'bouton Continuer non cliqué');
  });

  // NB : on ne détruit PAS fw ici — fermer la dernière fenêtre avant que
  // main.js n'ait posé son handler window-all-closed fermerait l'app (quit
  // par défaut d'Electron). fw est détruite juste avant app.exit().

  // =========================================================================
  // Phase B — Application réelle (main.js tel quel + index.html)
  // =========================================================================
  console.log('\n--- Phase B : application réelle (main.js + index.html) ---');

  // B.0 Préparation d'un environnement userData ISOLÉ, seedé AVANT le
  // require('../main.js') : le Scheduler lit jobs.json à la construction
  // (main.js l'instancie au chargement du module).
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iao-harnais-'));
  app.setPath('appData', tmpRoot); // main.js dérive userData = <appData>/ai-manager
  // Le harnais est le point d'entrée d'Electron : sans ça, la racine de
  // l'application serait test-electron/ et win.loadFile('index.html') dans
  // main.js chercherait test-electron/index.html (ERR_FILE_NOT_FOUND).
  // On rétablit la racine réelle du projet pour que main.js se comporte
  // EXACTEMENT comme lors d'un `npm start`.
  app.setAppPath(path.join(__dirname, '..'));
  const schedDir = path.join(tmpRoot, 'ai-manager', 'scheduler');
  fs.mkdirSync(schedDir, { recursive: true });

  const seededJobs = [
    core.buildJobRecord({
      id: 'job_001', status: 'COMPLETED', service: 'claude',
      profile: null, url: 'https://claude.ai/x', file_path: '/tmp/iao-fixture-job-001.zip'
    }),
    core.buildJobRecord({
      id: 'job_002', status: 'COMPLETED', service: 'claude',
      profile: null, url: 'https://claude.ai/y', file_path: '/tmp/iao-fixture-job-002.zip'
    })
  ];
  fs.writeFileSync(path.join(schedDir, 'jobs.json'), JSON.stringify(seededJobs, null, 2), 'utf-8');
  // Ordonnanceur désactivé : on teste le bouton « Continuer » (décision
  // manuelle), pas le lancement automatique.
  fs.writeFileSync(path.join(schedDir, 'config.json'), JSON.stringify({
    enabled: false, maxConcurrentJobs: 2, minDelayBetweenAutomationsMinutes: 30,
    profileAgeThresholdHours: 5, downloadsDir: null, deliveryDir: null,
    showAutomationWindows: false
  }, null, 2), 'utf-8');

  // B.0bis Stub de shell.openExternal : sans ça, un lien web hors liste ouvrirait
  // le vrai navigateur système pendant le test. On intercepte les appels.
  const externals = [];
  let openExternalStubbed = false;
  try {
    const shell = require('electron').shell; // même objet que celui de main.js
    shell.openExternal = function (url) { externals.push(String(url)); return Promise.resolve(); };
    openExternalStubbed = true;
  } catch (e) {
    console.log('(note) shell.openExternal non stubbable : ' + e.message);
  }

  // B.0ter Chargement de l'application RÉELLE.
  require('../main.js');

  // Attente de la fenêtre principale (celle qui charge index.html — PAS la
  // fenêtre fixture de la phase A) puis du rendu complet.
  let win = null;
  for (let i = 0; i < 150 && !win; i++) {
    win = BrowserWindow.getAllWindows().find(w => {
      try { return !w.isDestroyed() && w !== fw && w.webContents.getURL().endsWith('index.html'); }
      catch (e) { return false; }
    });
    if (!win) await sleep(100);
  }
  assert(win, 'fenêtre principale jamais créée');
  for (let i = 0; i < 100; i++) {
    const loading = win.webContents.isLoading();
    if (!loading) break;
    await sleep(100);
  }
  await sleep(1500); // initApp, hydratation des icônes, premier rafraîchissement

  // Issue #4 : contextIsolation: true — le renderer n'a plus accès à
  // module.require('electron'). On utilise window.iaoAPI.ipcInvoke,
  // exposé par preload.js.
  const ipc = (channel, ...args) => win.webContents.executeJavaScript(
    'window.iaoAPI.ipcInvoke(' + JSON.stringify(channel) +
    (args.length ? ', ' + args.map(a => JSON.stringify(a)).join(', ') : '') + ')'
  );

  await test('B1 la fenêtre réelle charge index.html et l\'IPC scheduler:get-state renvoie les 2 jobs seedés (COMPLETED)', async () => {
    assert(win.webContents.getURL().indexOf('index.html') !== -1, 'URL inattendue : ' + win.webContents.getURL());
    const state = await ipc('scheduler:get-state');
    assert(state && !state.error, 'état scheduler indisponible : ' + JSON.stringify(state && state.error));
    assert(state.jobs.length === 2, 'attendu 2 jobs seedés, reçu ' + state.jobs.length);
    const j1 = state.jobs.find(j => j.id === 'job_001');
    const j2 = state.jobs.find(j => j.id === 'job_002');
    assert(j1 && j1.status === 'COMPLETED', 'job_001 attendu COMPLETED, reçu ' + (j1 && j1.status));
    assert(j2 && j2.status === 'COMPLETED', 'job_002 attendu COMPLETED, reçu ' + (j2 && j2.status));
  });

  await test('B2 la fenêtre hôte ne peut PAS ouvrir de popup (deny-all, aucune webContents créée)', async () => {
    const before = webContentsCreated;
    await win.webContents.executeJavaScript('window.open(\'https://claude.ai/\'); \'fait\'');
    await sleep(600);
    assert(webContentsCreated === before,
      'une webContents a été créée par window.open sur l\'hôte (' + before + ' -> ' + webContentsCreated + ')');
  });

  await test('B3 la fenêtre hôte ne peut PAS naviguer vers le web (will-navigate bloqué, URL restée file://)', async () => {
    await win.webContents.executeJavaScript('try { window.location.href = \'https://example.com/\'; } catch (e) {} \'fait\'');
    await sleep(600);
    assert(win.webContents.getURL().startsWith('file://'),
      'navigation de l\'hôte non bloquée, URL : ' + win.webContents.getURL());
  });

  // Compte éligible (jamais utilisé pour l'automatisation : lastAutomationAt=0)
  // synchronisé via le VRAI canal IPC utilisé par le renderer (window.iaoAPI :
  // le require de la page est écrasé par le loader AMD de Monaco, cf. ipc()).
  // Synchronisé AVANT la création de la webview : c'est la liste des comptes
  // connus qui permet au scheduler d'identifier le profil d'une webview
  // (resolveProfileFromSession, cf. correctif Electron 43).
  const seededAccount = {
    id: 'acc_electron_test', name: 'Compte Electron Test',
    profile: 'profil_electron_test',
    automation: { enabled: true, lastUsedAt: 0, lastAutomationAt: 0 }
  };
  await win.webContents.executeJavaScript(
    'window.iaoAPI.ipcInvoke(\'scheduler:sync-accounts\', ' + JSON.stringify([seededAccount]) + ')'
  );

  // B4 : création d'une <webview> dans la page réelle, sur une fixture locale.
  const guestUrl = 'file://' + path.join(__dirname, 'fixtures', 'guest.html').replace(/\\/g, '/');
  await win.webContents.executeJavaScript(
    '(function() {' +
    '  var wv = document.createElement(\'webview\');' +
    '  wv.setAttribute(\'partition\', \'persist:profil_electron_test\');' +
    '  wv.setAttribute(\'allowpopups\', \'\');' +
    '  wv.setAttribute(\'style\', \'width:10px;height:10px;\');' +
    '  wv.src = ' + JSON.stringify(guestUrl) + ';' +
    '  document.body.appendChild(wv);' +
    '  return \'créée\';' +
    '})()'
  );
  // Attache du guest : le handler did-attach-webview de main.js l'enregistre.
  let guest = null;
  for (let i = 0; i < 100 && !guest; i++) {
    guest = guestContents.find(g => { try { return !g.isDestroyed() && g.getURL().indexOf('guest.html') !== -1; } catch (e) { return false; } });
    if (!guest) await sleep(100);
  }
  await test('B4 la webview (partition persist:) est chargée et enregistrée auprès du scheduler (diagnostic IPC)', async () => {
    assert(guest, 'guest webview jamais attachée/chargée');
    for (let i = 0; i < 100; i++) {
      try {
        const ready = await guest.executeJavaScript('document.readyState');
        if (ready === 'complete') break;
      } catch (e) { /* pas encore prêt */ }
      await sleep(100);
    }
    // Si did-attach-webview a bien enregistré le profil, le diagnostic
    // s'exécute DANS la webview (au lieu de renvoyer « aucune webview »).
    const diag = await ipc('scheduler:diagnose-claude', 'profil_electron_test');
    assert(diag && !diag.error, 'webview non enregistrée : ' + JSON.stringify(diag && diag.error));
    assert(diag.chatInput && diag.chatInput.found === false, 'la fixture guest ne doit PAS contenir de zone de chat');
    assert(diag.popups && diag.popups.count === 0, 'la fixture guest ne doit PAS contenir de popup');
  });

  await test('B5 popups du guest : about: et https hors liste refusées (aucune webContents), lien web confié au navigateur système', async () => {
    assert(guest, 'guest indisponible');
    const before = webContentsCreated;
    await guest.executeJavaScript('window.open(\'about:blank\'); \'fait\'');
    await guest.executeJavaScript('window.open(\'https://hors-liste.example.com/\'); \'fait\'');
    await sleep(600);
    assert(webContentsCreated === before,
      'une webContents a été créée par une popup du guest (' + before + ' -> ' + webContentsCreated + ')');
    // Le lien web hors liste part vers le navigateur système (stub), pas vers Electron.
    if (openExternalStubbed) {
      assert(externals.indexOf('https://hors-liste.example.com/') !== -1,
        'shell.openExternal non appelé pour le lien hors liste (reçus : ' + JSON.stringify(externals) + ')');
    } else {
      console.log('    (openExternal non stubbable — assertion contournée)');
    }
    // Contrôle croisé de la règle pure utilisée par main.js (lib/popup-guard.js) :
    // la liste blanche laisse passer claude.ai, jamais un domaine inconnu.
    assert(isAllowedPopup('https://claude.ai/toto') === true, 'claude.ai doit être autorisé');
    assert(isAllowedPopup('https://hors-liste.example.com/') === false, 'domaine inconnu ne doit pas être autorisé');
    assert(isAllowedPopup('about:blank') === false, 'about: ne doit pas être autorisé');
  });

  // B6/B7 : bouton « Continuer le projet » dans le panneau Ordonnanceur réel.
  await test('B6 « Continuer le projet » : job_001 COMPLETED -> RESUME_REQUIRED avec le compte éligible seedé', async () => {
    // Ouvre le panneau Ordonnanceur via la vraie API du renderer.
    await win.webContents.executeJavaScript('window.openSchedulerModal(); \'ouvert\'');
    await sleep(1000); // refreshScheduler + rendu

    const rendered = await win.webContents.executeJavaScript(
      '(function() { var b = document.querySelector(\'[data-action="sched-continue"][data-job="job_001"]\'); return b ? b.textContent : null; })()'
    );
    assert(rendered === 'Continuer le projet',
      'bouton « Continuer le projet » non rendu pour job_001 (trouvé : ' + JSON.stringify(rendered) + ')');

    // Clic réel (délégation d'événements sur #schedJobsList -> IPC continue-project).
    await win.webContents.executeJavaScript(
      'document.querySelector(\'[data-action="sched-continue"][data-job="job_001"]\').click(); \'cliqué\''
    );
    await sleep(1000); // IPC + persist + re-rendu

    const state = await ipc('scheduler:get-state');
    const j1 = state.jobs.find(j => j.id === 'job_001');
    assert(j1.status === 'RESUME_REQUIRED', 'job_001 attendu RESUME_REQUIRED, reçu ' + j1.status);
    assert(j1.profile === 'profil_electron_test', 'profil attendu profil_electron_test, reçu ' + j1.profile);
  });

  await test('B7 « Continuer le projet » sans profil éligible restant : job_002 -> WAITING_FOR_PROFILE', async () => {
    // Le compte seedé vient d'être réservé par job_001 (lastAutomationAt=now,
    // seuil 5 h) : aucun profil éligible ne reste.
    await sleep(500); // laisser le re-rendu du panneau se faire
    const rendered = await win.webContents.executeJavaScript(
      '(function() { var b = document.querySelector(\'[data-action="sched-continue"][data-job="job_002"]\'); return b ? b.textContent : null; })()'
    );
    assert(rendered === 'Continuer le projet',
      'bouton « Continuer le projet » non rendu pour job_002 (trouvé : ' + JSON.stringify(rendered) + ')');
    await win.webContents.executeJavaScript(
      'document.querySelector(\'[data-action="sched-continue"][data-job="job_002"]\').click(); \'cliqué\''
    );
    await sleep(1000);
    const state = await ipc('scheduler:get-state');
    const j2 = state.jobs.find(j => j.id === 'job_002');
    assert(j2.status === 'WAITING_FOR_PROFILE', 'job_002 attendu WAITING_FOR_PROFILE, reçu ' + j2.status);
    assert(j2.profile === null || j2.profile === undefined, 'job_002 ne doit avoir aucun profil, reçu ' + j2.profile);
  });

  // B8-B10 (lot CSP 18/09/2026) : délégation data-action, Monaco sous CSP,
  // et absence de violation CSP sur toute la phase B. Placés APRÈS B6/B7 pour
  // ne pas perturber l'état attendu par les tests scheduler (panneau éditeur
  // ouvert + Monaco initialisé).
  await test('B8 bouton Éditeur (data-action="ui-toggleIdePanel") : la délégation globale ouvre le panneau', async () => {
    const before = await win.webContents.executeJavaScript(
      'document.getElementById("idePanel").classList.contains("collapsed")');
    assert(before === true, 'le panneau éditeur devait être replié au départ');
    // Clic réel (bubbling jusqu'au listener délégué du document).
    await win.webContents.executeJavaScript(
      'document.querySelector(\'[data-action="ui-toggleIdePanel"]\').click(); \'cliqué\'');
    await sleep(500);
    const after = await win.webContents.executeJavaScript(
      'document.getElementById("idePanel").classList.contains("collapsed")');
    assert(after === false, 'le panneau éditeur ne s\'est pas ouvert via la délégation data-action');
  });

  await test('B9 Monaco s\'initialise sous CSP : .monaco-editor présent (workers via blob:)', async () => {
    // toggleIdePanel -> ensureMonacoLoaded -> AMD require -> monaco.editor.create.
    let found = false;
    for (let i = 0; i < 50 && !found; i++) {
      found = await win.webContents.executeJavaScript('!!document.querySelector(".monaco-editor")');
      if (!found) await sleep(200);
    }
    assert(found === true, 'l\'éditeur Monaco n\'a pas été créé dans les 10 s');
    const monacoGlobal = await win.webContents.executeJavaScript('typeof window.monaco !== "undefined"');
    assert(monacoGlobal === true, 'window.monaco absent après chargement');
  });

  await test('B10 aucune violation CSP pendant toute la phase B (scripts, webviews, Monaco)', async () => {
    assert(cspViolations.length === 0,
      'violations CSP détectées (' + cspViolations.length + ') : ' +
      JSON.stringify(cspViolations.slice(0, 5)));
  });

  // --- Résumé ----------------------------------------------------------------
  console.log('\n--- Résumé du harnais Electron ---');
  console.log('pass ' + passed + ' / fail ' + failed);
  if (failures.length) {
    failures.forEach(f => console.log('ÉCHEC : ' + f.name + ' — ' + (f.error && f.error.message)));
  }
  try { fw.destroy(); } catch (e) { /* déjà détruite */ }
  app.exit(failed > 0 ? 1 : 0);
}

app.whenReady().then(run).catch(e => {
  console.error('Erreur fatale du harnais :', e);
  app.exit(1);
});
