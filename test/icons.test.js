'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

// assets/icons.js est chargé dans le renderer via <script src="assets/icons.js">
// (jamais par require()) et écrit directement sur `window` sans le garde
// typeof window/module utilisé par lib/*.js — volontairement inchangé ici,
// ce module n'a pas besoin d'être require-able côté Node puisqu'il tourne
// toujours dans un vrai navigateur. On le charge donc dans un bac à sable `vm`
// minimal, comme le ferait Electron, pour repérer toute erreur de syntaxe ou
// d'icône incomplète AVANT le lancement de l'app.
//
// Ce fichier de test existe suite à un correctif du 17/09/2026 : l'entrée
// `circle-question` était tronquée (chemin SVG non refermé), ce qui cassait
// la syntaxe de la totalité du fichier — `window.IAO_ICONS` et
// `window.hydrateIcons` n'étaient alors jamais définis, sans qu'aucun test
// existant ne puisse le détecter (voir docs/PROJECT_CONTEXT.md). D'où ce
// filet, volontairement simple : valider que le fichier s'exécute et que
// chaque icône a la forme attendue, pas son rendu visuel.
function loadIcons(extra) {
  const filePath = path.join(__dirname, '..', 'assets', 'icons.js');
  const code = fs.readFileSync(filePath, 'utf8');
  const sandbox = Object.assign({ window: {} }, extra);
  vm.createContext(sandbox);
  new vm.Script(code, { filename: filePath }).runInContext(sandbox);
  return sandbox.window;
}

test('assets/icons.js est syntaxiquement valide et expose IAO_ICONS + hydrateIcons', () => {
  const win = loadIcons();
  assert.equal(typeof win.IAO_ICONS, 'object');
  assert.notEqual(win.IAO_ICONS, null);
  assert.equal(typeof win.hydrateIcons, 'function');
});

test('chaque icône déclarée a un viewBox ("vb") et un tracé ("p") non vides', () => {
  const { IAO_ICONS } = loadIcons();
  const names = Object.keys(IAO_ICONS);
  assert.ok(names.length > 0, 'au moins une icône déclarée');
  for (const name of names) {
    const icon = IAO_ICONS[name];
    assert.equal(typeof icon.vb, 'string', `${name}.vb doit être une chaîne`);
    assert.match(icon.vb, /^\d+ \d+ \d+ \d+$/, `${name}.vb doit être un viewBox "x y w h" (ex: "0 0 512 512")`);
    assert.equal(typeof icon.p, 'string', `${name}.p doit être une chaîne`);
    assert.ok(icon.p.length > 0, `${name}.p ne doit pas être vide`);
  }
});

test('les icônes des actions d\'onglet (17/09/2026) sont présentes', () => {
  const { IAO_ICONS } = loadIcons();
  for (const name of ['arrow-rotate-right', 'house', 'right-from-bracket']) {
    assert.ok(IAO_ICONS[name], `icône manquante : ${name}`);
  }
});

// --- hydrateIcons (issue #79) : DOM simulé minimal ------------------------
// Seuls querySelectorAll (sur la racine) et getAttribute/setAttribute/innerHTML
// (sur les éléments) sont utilisés par hydrateIcons : pas besoin de plus.
function fakeSpan(iconName) {
  const attrs = { 'data-icon': iconName };
  return {
    innerHTML: '',
    getAttribute(name) { return attrs[name]; },
    setAttribute(name, value) { attrs[name] = value; },
    attrs,
  };
}

function fakeRoot(spans) {
  const root = {
    selectors: [],
    querySelectorAll(selector) { root.selectors.push(selector); return spans; },
  };
  return root;
}

test('hydrateIcons remplit chaque span connu par son SVG et le marque comme traité', () => {
  const win = loadIcons();
  const gear = fakeSpan('gear');
  const plus = fakeSpan('plus');
  const root = fakeRoot([gear, plus]);

  win.hydrateIcons(root);

  assert.deepEqual(root.selectors, ['span.ic[data-icon]:not([data-ic-done])']);
  for (const [el, name] of [[gear, 'gear'], [plus, 'plus']]) {
    const d = win.IAO_ICONS[name];
    assert.equal(
      el.innerHTML,
      '<svg viewBox="' + d.vb + '" aria-hidden="true" focusable="false"><path d="' + d.p + '"/></svg>'
    );
    assert.equal(el.attrs['data-ic-done'], '1');
  }
});

test('hydrateIcons laisse vide (et non marqué) un span dont l\'icône est inconnue', () => {
  const win = loadIcons();
  const unknown = fakeSpan('icone-inexistante');
  const known = fakeSpan('house');

  win.hydrateIcons(fakeRoot([unknown, known]));

  assert.equal(unknown.innerHTML, '');
  assert.equal('data-ic-done' in unknown.attrs, false);
  // l'icône inconnue n'interrompt pas le traitement des suivantes
  assert.match(known.innerHTML, /^<svg viewBox="0 0 576 512"/);
  assert.equal(known.attrs['data-ic-done'], '1');
});

test('hydrateIcons sans racine parcourt document', () => {
  const span = fakeSpan('trash');
  const doc = fakeRoot([span]);
  const win = loadIcons({ document: doc });

  win.hydrateIcons();

  assert.equal(doc.selectors.length, 1);
  assert.match(span.innerHTML, /^<svg /);
  assert.equal(span.attrs['data-ic-done'], '1');
});

test('hydrateIcons ne fait rien quand aucun span n\'est à traiter', () => {
  const win = loadIcons();
  const root = fakeRoot([]);
  win.hydrateIcons(root);
  assert.equal(root.selectors.length, 1);
});
