'use strict';

// test/settings.test.js — Tests des fonctions pures de lib/settings.js
// (lot 18/09/2026, FEATURES.md P2 « Panneau de réglages »).

var test = require('node:test');
var assert = require('node:assert');

var settings = require('../lib/settings');

// --- DEFAULT_SETTINGS ----------------------------------------------------

test('DEFAULT_SETTINGS contient toutes les cles attendues', function() {
  var keys = Object.keys(settings.DEFAULT_SETTINGS);
  var expected = ['editorFontSize', 'editorWordWrap', 'theme', 'confirmBeforeClose', 'showAutomationWindows', 'startWithLastSession', 'language'];
  assert.deepStrictEqual(keys.sort(), expected.sort());
});

// --- normalizeEditorFontSize --------------------------------------------

test('normalizeEditorFontSize renvoie la valeur si valide', function() {
  assert.strictEqual(settings.normalizeEditorFontSize(14), 14);
  assert.strictEqual(settings.normalizeEditorFontSize('18'), 18);
});

test('normalizeEditorFontSize borne a la valeur minimale', function() {
  assert.strictEqual(settings.normalizeEditorFontSize(1), settings.EDITOR_FONT_SIZE_MIN);
  assert.strictEqual(settings.normalizeEditorFontSize(0), settings.EDITOR_FONT_SIZE_MIN);
});

test('normalizeEditorFontSize borne a la valeur maximale', function() {
  assert.strictEqual(settings.normalizeEditorFontSize(100), settings.EDITOR_FONT_SIZE_MAX);
});

test('normalizeEditorFontSize renvoie la valeur par defaut si invalide', function() {
  assert.strictEqual(settings.normalizeEditorFontSize('abc'), settings.DEFAULT_SETTINGS.editorFontSize);
  assert.strictEqual(settings.normalizeEditorFontSize(null), settings.DEFAULT_SETTINGS.editorFontSize);
  assert.strictEqual(settings.normalizeEditorFontSize(undefined), settings.DEFAULT_SETTINGS.editorFontSize);
});

// --- normalizeTheme ------------------------------------------------------

test('normalizeTheme renvoie la valeur si valide', function() {
  assert.strictEqual(settings.normalizeTheme('iao'), 'iao');
  assert.strictEqual(settings.normalizeTheme('light'), 'light');
  assert.strictEqual(settings.normalizeTheme('dark'), 'dark');
});

test('normalizeTheme renvoie la valeur par defaut si invalide', function() {
  assert.strictEqual(settings.normalizeTheme('invalid'), settings.DEFAULT_SETTINGS.theme);
  assert.strictEqual(settings.normalizeTheme(null), settings.DEFAULT_SETTINGS.theme);
  assert.strictEqual(settings.normalizeTheme(123), settings.DEFAULT_SETTINGS.theme);
});

// --- normalizeWordWrap ---------------------------------------------------

test('normalizeWordWrap renvoie la valeur si valide', function() {
  assert.strictEqual(settings.normalizeWordWrap('off'), 'off');
  assert.strictEqual(settings.normalizeWordWrap('on'), 'on');
  assert.strictEqual(settings.normalizeWordWrap('wordWrapColumn'), 'wordWrapColumn');
});

test('normalizeWordWrap renvoie la valeur par defaut si invalide', function() {
  assert.strictEqual(settings.normalizeWordWrap('invalid'), settings.DEFAULT_SETTINGS.editorWordWrap);
  assert.strictEqual(settings.normalizeWordWrap(null), settings.DEFAULT_SETTINGS.editorWordWrap);
});

// --- normalizeBoolean ----------------------------------------------------

test('normalizeBoolean accepte true/false', function() {
  assert.strictEqual(settings.normalizeBoolean(true), true);
  assert.strictEqual(settings.normalizeBoolean(false), false);
});

test('normalizeBoolean accepte 1/0', function() {
  assert.strictEqual(settings.normalizeBoolean(1), true);
  assert.strictEqual(settings.normalizeBoolean(0), false);
});

test('normalizeBoolean accepte "true"/"false"', function() {
  assert.strictEqual(settings.normalizeBoolean('true'), true);
  assert.strictEqual(settings.normalizeBoolean('false'), false);
  assert.strictEqual(settings.normalizeBoolean('1'), true);
});

test('normalizeBoolean renvoie false pour autres valeurs', function() {
  assert.strictEqual(settings.normalizeBoolean('yes'), false);
  assert.strictEqual(settings.normalizeBoolean(null), false);
  assert.strictEqual(settings.normalizeBoolean(undefined), false);
});

