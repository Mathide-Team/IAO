'use strict';

// ---------------------------------------------------------------------------
// test-electron/identifiants-continue.js — harnais d'intégration Electron RÉEL
// pour le lot 2 de l'issue #278 (identifiants partagés, menu au focus).
//
// Usage : xvfb-run -a npx electron --no-sandbox test-electron/identifiants-continue.js
// (harnais à part, comme popups-continue.js : node --test ne l'exécute pas.)
//
// IMPORTANT — AUCUN accès réseau réel : la fixture est servie par interception
// du protocole https sur un hôte fictif (context7.test), dans la partition de
// la webview. On teste le câblage réel (lib/identifiants-preload.js dans un
// vrai Chromium + main.js tel quel), jamais le site distant.
//
// Phases :
//   A. Preload de session dans un vrai Chromium (sans main.js) :
//      A1. focus d'un champ mot de passe -> 'iao-identifiants:focus' reçu par
//          le process principal (espion ipcMain), pour le bon hôte ;
//      A2. 'iao-identifiants:remplir' envoyé au guest -> champs login ET mot
//          de passe remplis (setter natif + événements input/change vus par la
//          page — le risque « formulaires contrôlés / monde isolé » est couvert) ;
//      A3. champ 2FA (one-time-code) : jamais rempli.
//   B. Application réelle (main.js chargé TEL QUEL) :
//      B1. le preload des identifiants est posé sur la session de la webview
//          (session-created de main.js, lu via session.getPreloads()) ;
//      B2. focus d'un champ -> menu proposé (Menu espionné) avec les
//          identifiants de l'hôte, ancré à la fenêtre principale, au curseur ;
//      B3. choix dans le menu -> remplissage envoyé au guest (dépend du
//          trousseau du système ; sous xvfb sans trousseau, le coffre refuse
//          et le harnais le note sans échouer).
//
// Sortie : lignes « ok - … » / « NOT OK - … » + résumé. Code de sortie 0 si
// tout passe, 1 sinon (2 en cas de timeout global).
// ---------------------------------------------------------------------------

