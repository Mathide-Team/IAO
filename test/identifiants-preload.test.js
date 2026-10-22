'use strict';

// lib/identifiants-preload.js (issue #278, lot 2) — fonctions pures testées
// avec un DOM factice, plus l'auto-branchement en contexte Electron simulé.

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('path');

const PRELOAD_PATH = path.join(__dirname, '..', 'lib', 'identifiants-preload.js');
const preload = require(PRELOAD_PATH);

// --- DOM factice -----------------------------------------------------------

class FauxInput {
  constructor(o = {}) {
    this.tagName = 'INPUT';
    this.type = o.type || '';
    this.name = o.name || '';
    this.id = o.id || '';
    this._ac = o.autocomplete === undefined ? null : o.autocomplete;
    this._v = o.value || '';
    this.isConnected = o.debranche === true ? false : true;
    this.dispatched = [];
  }
  getAttribute(n) { return n === 'autocomplete' ? this._ac : null; }
  dispatchEvent(ev) { this.dispatched.push(ev && ev.type); return true; }
}
Object.defineProperty(FauxInput.prototype, 'value', {
  get() { return this._v; },
  set(v) { this._v = String(v); },
  configurable: true
});

function fauxDocument() {
  const ecouteurs = [];
  return {
    ecouteurs,
    addEventListener(type, fn, capture) { ecouteurs.push({ type, fn, capture }); }
  };
}

function fauxIpc() {
  const envoyes = [];
  const ecouteurs = new Map();
  return {
    envoyes,
    ecouteurs,
    send: (canal, donnee) => envoyes.push({ canal, donnee }),
    on: (canal, fn) => { ecouteurs.set(canal, fn); }
  };
}

// --- Classification des champs ----------------------------------------------

test('estChampLogin : input texte-like, jamais 2FA ni password', () => {
  assert.equal(preload.estChampLogin(new FauxInput({ type: 'text' })), true);
  assert.equal(preload.estChampLogin(new FauxInput({ type: 'email' })), true);
  assert.equal(preload.estChampLogin(new FauxInput({ type: 'tel' })), true);
  assert.equal(preload.estChampLogin(new FauxInput({})), true); // type absent -> text
  assert.equal(preload.estChampLogin(new FauxInput({ type: 'password' })), false);
  assert.equal(preload.estChampLogin(new FauxInput({ type: 'checkbox' })), false);
  assert.equal(preload.estChampLogin(new FauxInput({ type: 'text', autocomplete: 'one-time-code' })), false);
  assert.equal(preload.estChampLogin(null), false);
  assert.equal(preload.estChampLogin({ tagName: 'TEXTAREA' }), false);
});

test('estChampMotDePasse : type password uniquement', () => {
  assert.equal(preload.estChampMotDePasse(new FauxInput({ type: 'password' })), true);
  assert.equal(preload.estChampMotDePasse(new FauxInput({ type: 'PASSWORD' })), true);
  assert.equal(preload.estChampMotDePasse(new FauxInput({ type: 'text' })), false);
  assert.equal(preload.estChampMotDePasse(null), false);
});

test('estChamp2FA : one-time-code, otp, totp, new-password', () => {
  for (const ac of ['one-time-code', 'one-time-code tel', 'one_time_code']) {
    assert.equal(preload.estChamp2FA(new FauxInput({ type: 'text', autocomplete: ac })), true, ac);
  }
  assert.equal(preload.estChamp2FA(new FauxInput({ type: 'text', name: 'totp_code' })), true);
  assert.equal(preload.estChamp2FA(new FauxInput({ type: 'text', id: 'otp-input' })), true);
  assert.equal(preload.estChamp2FA(new FauxInput({ type: 'password', autocomplete: 'new-password' })), true);
  assert.equal(preload.estChamp2FA(new FauxInput({ type: 'password', autocomplete: 'current-password' })), false);
  assert.equal(preload.estChamp2FA(new FauxInput({ type: 'text' })), false);
  assert.equal(preload.estChamp2FA(null), false);
});

// --- Remplissage ------------------------------------------------------------

test('remplirChamp : setter natif + événements input/change', () => {
  const champ = new FauxInput({ type: 'password' });
  assert.equal(preload.remplirChamp(champ, 'S3cret!'), true);
  assert.equal(champ.value, 'S3cret!');
  assert.deepEqual(champ.dispatched, ['input', 'change']);
  // Repli sans descripteur de prototype (DOM exotique) : la valeur passe quand même.
  const brut = { dispatched: [], dispatchEvent(ev) { this.dispatched.push(ev && ev.type); } };
  assert.equal(preload.remplirChamp(brut, 'x'), true);
  assert.equal(brut.value, 'x');
  assert.equal(preload.remplirChamp(champ, null), false);
});

