'use strict';
// Issue #206 : temps de réponse des messages envoyés à la main
// (lib/mesure-reponse.js). Le script injecté est exécuté ici sur un DOM
// simulé ; le harnais Electron (C14) le fait sur une vraie page.
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const M = require('../lib/mesure-reponse');

// DOM minimal : querySelector renvoie l'élément si son sélecteur est « actif ».
function creerPage(options) {
  const o = options || {};
  const actifs = new Set();
  const ecouteurs = {};
  let minuterie = null;
  let horloge = 1000000;
  const visibleEl = { offsetWidth: 10 };
  const document = {
    querySelector(sel) {
      if (sel === o.selecteurInvalide) throw new Error('sélecteur invalide');
      if (!actifs.has(sel)) return null;
      return o.invisible ? { offsetWidth: 0, offsetHeight: 0, getClientRects: () => [] } : visibleEl;
    },
    addEventListener(type, fn) { ecouteurs[type] = fn; }
  };
  const window = {};
  const globals = {
    window, document,
    setInterval(fn) { minuterie = fn; return 1; },
    Date: { now: () => horloge }
  };
  return {
    globals, window, document, actifs,
    avancer(ms) { const fin = horloge + ms; while (horloge < fin) { horloge += 200; if (minuterie) minuterie(); } },
    heure: () => horloge,
    touche(e) { ecouteurs.keydown(e); },
    clic(cible) { ecouteurs.click({ target: cible }); }
  };
}

// Exécute corpsScript (fonction du module, pour la couverture) avec les
// globales de la page simulée, installées jusqu'à la fin du test.
function executer(t, page, service) {
  const cfg = JSON.parse(/\)\((\{[\s\S]*\})\)$/.exec(M.scriptMesure(service))[1]);
  if (!page.installe) {
    page.installe = true;
    const avant = { window: globalThis.window, document: globalThis.document, setInterval: globalThis.setInterval, now: Date.now };
    globalThis.window = page.globals.window;
    globalThis.document = page.globals.document;
    globalThis.setInterval = page.globals.setInterval;
    Date.now = page.globals.Date.now;
    t.after(() => {
      Date.now = avant.now;
      globalThis.setInterval = avant.setInterval;
      delete globalThis.window;
      delete globalThis.document;
    });
  }
  return M.corpsScript(cfg);
}
const avancer = (page, ms) => page.avancer(ms);
const saisie = { tagName: 'TEXTAREA' };
const STREAM = '[data-is-streaming="true"]';

test('services mesurables : discussion oui, générateurs de médias non', () => {
  for (const s of ['claude', 'chatgpt', 'gemini', 'perplexity', 'grok', 'zeta', 'mistral', 'deepseek', 'qwen']) {
    assert.ok(M.estMesurable(s), s);
  }
  for (const s of ['suno', 'leonardo', 'meshy', 'deepl', 'toString', '__proto__']) assert.ok(!M.estMesurable(s), s);
  assert.equal(M.scriptMesure('suno'), '"absent"');
  // Le script injecté est autonome et syntaxiquement valide.
  assert.doesNotThrow(() => new vm.Script(M.scriptMesure('claude')));
  assert.match(M.scriptMesure('claude'), /data-is-streaming/);
});

test('Claude : Entrée -> génération -> fin, une mesure en file', (t) => {
  const p = creerPage();
  assert.equal(executer(t, p, 'claude'), 'ok');
  assert.equal(executer(t, p, 'claude'), 'deja', 'une seconde injection ne double pas les écouteurs');
  avancer(p, 1000); // rien d'armé : la minuterie ne fait rien
  const envoi = p.heure();
  p.touche({ key: 'Enter', shiftKey: false, isComposing: false, target: saisie });
  avancer(p, 400);
  p.actifs.add(STREAM);
  avancer(p, 5000);
  const finAttendue = p.heure() + 200;
  p.actifs.delete(STREAM);
  avancer(p, 1000);
  assert.deepEqual(p.window.__iaoMesureReponseFile, [{ debut: envoi, fin: finAttendue }]);
});

test('envoi ignoré : Maj+Entrée, composition, hors zone de saisie, génération déjà en cours', (t) => {
  const p = creerPage();
  executer(t, p, 'claude');
  p.touche({ key: 'Enter', shiftKey: true, target: saisie });
  p.touche({ key: 'Enter', isComposing: true, target: saisie });
  p.touche({ key: 'Enter', target: { tagName: 'DIV' } });
  p.touche({ key: 'Enter', target: null });
  p.touche({ key: 'a', target: saisie });
  p.actifs.add(STREAM);
  p.touche({ key: 'Enter', target: { tagName: 'INPUT', type: 'text' } });
  avancer(p, 2000);
  p.actifs.delete(STREAM);
  avancer(p, 2000);
  assert.deepEqual(p.window.__iaoMesureReponseFile, []);
});

