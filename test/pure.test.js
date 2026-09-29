'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { escapeHtml } = require('../lib/escape-html.js');
const { isAllowedPopup, ALLOWED_POPUP_HOSTS } = require('../lib/popup-guard.js');

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

// --- isAllowedPopup (chantier B) --------------------------------------------

test('isAllowedPopup accepte un domaine exact de la liste', () => {
  assert.equal(isAllowedPopup('https://claude.ai/login'), true);
});

test('isAllowedPopup accepte un sous-domaine', () => {
  assert.equal(isAllowedPopup('https://accounts.google.com/o/oauth2'), true);
});

test('isAllowedPopup refuse un domaine hors liste', () => {
  assert.equal(isAllowedPopup('https://evil.example.com'), false);
});

test('isAllowedPopup refuse un domaine qui ne fait que CONTENIR un hôte autorisé', () => {
  // Piège classique : "claude.ai.evil.com" ne doit PAS matcher "claude.ai".
  assert.equal(isAllowedPopup('https://claude.ai.evil.com'), false);
});

test('isAllowedPopup refuse une URL non parsable', () => {
  assert.equal(isAllowedPopup('not a url'), false);
  assert.equal(isAllowedPopup('javascript:alert(1)'), false);
});

test('ALLOWED_POPUP_HOSTS couvre bien les 9 services', () => {
  const services = [
    'claude.ai', 'chatgpt.com', 'gemini.google.com', 'z.ai', 'perplexity.ai',
    'grok.com', 'leonardo.ai', 'suno.com', 'meshy.ai'
  ];
  services.forEach(host => assert.ok(ALLOWED_POPUP_HOSTS.includes(host), host + ' manquant'));
});