test('remplirChamp : un setter qui lève n\'effraie pas (false, pas de crash)', () => {
  const champ = new FauxInput({ type: 'password' });
  const proto = Object.getPrototypeOf(champ);
  const desc = Object.getOwnPropertyDescriptor(proto, 'value');
  Object.defineProperty(proto, 'value', {
    configurable: true,
    set() { throw new Error('verrouillé'); }
  });
  try {
    assert.equal(preload.remplirChamp(champ, 'x'), false);
  } finally {
    Object.defineProperty(proto, 'value', desc); // restauration pour les autres tests
  }
});

test('remplirFormulaire : login + mot de passe, jamais 2FA ni champ débranché', () => {
  const login = new FauxInput({ type: 'email' });
  const mdp = new FauxInput({ type: 'password' });
  const fait = preload.remplirFormulaire({ login, motDePasse: mdp }, { login: 'moi@x.fr', motDePasse: 'S3cret!' });
  assert.deepEqual(fait, { login: true, motDePasse: true });
  assert.equal(login.value, 'moi@x.fr');
  assert.equal(mdp.value, 'S3cret!');
  // Champ 2FA en position login : jamais rempli.
  const otp = new FauxInput({ type: 'text', autocomplete: 'one-time-code' });
  const fait2 = preload.remplirFormulaire({ login: otp, motDePasse: mdp }, { login: 'x', motDePasse: 'y' });
  assert.deepEqual(fait2, { login: false, motDePasse: true });
  assert.equal(otp.value, '');
  // Champ débranché (navigué ailleurs) : ignoré.
  const mort = new FauxInput({ type: 'email', debranche: true });
  const fait3 = preload.remplirFormulaire({ login: mort, motDePasse: mdp }, { login: 'x', motDePasse: 'y' });
  assert.deepEqual(fait3, { login: false, motDePasse: true });
  // Sans identifiant : rien.
  assert.deepEqual(preload.remplirFormulaire({ login, motDePasse: mdp }, null), { login: false, motDePasse: false });
  assert.deepEqual(preload.remplirFormulaire(null, { login: 'a', motDePasse: 'b' }), { login: false, motDePasse: false });
});

// --- Écouteurs (focusin + remplissage) --------------------------------------

// Lie des champs à un même <form> factice : closest('form') + querySelector
// (le preload vérifie une portée commune réelle avant de réutiliser un champ).
function lierFormulaire(champs) {
  const form = {
    querySelector(sel) {
      for (const c of champs) {
        if (sel.indexOf('password') !== -1 && c.type === 'password') return c;
        if (sel.indexOf('password') === -1 && c.type !== 'password') return c;
      }
      return null;
    }
  };
  for (const c of champs) c.closest = () => form;
}

test('creerEcouteurs : focus séquence login puis mot de passe, signalement au main', () => {
  const ipc = fauxIpc();
  const ecouteurs = preload.creerEcouteurs(ipc, null);
  const login = new FauxInput({ type: 'email' });
  const mdp = new FauxInput({ type: 'password' });
  lierFormulaire([login, mdp]);
  ecouteurs.surFocus({ target: login });
  // Le champ frère est découvert dès le premier focus (même <form>).
  assert.deepEqual(ipc.envoyes.pop(), { canal: preload.CANAL_FOCUS, donnee: { motDePasse: true } });
  ecouteurs.surFocus({ target: mdp });
  assert.deepEqual(ipc.envoyes.pop(), { canal: preload.CANAL_FOCUS, donnee: { motDePasse: true } });
  assert.equal(ecouteurs.champs.login, login);
  assert.equal(ecouteurs.champs.motDePasse, mdp);
  // Cible non-connexion : aucun signalement.
  ecouteurs.surFocus({ target: new FauxInput({ type: 'checkbox' }) });
  assert.equal(ipc.envoyes.length, 0);
  ecouteurs.surFocus({ target: null });
  assert.equal(ipc.envoyes.length, 0);
});

test('creerEcouteurs : surRemplir remplit les champs mémorisés (le menu vole le focus)', () => {
  const ipc = fauxIpc();
  const ecouteurs = preload.creerEcouteurs(ipc, null);
  const login = new FauxInput({ type: 'email' });
  const mdp = new FauxInput({ type: 'password' });
  lierFormulaire([login, mdp]);
  ecouteurs.surFocus({ target: login });
  ecouteurs.surFocus({ target: mdp });
  const fait = ecouteurs.surRemplir(null, { login: 'moi@x.fr', motDePasse: 'S3cret!' });
  assert.deepEqual(fait, { login: true, motDePasse: true });
  // Un identifiant incomplet ne remplit que ce qu'il peut.
  const fait2 = ecouteurs.surRemplir(null, { motDePasse: 'p' });
  assert.deepEqual(fait2, { login: false, motDePasse: true });
});

