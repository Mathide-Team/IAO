'use strict';

// test/settings-coverage.test.js — Couverture complète de lib/settings.js (bloc d'export, entrées nulles)
// (issue #76, tâche 55.7) : chargement navigateur (window), chargement CommonJS
// et chargement sans aucun des deux. Aucun accès réseau, aucune dépendance.

var test = require('node:test');
var assert = require('node:assert');
var fs = require('node:fs');
var path = require('node:path');
var vm = require('node:vm');

var FILE = path.join(__dirname, '..', 'lib', 'settings.js');
var SOURCE = fs.readFileSync(FILE, 'utf8');

var EXPORTED = [
  'DEFAULT_SETTINGS',
  'normalizeSettings',
  'normalizeEditorFontSize',
  'normalizeTheme',
  'normalizeWordWrap',
  'normalizeBoolean',
  'settingsChanged',
  'buildApplySettingsPlan',
  'serializeOpenTabs',
  'deserializeOpenTabs',
  'buildDeliveryPrompt'
];

// Exécute lib/settings.js dans un contexte isolé, avec le nom de fichier réel
// pour que la couverture soit attribuée à lib/settings.js.
function load(globals) {
  var context = vm.createContext(globals);
  vm.runInContext(SOURCE, context, { filename: FILE });
  return context;
}

test('chargement navigateur : toutes les fonctions sont exposées sur window', function () {
  var win = {};
  var context = load({ window: win });
  assert.strictEqual(context.window, win);
  EXPORTED.forEach(function (name) {
    assert.ok(name in win, name + ' doit être exposé sur window');
  });
  assert.strictEqual(typeof win.normalizeSettings, 'function');
  assert.strictEqual(win.normalizeEditorFontSize(undefined), win.DEFAULT_SETTINGS.editorFontSize);
});

test('chargement navigateur : window prime sur module', function () {
  var win = {};
  var mod = { exports: {} };
  load({ window: win, module: mod });
  assert.ok('buildDeliveryPrompt' in win);
  assert.deepStrictEqual(Object.keys(mod.exports), []);
});

test('chargement CommonJS : module.exports contient toutes les fonctions', function () {
  var mod = { exports: {} };
  load({ module: mod });
  EXPORTED.forEach(function (name) {
    assert.ok(name in mod.exports, name + ' doit être exporté');
  });
});

test('chargement sans window ni module : aucune erreur, aucun export', function () {
  assert.doesNotThrow(function () {
    var context = load({});
    assert.strictEqual(typeof context.normalizeSettings, 'function');
  });
});

test('serializeOpenTabs ignore les entrées null ou undefined', function () {
  var settings = require('../lib/settings');
  var json = settings.serializeOpenTabs([
    null,
    undefined,
    { accId: 'a1', svcId: 'claude' },
    { accId: 'a2' }
  ]);
  assert.deepStrictEqual(JSON.parse(json), [{ accId: 'a1', svcId: 'claude' }]);
});