// --- normalizeSettings ---------------------------------------------------

test('normalizeSettings renvoie tous les defaults pour un objet vide', function() {
  var result = settings.normalizeSettings({});
  assert.strictEqual(result.editorFontSize, 14);
  assert.strictEqual(result.editorWordWrap, 'off');
  assert.strictEqual(result.theme, 'system');
  assert.strictEqual(result.confirmBeforeClose, true);
  assert.strictEqual(result.showAutomationWindows, false);
  assert.strictEqual(result.startWithLastSession, false);
});

test('normalizeSettings normalise les valeurs invalides', function() {
  var raw = {
    editorFontSize: 'abc',
    editorWordWrap: 'invalid',
    theme: 'neon',
    confirmBeforeClose: 'yes',
    showAutomationWindows: 1,
    startWithLastSession: false
  };
  var result = settings.normalizeSettings(raw);
  assert.strictEqual(result.editorFontSize, 14);
  assert.strictEqual(result.editorWordWrap, 'off');
  assert.strictEqual(result.theme, 'system');
  assert.strictEqual(result.confirmBeforeClose, false);
  assert.strictEqual(result.showAutomationWindows, true);
  assert.strictEqual(result.startWithLastSession, false);
});

test('normalizeSettings garde les valeurs valides', function() {
  var raw = {
    editorFontSize: 20,
    editorWordWrap: 'on',
    theme: 'dark',
    confirmBeforeClose: false,
    showAutomationWindows: true,
    startWithLastSession: true
  };
  var result = settings.normalizeSettings(raw);
  assert.strictEqual(result.editorFontSize, 20);
  assert.strictEqual(result.editorWordWrap, 'on');
  assert.strictEqual(result.theme, 'dark');
  assert.strictEqual(result.confirmBeforeClose, false);
  assert.strictEqual(result.showAutomationWindows, true);
  assert.strictEqual(result.startWithLastSession, true);
});

test('normalizeSettings gère null/undefined', function() {
  var result = settings.normalizeSettings(null);
  assert.strictEqual(result.editorFontSize, 14);
  assert.strictEqual(result.theme, 'system');
  var result2 = settings.normalizeSettings(undefined);
  assert.strictEqual(result2.editorFontSize, 14);
});

test('normalizeSettings borne les valeurs extremes', function() {
  var raw = { editorFontSize: 1000 };
  var result = settings.normalizeSettings(raw);
  assert.strictEqual(result.editorFontSize, settings.EDITOR_FONT_SIZE_MAX);
  var raw2 = { editorFontSize: -5 };
  var result2 = settings.normalizeSettings(raw2);
  assert.strictEqual(result2.editorFontSize, settings.EDITOR_FONT_SIZE_MIN);
});

// --- settingsChanged -----------------------------------------------------

test('settingsChanged renvoie false pour objets identiques', function() {
  var a = settings.normalizeSettings({ editorFontSize: 14 });
  var b = settings.normalizeSettings({ editorFontSize: 14 });
  assert.strictEqual(settings.settingsChanged(a, b), false);
});

test('settingsChanged renvoie true pour objets differents', function() {
  var a = settings.normalizeSettings({ editorFontSize: 14 });
  var b = settings.normalizeSettings({ editorFontSize: 18 });
  assert.strictEqual(settings.settingsChanged(a, b), true);
});

test('settingsChanged renvoie true si un objet est null', function() {
  assert.strictEqual(settings.settingsChanged(null, {}), true);
  assert.strictEqual(settings.settingsChanged({}, null), true);
});

// --- language (issue #51, lot 3) ---------------------------------------------

test('normalizeLanguage : auto, codes de locale bien formés, repli sur auto', function() {
  assert.strictEqual(settings.DEFAULT_SETTINGS.language, 'auto');
  assert.strictEqual(settings.normalizeLanguage('auto'), 'auto');
  assert.strictEqual(settings.normalizeLanguage('en'), 'en');
  assert.strictEqual(settings.normalizeLanguage('pt_BR'), 'pt_BR');
  assert.strictEqual(settings.normalizeLanguage('fil'), 'fil');
  ['EN', 'en-US', '../etc', '', null, 3].forEach(function(v) {
    assert.strictEqual(settings.normalizeLanguage(v), 'auto', String(v));
  });
  assert.strictEqual(settings.normalizeSettings({ language: 'de' }).language, 'de');
  assert.strictEqual(settings.normalizeSettings({ language: 'x y' }).language, 'auto');
  assert.strictEqual(settings.normalizeSettings({}).language, 'auto');
});