test('creerEcouteurs : le focus d\'un SEUL champ découvre l\'autre champ du même formulaire', () => {
  const envoyes = [];
  const ipc = { send: (c, d) => envoyes.push({ c, d }) };
  const login = new FauxInput({ type: 'email' });
  const mdp = new FauxInput({ type: 'password' });
  const form = {
    querySelector(sel) {
      if (sel.indexOf('password') !== -1) return mdp;
      if (sel.indexOf('email') !== -1) return login;
      return null;
    }
  };
  login.closest = () => form;
  mdp.closest = () => form;
  const ecouteurs = preload.creerEcouteurs(ipc, null);
  // Focus du mot de passe seul : le login du même <form> est mémorisé.
  ecouteurs.surFocus({ target: mdp });
  assert.equal(ecouteurs.champs.login, login);
  assert.equal(ecouteurs.champs.motDePasse, mdp);
  assert.deepEqual(envoyes, [{ c: 'iao-identifiants:focus', d: { motDePasse: true } }]);
  // Focus du login seul : le mot de passe du même <form> est mémorisé.
  const ecouteurs2 = preload.creerEcouteurs({ send: () => {} }, null);
  ecouteurs2.surFocus({ target: login });
  assert.equal(ecouteurs2.champs.login, login);
  assert.equal(ecouteurs2.champs.motDePasse, mdp);
});

test('creerEcouteurs : pas de mélange entre formulaires — la paire suit le formulaire ciblé', () => {
  const ecouteurs = preload.creerEcouteurs({ send: () => {} }, null);
  // Deux formulaires distincts sur la même page.
  const loginA = new FauxInput({ type: 'email' });
  const mdpA = new FauxInput({ type: 'password' });
  const loginB = new FauxInput({ type: 'email' });
  const mdpB = new FauxInput({ type: 'password' });
  const formA = { querySelector: (sel) => (sel.indexOf('password') !== -1 ? mdpA : loginA) };
  const formB = { querySelector: (sel) => (sel.indexOf('password') !== -1 ? mdpB : loginB) };
  for (const [c, f] of [[loginA, formA], [mdpA, formA], [loginB, formB], [mdpB, formB]]) c.closest = () => f;
  // Visite du formulaire A (login seul), puis du mot de passe du formulaire B.
  ecouteurs.surFocus({ target: loginA });
  assert.equal(ecouteurs.champs.login, loginA);
  assert.equal(ecouteurs.champs.motDePasse, mdpA, 'frère découvert dans A');
  ecouteurs.surFocus({ target: mdpB });
  // La paire doit suivre B : le login de A est abandonné, celui de B découvert.
  assert.equal(ecouteurs.champs.motDePasse, mdpB);
  assert.equal(ecouteurs.champs.login, loginB, 'la paire doit être reconstruite pour B');
  assert.notEqual(ecouteurs.champs.login, loginA);
  // Remplissage : seul le formulaire B est modifié.
  assert.equal(loginA.value, '');
  assert.equal(mdpA.value, '');
  ecouteurs.surRemplir(null, { login: 'b@x.fr', motDePasse: 'B!' });
  assert.equal(loginB.value, 'b@x.fr');
  assert.equal(mdpB.value, 'B!');
  assert.equal(loginA.value, '', 'le formulaire A ne doit pas être rempli');
  assert.equal(mdpA.value, '', 'le formulaire A ne doit pas être rempli');
});

test('creerEcouteurs : groupes sans <form> -> la paire n\'est PAS réutilisée sans portée vérifiée', () => {
  // Deux zones de connexion sans <form> : rien ne prouve une portée commune,
  // l'ancienne paire doit être abandonnée (aucun mélange entre zones).
  const ecouteurs = preload.creerEcouteurs({ send: () => {} }, null);
  const loginA = new FauxInput({ type: 'email' });
  const mdpB = new FauxInput({ type: 'password' });
  ecouteurs.surFocus({ target: loginA });
  assert.equal(ecouteurs.champs.login, loginA);
  ecouteurs.surFocus({ target: mdpB });
  assert.equal(ecouteurs.champs.motDePasse, mdpB);
  assert.equal(ecouteurs.champs.login, null, 'sans portée vérifiée, la paire doit être abandonnée');
  // Remplissage : le login de la zone A ne doit PAS être rempli.
  ecouteurs.surRemplir(null, { login: 'x@x.fr', motDePasse: 'p' });
  assert.equal(loginA.value, '', 'aucun champ de la zone A ne doit être rempli');
  assert.equal(mdpB.value, 'p');
});

