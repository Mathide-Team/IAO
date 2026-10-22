'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { escapeHtml } = require('../lib/escape-html.js');
const { decidePopup } = require('../lib/popup-guard.js');

// --- escapeHtml (chantier A) ------------------------------------------------

test('escapeHtml échappe les 5 caractères dangereux', () => {
  assert.equal(
    escapeHtml(`<img src=x onerror="a('b')">`),
    '&lt;img src=x onerror=&quot;a(&#39;b&#39;)&quot;&gt;'
  );
});

test('escapeHtml gère null/undefined sans planter', () => {
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(undefined), '');
});

test('escapeHtml convertit les nombres/objets en chaîne', () => {
  assert.equal(escapeHtml(42), '42');
});

test('escapeHtml échappe le & en premier (pas de double échappement)', () => {
  assert.equal(escapeHtml('&amp;'), '&amp;amp;');
});

test('escapeHtml laisse intact un texte sans caractère spécial', () => {
  assert.equal(escapeHtml('Compte perso'), 'Compte perso');
});

// --- Chargement navigateur (branche window) — issue #71 ----------------------
// La ligne `window.escapeHtml = escapeHtml` (ligne 27) n'est pas couverte par les
// tests require() ci-dessus. On force le rechargement du module avec
// `global.window` défini pour exécuter la branche `window`.

test('escapeHtml s\'attache à window quand window existe (branche navigateur)', () => {
  const modulePath = require.resolve('../lib/escape-html.js');
  const origWindow = global.window;
  global.window = {};
  delete require.cache[modulePath];
  require('../lib/escape-html.js');
  assert.equal(typeof global.window.escapeHtml, 'function');
  assert.equal(global.window.escapeHtml('<b>'), '&lt;b&gt;');
  // Restaurer : recharger sans window
  global.window = origWindow;
  delete require.cache[modulePath];
  require('../lib/escape-html.js');
});

// --- decidePopup (chantier B, revue issue #277) -----------------------------
// Toute popup web https est acceptée (la popup hérite des webPreferences
// sandboxées de la webview : aucune origine ne peut gagner de privilèges).
// C'est ce qui rend l'authentification des connecteurs « toujours fonctionnelle »
// (#277) : plus de liste blanche de domaines à maintenir.

test('decidePopup accepte toute URL https, domaine connu ou inconnu', () => {
  assert.equal(decidePopup('https://claude.ai/login'), 'allow');
  assert.equal(decidePopup('https://accounts.google.com/o/oauth2'), 'allow');
  // Issue #277 : le connecteur context7 (origine hors de l'ancienne liste) doit
  // s'authentifier dans l'application, pas dans le navigateur système.
  assert.equal(decidePopup('https://context7.com/oauth/authorize'), 'allow');
  assert.equal(decidePopup('https://nimporte-quel-connecteur.example.io/login'), 'allow');
});

test('decidePopup accepte about:blank (flux OAuth ouverts vides puis redirigés)', () => {
  assert.equal(decidePopup('about:blank'), 'allow');
});

test('decidePopup accepte https quelle que soit la casse du schéma', () => {
  assert.equal(decidePopup('HTTPS://claude.ai/'), 'allow');
});

test('decidePopup refuse les schémas non chiffrés ou non web', () => {
  assert.equal(decidePopup('http://claude.ai/'), 'deny');
  assert.equal(decidePopup('HTTP://autre.example.net/page'), 'deny');
  assert.equal(decidePopup('data:text/html,<script>1</script>'), 'deny');
  assert.equal(decidePopup('javascript:alert(1)'), 'deny');
  assert.equal(decidePopup('file:///etc/passwd'), 'deny');
  assert.equal(decidePopup('about:srcdoc'), 'deny');
});

test('decidePopup refuse une URL non parsable', () => {
  assert.equal(decidePopup('not a url'), 'deny');
  assert.equal(decidePopup(''), 'deny');
  assert.equal(decidePopup(undefined), 'deny');
});