process.env.IAO_LANG = 'fr';
const { app, BrowserWindow, ipcMain, protocol, session, safeStorage, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const PRELOAD_IDENTIFIANTS = path.join(__dirname, '..', 'lib', 'identifiants-preload.js');
const MAIN_JS = path.join(__dirname, '..', 'main.js');
const HOTE = 'context7.test';
const URL_FIXTURE = 'https://' + HOTE + '/connexion';

// --- Mini framework de test (aucune dépendance) -----------------------------
let passed = 0;
let failed = 0;
const failures = [];
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion échouée'); }
async function test(name, fn) {
  try { await fn(); passed += 1; console.log('ok - ' + name); }
  catch (e) { failed += 1; failures.push({ name, error: e }); console.log('NOT OK - ' + name + ' : ' + (e && e.message ? e.message : e)); }
}

// --- Espions globaux ---------------------------------------------------------
const menusConstruits = [];   // items passés à Menu.buildFromTemplate (via espion)
const popups = [];            // options passées à Menu.popup (via espion)
const focusRecus = [];        // événements 'iao-identifiants:focus' (espion ipcMain)
ipcMain.on('iao-identifiants:focus', (event) => {
  try { focusRecus.push({ sender: event.sender, url: event.sender.getURL() }); }
  catch (e) { focusRecus.push({ sender: event.sender, url: null }); }
});

// Espion du Menu : posé AVANT require('../main.js') pour que main.js voie le
// wrapper. popup() n'affiche rien (harnais headless) : on capture les options.
const vraiBuildFromTemplate = Menu.buildFromTemplate.bind(Menu);
Menu.buildFromTemplate = (items) => {
  const menu = vraiBuildFromTemplate(items);
  menu.popup = (options) => { popups.push(options); return true; };
  menusConstruits.push(items);
  return menu;
};

app.disableHardwareAcceleration();
// Sous Linux, fermer la dernière fenêtre QUITTE l'app par défaut : la phase A
// détruit sa fenêtre hôte et tuerait le harnais avant la phase B. On neutralise
// ce comportement (le harnais se termine par process.exit explicite).
app.on('window-all-closed', () => { /* harnais : ne jamais quitter ici */ });
setTimeout(() => { console.error('TIMEOUT global du harnais (180 s) — abandon.'); process.exit(2); }, 180000);

// Fixture : formulaire de connexion (login + mot de passe + champ 2FA), avec
// écouteurs input/change qui enregistrent les événements reçus (prouve le
// setter natif + les événements pour les formulaires contrôlés).
function htmlFixture() {
  // Champs dans un <form> : le preload découvre le champ frère au focus d'un
  // seul des deux. Le bouton « oauth » ouvre une fenêtre fille (popup https
  // autorisée par la politique du dépôt) pour la phase B4.
  return '<!DOCTYPE html><html><head><meta charset="utf-8">' +
    '<style>input{display:block}</style></head><body>' +
    '<form id="connexion">' +
    '<input id="login" type="email" placeholder="login">' +
    '<input id="mdp" type="password">' +
    '<input id="otp" type="text" autocomplete="one-time-code">' +
    '<button id="oauth" type="button">oauth</button>' +
    '</form>' +
    '<script>' +
    'window.__evt = [];' +
    '["login","mdp","otp"].forEach(function (id) { var el = document.getElementById(id);' +
    '  el.addEventListener("input", function (e) { window.__evt.push(e.target.id + ":input"); });' +
    '  el.addEventListener("change", function (e) { window.__evt.push(e.target.id + ":change"); }); });' +
    'document.getElementById("oauth").addEventListener("click", function () {' +
    '  window.open("https://' + HOTE + '/oauth", "oauth", "width=300,height=300"); });' +
    '</script></body></html>';
}

// Page hôte minimale contenant la <webview> (fichier temporaire : une page
// data: ne peut pas héberger de webview de façon fiable).
function pageHote(partition) {
  return '<!DOCTYPE html><html><body>' +
    '<webview allowpopups partition="' + partition + '" src="' + URL_FIXTURE + '" style="width:300px;height:300px"></webview>' +
    '</body></html>';
}

// Suivi des webContents de webview (une <webview> n'est pas une BrowserWindow :
// sa webContents se collecte via web-contents-created, type « webview »).
const guestsVus = [];
app.on('web-contents-created', (_event, contents) => {
  try { if (contents.getType() === 'webview') guestsVus.push(contents); } catch (e) { /* */ }
});

async function attendreGuest() {
  for (let i = 0; i < 100; i++) {
    for (const c of guestsVus) {
      try {
        if (c && !c.isDestroyed() && c.getURL().indexOf(HOTE) !== -1) return c;
      } catch (e) { /* webContents en cours de destruction */ }
    }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('guest introuvable');
}

async function run() {
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'iao-harnais-identifiants-'));
  try {
    console.log('--- Phase A : preload de session dans un vrai Chromium ---');
    // Interception https sur la partition de la webview : la fixture est servie
    // localement sous un hôte réaliste (aucun réseau). Le preload est posé à la
    // main (main.js n'est pas encore chargé) : c'est ce que fait main.js en B.
    const partitionA = 'persist:iao-identifiants-a';
    const sesA = session.fromPartition(partitionA);
    sesA.protocol.interceptStringProtocol('https', (demande, callback) => {
      callback({ data: htmlFixture(), mimeType: 'text/html', charset: 'utf-8' });
    });
    sesA.setPreloads([PRELOAD_IDENTIFIANTS]);

    const fichierHoteA = path.join(dossier, 'hote-a.html');
    fs.writeFileSync(fichierHoteA, pageHote(partitionA), 'utf-8');
    const hoteA = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: false, contextIsolation: true, webviewTag: true } });
    await hoteA.loadFile(fichierHoteA);
    const guest = await attendreGuest();
    await guest.executeJavaScript('document.getElementById("mdp").focus(); document.getElementById("mdp").dispatchEvent(new Event("focusin", { bubbles: true })); "ok"');
    await new Promise(r => setTimeout(r, 500));

    await test('A1 focus d\'un champ mot de passe -> le process principal reçoit le signalement (canal réel)', async () => {
      assert(focusRecus.some((f) => f.url && f.url.indexOf(HOTE) !== -1),
        'aucun signalement de focus reçu pour ' + HOTE + ' (reçus : ' + focusRecus.length + ')');
    });

    await test('A2 remplissage : login ET mot de passe remplis, événements input/change vus par la page', async () => {
      await guest.executeJavaScript('document.getElementById("login").focus(); document.getElementById("login").dispatchEvent(new Event("focusin", { bubbles: true })); document.getElementById("mdp").focus(); document.getElementById("mdp").dispatchEvent(new Event("focusin", { bubbles: true })); "ok"');
      await new Promise(r => setTimeout(r, 200));
      guest.send('iao-identifiants:remplir', { login: 'moi@exemple.fr', motDePasse: 'S3cret!' });
      await new Promise(r => setTimeout(r, 500));
      const lu = JSON.parse(await guest.executeJavaScript(
        'JSON.stringify({ login: document.getElementById("login").value, mdp: document.getElementById("mdp").value, evt: window.__evt })'));
      assert(lu.login === 'moi@exemple.fr', 'login non rempli : ' + lu.login);
      assert(lu.mdp === 'S3cret!', 'mot de passe non rempli : ' + lu.mdp);
      assert(lu.evt.some((e) => e === 'login:input'), 'événement input non vu sur le login : ' + JSON.stringify(lu.evt));
      assert(lu.evt.some((e) => e === 'mdp:change'), 'événement change non vu sur le mot de passe : ' + JSON.stringify(lu.evt));
    });

    await test('A1b focus du SEUL mot de passe -> le remplissage remplit aussi le login (même formulaire)', async () => {
      // Rechargement : champs vides, aucune mémorisation préalable (le scénario
      // précédent a déjà rempli les champs).
      await new Promise((r) => { const fini = () => { guest.once('did-finish-load', () => setTimeout(r, 300)); }; if (guest.isLoading()) guest.once('did-stop-loading', fini); else fini(); guest.reload(); });
      focusRecus.length = 0;
      await guest.executeJavaScript('document.getElementById("mdp").focus(); document.getElementById("mdp").dispatchEvent(new Event("focusin", { bubbles: true })); "ok"');
      await new Promise(r => setTimeout(r, 200));
      assert(focusRecus.some((f) => f.url && f.url.indexOf(HOTE) !== -1), 'signalement non reçu');
      guest.send('iao-identifiants:remplir', { login: 'moi@exemple.fr', motDePasse: 'S3cret!' });
      await new Promise(r => setTimeout(r, 500));
      const lu = JSON.parse(await guest.executeJavaScript(
        'JSON.stringify({ login: document.getElementById("login").value, mdp: document.getElementById("mdp").value })'));
      assert(lu.login === 'moi@exemple.fr', 'login non rempli depuis le seul focus du mot de passe : ' + lu.login);
      assert(lu.mdp === 'S3cret!', 'mot de passe non rempli : ' + lu.mdp);
    });

    await test('A1c focus du SEUL login -> le remplissage remplit aussi le mot de passe (même formulaire)', async () => {
      await new Promise((r) => { const fini = () => { guest.once('did-finish-load', () => setTimeout(r, 300)); }; if (guest.isLoading()) guest.once('did-stop-loading', fini); else fini(); guest.reload(); });
      focusRecus.length = 0;
      await guest.executeJavaScript('document.getElementById("login").focus(); document.getElementById("login").dispatchEvent(new Event("focusin", { bubbles: true })); "ok"');
      await new Promise(r => setTimeout(r, 200));
      assert(focusRecus.some((f) => f.url && f.url.indexOf(HOTE) !== -1), 'signalement non reçu');
      guest.send('iao-identifiants:remplir', { login: 'moi@exemple.fr', motDePasse: 'S3cret!' });
      await new Promise(r => setTimeout(r, 500));
      const lu = JSON.parse(await guest.executeJavaScript(
        'JSON.stringify({ login: document.getElementById("login").value, mdp: document.getElementById("mdp").value })'));
      assert(lu.login === 'moi@exemple.fr', 'login non rempli : ' + lu.login);
      assert(lu.mdp === 'S3cret!', 'mot de passe non rempli depuis le seul focus du login : ' + lu.mdp);
    });

    await test('A3 champ 2FA (one-time-code) : jamais rempli', async () => {
      await guest.executeJavaScript('document.getElementById("login").focus(); document.getElementById("login").dispatchEvent(new Event("focusin", { bubbles: true })); document.getElementById("otp").focus(); document.getElementById("otp").dispatchEvent(new Event("focusin", { bubbles: true })); "ok"');
      await new Promise(r => setTimeout(r, 200));
      guest.send('iao-identifiants:remplir', { login: 'moi@exemple.fr', motDePasse: 'S3cret!' });
      await new Promise(r => setTimeout(r, 500));
      const otp = await guest.executeJavaScript('document.getElementById("otp").value');
      assert(otp === '', 'le champ 2FA a été rempli : ' + otp);
    });
    hoteA.destroy();

    console.log('\n--- Phase B : application réelle (main.js tel quel) ---');
    // B.0 userData isolé, seedé AVANT require('../main.js') (cf. popups-continue).
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iao-identifiants-'));
    app.setPath('appData', tmpRoot);
    app.setAppPath(path.join(__dirname, '..'));
    fs.mkdirSync(path.join(tmpRoot, 'ai-manager'), { recursive: true });
    // Coffre seedé pour l'hôte de la fixture. Le secret est chiffré par le VRAI
    // safeStorage si disponible ; sinon valeur factice (noté en B3).
    const trousseauDispo = (() => { try { return safeStorage.isEncryptionAvailable(); } catch (_) { return false; } })();
    const secret = trousseauDispo ? safeStorage.encryptString('S3cret!').toString('base64')
      : Buffer.from('factice').toString('base64');
    fs.writeFileSync(path.join(tmpRoot, 'ai-manager', 'identifiants.json'), JSON.stringify({
      [HOTE]: [{ login: 'moi@exemple.fr', secret, ajoute: 1 }]
    }), 'utf-8');

    menusConstruits.length = 0;
    popups.length = 0;
    focusRecus.length = 0;

    require(MAIN_JS); // l'application réelle (session-created y est branché)

    // Espion des sessions créées ENSUITE (la partition de la webview B) :
    // le handler de main.js court d'abord (pose le preload), le nôtre lit.
    const sessionsVues = [];
    app.on('session-created', (ses) => { sessionsVues.push(ses); });

    // Interception https pour la phase B : la session est créée ICI (après
    // main.js, son handler a posé le preload), puis la webview la charge.
    const partitionB = 'persist:iao-identifiants-b';
    const sesB = session.fromPartition(partitionB);
    sesB.protocol.interceptStringProtocol('https', (demande, callback) => {
      callback({ data: htmlFixture(), mimeType: 'text/html', charset: 'utf-8' });
    });

    // Fenêtre principale de l'application réelle + webview sur la fixture.
    console.log('[B] main.js chargé, attente de la fenêtre index.html…');
    const win = await new Promise((resolve) => {
      const attend = () => {
        const w = BrowserWindow.getAllWindows().find((x) => { try { return x.webContents.getURL().endsWith('index.html'); } catch (e) { return false; } });
        if (w) resolve(w); else setTimeout(attend, 100);
      };
      attend();
    });
    console.log('[B] fenêtre principale prête');
    await win.webContents.executeJavaScript(
      'var wv = document.createElement(\'webview\');' +
      'wv.setAttribute(\'allowpopups\', \'\');' +
      'wv.setAttribute(\'partition\', \'' + partitionB + '\');' +
      'wv.setAttribute(\'src\', \'' + URL_FIXTURE + '\');' +
      'wv.style.width = \'200px\'; wv.style.height = \'200px\';' +
      'document.body.appendChild(wv); \'ok\'');
    console.log('[B] webview ajoutée, attente du guest…');
    const guestB = await attendreGuest();
    console.log('[B] guest prêt');
    await guestB.executeJavaScript('document.getElementById("login").focus(); document.getElementById("login").dispatchEvent(new Event("focusin", { bubbles: true })); document.getElementById("mdp").focus(); document.getElementById("mdp").dispatchEvent(new Event("focusin", { bubbles: true })); "ok"');
    await new Promise(r => setTimeout(r, 800));

    await test('B1 le preload des identifiants est posé sur la session de la webview (session-created de main.js)', async () => {
      assert(sessionsVues.length >= 1, 'aucune session vue via session-created');
      const poses = [];
      for (const ses of sessionsVues) {
        try { poses.push(ses.getPreloads()); } catch (e) { /* getPrereads indisponible */ }
      }
      assert(poses.some((p) => p && p.some((c) => c.indexOf('identifiants-preload.js') !== -1)),
        'le preload identifiants n\'est pas posé sur les sessions : ' + JSON.stringify(poses));
    });

    await test('B2 focus d\'un champ de connexion -> menu réel avec les identifiants de l\'hôte, ancré à la fenêtre principale', async () => {
      assert(menusConstruits.length >= 1, 'aucun menu construit (focus : ' + focusRecus.length + ' signalements)');
      const items = menusConstruits[menusConstruits.length - 1];
      assert(items[0].label === HOTE && items[0].enabled === false, 'en-tête de menu inattendu : ' + JSON.stringify(items[0]));
      assert(items.some((i) => i.label === 'moi@exemple.fr'), 'login absent du menu : ' + JSON.stringify(items.map((i) => i.label)));
      assert(popups.length >= 1, 'popup jamais appelé');
      assert(popups[popups.length - 1].window === win, 'menu ancré à la mauvaise fenêtre');
      assert(typeof popups[popups.length - 1].x === 'number', 'position curseur absente du menu');
    });

    await test('B3 choix dans le menu : remplissage via le coffre si trousseau, sinon refus silencieux (câblage : Menu.popup remplacé)', async () => {
      const items = menusConstruits[menusConstruits.length - 1];
      const itemLogin = items.find((i) => i.label === 'moi@exemple.fr');
      assert(itemLogin, 'item de login absent');
      const avant = await guestB.executeJavaScript('document.getElementById("mdp").value');
      itemLogin.click();
      await new Promise(r => setTimeout(r, 500));
      const apres = await guestB.executeJavaScript('document.getElementById("mdp").value');
      if (trousseauDispo) {
        assert(apres === 'S3cret!', 'mot de passe non rempli après choix du menu (avant : « ' + avant + ' », après : « ' + apres + ' »)');
      } else {
        // Sans trousseau (xvfb sans clé), le coffre refuse de déchiffrer : le
        // choix ne remplit rien — comportement attendu, noté sans échec. Le
        // remplissage lui-même a été validé en A2 par envoi direct du canal.
        console.log('    (trousseau système indisponible dans ce harnais : le déchiffrement de bout en bout n\'est pas vérifiable ici)');
        assert(apres === avant, 'sans trousseau, rien ne doit être rempli (avant : « ' + avant + ' », après : « ' + apres + ' »)');
      }
    });
  await test('B4 popup OAuth réelle (fenêtre fille) : signalement et menu ancrés dans SA fenêtre', async () => {
    // Ouvre une vraie fenêtre fille depuis la webview (politique du dépôt :
    // popup https autorisée) — main.js la suit via did-create-window.
    await guestB.executeJavaScript('document.getElementById("oauth").click(); "ok"');
    let fille = null;
    for (let i = 0; i < 100; i++) {
      fille = BrowserWindow.getAllWindows().find((w) => {
        try { return w.webContents.getURL().indexOf('/oauth') !== -1; } catch (e) { return false; }
      });
      if (fille) break;
      await new Promise(r => setTimeout(r, 100));
    }
    assert(fille, 'fenêtre fille OAuth non ouverte');
    assert(fille !== win, 'la fenêtre fille ne doit pas être la fenêtre principale');
    // Le preload de session couvre aussi la fenêtre fille (même partition) :
    // focus d'un champ dans la fille -> signalement + menu ancré à LA fille.
    menusConstruits.length = 0;
    popups.length = 0;
    focusRecus.length = 0;
    await fille.webContents.executeJavaScript('document.getElementById("login").focus(); document.getElementById("login").dispatchEvent(new Event("focusin", { bubbles: true })); document.getElementById("mdp").focus(); document.getElementById("mdp").dispatchEvent(new Event("focusin", { bubbles: true })); "ok"');
    await new Promise(r => setTimeout(r, 300));
    assert(focusRecus.some((f) => f.url && f.url.indexOf('/oauth') !== -1), 'signalement non reçu depuis la fenêtre fille');
    // Cooldown : franchi par horloge simulée (la proposition précédente date
    // de l'heure réelle).
    const { mock } = require('node:test');
    const maintenantReel = Date.now();
    mock.timers.enable({ apis: ['Date'] });
    try {
      mock.timers.setTime(maintenantReel + 5000);
      await fille.webContents.executeJavaScript('document.getElementById("mdp").dispatchEvent(new Event("focusin", { bubbles: true })); "ok"');
      await new Promise(r => setTimeout(r, 300));
      assert(menusConstruits.length >= 1, 'menu non proposé pour la fenêtre fille');
      assert(popups.length >= 1, 'popup non appelé pour la fenêtre fille');
      assert(popups[popups.length - 1].window === fille, 'le menu doit être ancré à la fenêtre fille');
      // Remplissage DANS la fenêtre fille avec des valeurs DISTINCTES (envoi
      // direct du canal : le déchiffrement dépend du trousseau, absent sous
      // xvfb). La webview d'origine doit conserver exactement son état d'avant
      // (B3 l'a légitimement remplie si un trousseau est présent).
      const avantGuest = JSON.parse(await guestB.executeJavaScript(
        'JSON.stringify({ login: document.getElementById("login").value, mdp: document.getElementById("mdp").value })'));
      fille.webContents.send('iao-identifiants:remplir', { login: 'fille@exemple.fr', motDePasse: 'F1lle!' });
      await new Promise(r => setTimeout(r, 500));
      const etatFille = JSON.parse(await fille.webContents.executeJavaScript(
        'JSON.stringify({ login: document.getElementById("login").value, mdp: document.getElementById("mdp").value })'));
      assert(etatFille.login === 'fille@exemple.fr', 'login non rempli dans la fenêtre fille : ' + etatFille.login);
      assert(etatFille.mdp === 'F1lle!', 'mot de passe non rempli dans la fenêtre fille : ' + etatFille.mdp);
      const apresGuest = JSON.parse(await guestB.executeJavaScript(
        'JSON.stringify({ login: document.getElementById("login").value, mdp: document.getElementById("mdp").value })'));
      assert(JSON.stringify(apresGuest) === JSON.stringify(avantGuest), 'la webview d\'origine doit conserver exactement son état (ni vidée, ni remplie depuis la fille) : ' + JSON.stringify(apresGuest) + ' vs ' + JSON.stringify(avantGuest));
    } finally {
      mock.timers.reset();
    }
  });

  } finally {
    try { fs.rmSync(dossier, { recursive: true, force: true }); } catch (_) { /* */ }
  }

  console.log('\n' + passed + ' ok, ' + failed + ' échec(s)');
  if (failures.length) { for (const f of failures) console.log('ECHEC : ' + f.name + ' : ' + (f.error && f.error.message)); process.exit(1); }
  process.exit(0);
}

app.whenReady().then(run).catch((e) => { console.error('ERREUR harnais :', e); process.exit(1); });