test('creerEcouteurs : champ frère 2FA ou DOM exotique -> pas de devinette', () => {
  // Frère « nouveau mot de passe » (2FA/inscription) : jamais mémorisé.
  const login = new FauxInput({ type: 'email' });
  const mdp2fa = new FauxInput({ type: 'password', autocomplete: 'new-password' });
  const form2fa = { querySelector: (sel) => (sel.indexOf('password') !== -1 ? mdp2fa : login) };
  login.closest = () => form2fa;
  const ecouteurs = preload.creerEcouteurs({ send: () => {} }, null);
  ecouteurs.surFocus({ target: login });
  assert.equal(ecouteurs.champs.login, login);
  assert.equal(ecouteurs.champs.motDePasse, null, 'un champ 2FA ne doit pas être mémorisé');
  // closest qui lève (DOM exotique) : absorbé, pas de champ frère. Le champ
  // mémorisé suivant subit le même closest explosif : la paire est abandonnée
  // sans planter (formulaireDe aussi tolère le DOM exotique).
  const brutal = new FauxInput({ type: 'email' });
  brutal.closest = () => { throw new Error('DOM exotique'); };
  const mdpBrutal = new FauxInput({ type: 'password' });
  mdpBrutal.closest = () => ({ querySelector: () => null }); // formulaire lisible, sans frère
  const ecouteurs2 = preload.creerEcouteurs({ send: () => {} }, null);
  ecouteurs2.surFocus({ target: mdpBrutal });
  assert.equal(ecouteurs2.champs.motDePasse, mdpBrutal);
  ecouteurs2.surFocus({ target: brutal });
  assert.equal(ecouteurs2.champs.login, brutal);
  // Le formulaire du mot de passe mémorisé est lisible, celui du login explose :
  // ils ne peuvent pas être du même formulaire -> la paire est abandonnée.
  assert.equal(ecouteurs2.champs.motDePasse, null, 'la paire doit être abandonnée (formulaire illisible du login)');
});

test('brancher : focusin en capture + canal de remplissage enregistrés', () => {
  const ipc = fauxIpc();
  const document = fauxDocument();
  const ecouteurs = preload.brancher(ipc, document);
  assert.equal(ecouteurs.champs.motDePasse, null);
  const ecoute = document.ecouteurs.find((e) => e.type === 'focusin');
  assert.ok(ecoute, 'focusin écouté');
  assert.equal(ecoute.capture, true);
  assert.ok(ipc.ecouteurs.has(preload.CANAL_REMPLIR));
});

// --- Auto-branchement en contexte Electron simulé -----------------------------

test('auto-branchement : avec electron + document, les écouteurs sont posés', (t) => {
  const document = fauxDocument();
  const ipc = fauxIpc();
  const electron = { ipcRenderer: ipc };
  const globalPrecedent = global.document;
  global.document = document;
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request) {
    if (request === 'electron') return electron;
    return originalLoad.apply(this, arguments);
  };
  try {
    delete require.cache[PRELOAD_PATH];
    require(PRELOAD_PATH);
    assert.ok(document.ecouteurs.some((e) => e.type === 'focusin'), 'focusin écouté après chargement');
    assert.ok(ipc.ecouteurs.has(preload.CANAL_REMPLIR));
  } finally {
    Module._load = originalLoad;
    global.document = globalPrecedent;
    delete require.cache[PRELOAD_PATH];
    require(PRELOAD_PATH); // recharge en mode pur pour les tests suivants
  }
});

test('auto-branchement : sans document (node --test) ou sans ipcRenderer, rien n\'est posé', (t) => {
  const sansDocument = (() => {
    const precedent = global.document;
    delete global.document;
    const electron = { ipcRenderer: fauxIpc() };
    let branche = false;
    const originalLoad = Module._load;
    Module._load = function patchedLoad(request) {
      if (request === 'electron') return { ipcRenderer: { on: () => { branche = true; } } };
      return originalLoad.apply(this, arguments);
    };
    try {
      delete require.cache[PRELOAD_PATH];
      require(PRELOAD_PATH);
      return branche;
    } finally {
      Module._load = originalLoad;
      if (precedent !== undefined) global.document = precedent;
      delete require.cache[PRELOAD_PATH];
      require(PRELOAD_PATH);
    }
  })();
  assert.equal(sansDocument, false, 'sans document, pas de branchement');
  // electron présent mais sans ipcRenderer (process principal simulé).
  let branche2 = false;
  const originalLoad2 = Module._load;
  Module._load = function patchedLoad(request) {
    if (request === 'electron') return { Menu: { branche: true } };
    return originalLoad2.apply(this, arguments);
  };
  try {
    delete require.cache[PRELOAD_PATH];
    require(PRELOAD_PATH);
    branche2 = typeof global.document !== 'undefined' && false; // node : document absent
  } finally {
    Module._load = originalLoad2;
    delete require.cache[PRELOAD_PATH];
    require(PRELOAD_PATH);
  }
  assert.equal(branche2, false);
});