test('clic sur le bouton d\'envoi (ou un de ses enfants) et zones éditables', (t) => {
  const p = creerPage();
  executer(t, p, 'chatgpt');
  const bouton = { matches: (s) => s === 'button[data-testid="send-button"]', parentNode: null };
  const icone = { matches: () => false, parentNode: bouton };
  const erreur = { matches: () => { throw new Error('x'); }, parentNode: null };
  p.clic(erreur); // matches() qui lève : ignoré
  p.clic({ parentNode: null }); // élément sans matches()
  p.clic(p.document); // document : arrêt de la remontée
  p.clic(icone);
  p.actifs.add('button[data-testid="stop-button"]');
  avancer(p, 1000);
  p.actifs.delete('button[data-testid="stop-button"]');
  avancer(p, 1000);
  assert.equal(p.window.__iaoMesureReponseFile.length, 1);
  // contenteditable et input search arment aussi (deuxième réponse).
  p.touche({ key: 'Enter', target: { isContentEditable: true } });
  p.touche({ key: 'Enter', target: { tagName: 'INPUT', type: 'search' } });
  p.actifs.add('button[aria-label*="stop" i]');
  avancer(p, 600);
  p.actifs.delete('button[aria-label*="stop" i]');
  avancer(p, 1000);
  assert.equal(p.window.__iaoMesureReponseFile.length, 2);
});

test('abandons : génération jamais vue, durée excessive, indicateur invisible ou invalide', (t) => {
  const p = creerPage({ selecteurInvalide: STREAM });
  executer(t, p, 'claude');
  p.touche({ key: 'Enter', target: saisie });
  avancer(p, M.DELAI_DEBUT_MS + 1000); // aucune génération : abandon
  p.actifs.add('button[aria-label="Stop response"]');
  avancer(p, 1000);
  p.actifs.delete('button[aria-label="Stop response"]');
  avancer(p, 1000);
  assert.deepEqual(p.window.__iaoMesureReponseFile, [], 'pas de mesure après abandon');
  p.touche({ key: 'Enter', target: saisie });
  p.actifs.add('button[aria-label="Stop response"]');
  avancer(p, M.DUREE_MAX_MS + 1000); // bloqué : abandon
  p.actifs.delete('button[aria-label="Stop response"]');
  avancer(p, 2000);
  assert.deepEqual(p.window.__iaoMesureReponseFile, []);
  const q = creerPage({ invisible: true });
  executer(t, q, 'claude');
  q.touche({ key: 'Enter', target: saisie });
  q.actifs.add(STREAM); // présent mais invisible : pas une génération
  avancer(q, M.DELAI_DEBUT_MS + 1000);
  assert.deepEqual(q.window.__iaoMesureReponseFile, []);
});

test('file plafonnée à FILE_MAX mesures', (t) => {
  const p = creerPage();
  executer(t, p, 'grok');
  for (let i = 0; i < M.FILE_MAX + 3; i++) {
    p.touche({ key: 'Enter', target: saisie });
    p.actifs.add('button[aria-label="Stop model response"]');
    avancer(p, 400);
    p.actifs.delete('button[aria-label="Stop model response"]');
    avancer(p, 1000);
  }
  assert.equal(p.window.__iaoMesureReponseFile.length, M.FILE_MAX);
});

test('lireMesures : validation des horodatages', () => {
  const t = 2000000000000;
  const ok = { debut: t - 5000.4, fin: t - 1000.6 };
  assert.deepEqual(M.lireMesures(JSON.stringify([ok]), t), [{ debut: t - 5000, fin: t - 1001 }]);
  assert.deepEqual(M.lireMesures('pas du json', t), []);
  assert.deepEqual(M.lireMesures('{"debut":1}', t), []);
  const rejets = [null, { debut: 'a', fin: t }, { debut: t, fin: 'b' }, { debut: 0, fin: t }, { debut: t, fin: t },
    { debut: t - M.DUREE_MAX_MS - 2, fin: t - 1 }, { debut: t, fin: t + M.FIN_FUTURE_MAX_MS + 10 },
    { debut: t - M.FIN_PASSEE_MAX_MS - 20, fin: t - M.FIN_PASSEE_MAX_MS - 10 }];
  assert.deepEqual(M.lireMesures(JSON.stringify(rejets), t), []);
  const beaucoup = Array.from({ length: M.FILE_MAX + 5 }, () => ok);
  assert.equal(M.lireMesures(JSON.stringify(beaucoup), t).length, M.FILE_MAX);
  // Sans horloge fournie : Date.now().
  const n = Date.now();
  assert.equal(M.lireMesures(JSON.stringify([{ debut: n - 100, fin: n }])).length, 1);
});

test('SCRIPT_LECTURE vide la file de la page', () => {
  const ctx = { window: { __iaoMesureReponseFile: [{ debut: 1, fin: 2 }] }, JSON };
  vm.createContext(ctx);
  assert.equal(vm.runInContext(M.SCRIPT_LECTURE, ctx), '[{"debut":1,"fin":2}]');
  assert.equal(ctx.window.__iaoMesureReponseFile.length, 0);
  const vide = { window: {}, JSON };
  vm.createContext(vide);
  assert.equal(vm.runInContext(M.SCRIPT_LECTURE, vide), '[]');
});

test('chargement navigateur : window.iaoMesureReponse', () => {
  const chemin = require.resolve('../lib/mesure-reponse.js');
  delete require.cache[chemin];
  globalThis.window = {};
  try {
    require(chemin);
    assert.equal(typeof globalThis.window.iaoMesureReponse.scriptMesure, 'function');
  } finally {
    delete globalThis.window;
    delete require.cache[chemin];
  }
});