test('champs « bruts » : type/name/id absents ne font planter aucune classification', () => {
  // Couvre les replis `|| ''` des lectures d'attributs (DOM exotique).
  assert.equal(preload.estChampMotDePasse({ tagName: 'INPUT' }), false);
  assert.equal(preload.estChampMotDePasse({ tagName: 'INPUT', type: null }), false);
  assert.equal(preload.estChampLogin({ tagName: 'INPUT' }), true);
  assert.equal(preload.estChamp2FA({ tagName: 'INPUT', type: 'text', getAttribute: () => null }), false);
  assert.equal(preload.estChamp2FA({ tagName: 'INPUT', type: 'text', getAttribute: () => null, name: undefined, id: undefined }), false);
});

test('remplirChamp : sans constructeur Event global, repli sur ownerDocument puis objet minimal', () => {
  const sauveEvent = global.Event;
  global.Event = undefined; // simulateur : plus de Event global (vieilles pages)
  try {
    // 1. Repli sur el.ownerDocument.defaultView.Event.
    class FauxEvent { constructor(nom) { this.type = nom; } }
    const champ1 = new FauxInput({ type: 'password' });
    champ1.ownerDocument = { defaultView: { Event: FauxEvent } };
    assert.equal(preload.remplirChamp(champ1, 'a'), true);
    assert.deepEqual(champ1.dispatched, ['input', 'change']);
    // 2. Ni Event global ni Event du document : objet minimal {type}.
    const champ2 = new FauxInput({ type: 'password' });
    champ2.ownerDocument = {};
    assert.equal(preload.remplirChamp(champ2, 'b'), true);
    assert.deepEqual(champ2.dispatched, ['input', 'change']);
    // 3. dispatchEvent qui lève : absorbé (le framework n'exige pas l'événement).
    const champ3 = new FauxInput({ type: 'password' });
    champ3.dispatchEvent = () => { throw new Error('CSP'); };
    assert.equal(preload.remplirChamp(champ3, 'c'), true);
  } finally {
    global.Event = sauveEvent;
  }
});

test('remplirFormulaire : un champ mot de passe « nouveau mot de passe » (2FA/inscription) n\'est jamais rempli', () => {
  const login = new FauxInput({ type: 'email' });
  const mdp = new FauxInput({ type: 'password', autocomplete: 'new-password' });
  const fait = preload.remplirFormulaire({ login, motDePasse: mdp }, { login: 'x@x.fr', motDePasse: 'p' });
  assert.deepEqual(fait, { login: true, motDePasse: false });
  assert.equal(mdp.value, '');
});

test('auto-branchement : un require d\'electron qui échoue est absorbé (catch couvert)', (t) => {
  // Sur une machine sans paquet electron, require('electron') lève : le module
  // doit rester une bibliothèque pure (le catch du chargement est exercé).
  const Module = require('node:module');
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request) {
    if (request === 'electron') throw new Error('MODULE_NOT_FOUND simulé');
    return originalLoad.apply(this, arguments);
  };
  try {
    delete require.cache[PRELOAD_PATH];
    require(PRELOAD_PATH); // ne doit pas lever
  } finally {
    Module._load = originalLoad;
    delete require.cache[PRELOAD_PATH];
    require(PRELOAD_PATH);
  }
});

test('auto-branchement : un document sans addEventListener ne crée rien (pas de crash)', (t) => {
  const precedent = global.document;
  global.document = {}; // objet sans addEventListener
  let branche = false;
  const Module = require('node:module');
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request) {
    if (request === 'electron') return { ipcRenderer: { on: () => { branche = true; }, send: () => {} } };
    return originalLoad.apply(this, arguments);
  };
  try {
    delete require.cache[PRELOAD_PATH];
    require(PRELOAD_PATH);
    assert.equal(branche, false);
  } finally {
    Module._load = originalLoad;
    global.document = precedent;
    delete require.cache[PRELOAD_PATH];
    require(PRELOAD_PATH);
  }
});
