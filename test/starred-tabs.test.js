'use strict';

// test/starred-tabs.test.js — Tests des fonctions pures de lib/starred-tabs.js
// (issue #154 « Onglets étoilés »).

var test = require('node:test');
var assert = require('node:assert');

var starred = require('../lib/starred-tabs');

// --- tabStarKey ----------------------------------------------------------

test('tabStarKey : concatène accId et svcId avec un séparateur |', function() {
  assert.strictEqual(starred.tabStarKey('acc1', 'svc1'), 'acc1|svc1');
  assert.strictEqual(starred.tabStarKey('42', 'claude'), '42|claude');
});

test('tabStarKey : tolère les valeurs nulles/undefined', function() {
  assert.strictEqual(starred.tabStarKey(null, 'svc1'), '|svc1');
  assert.strictEqual(starred.tabStarKey('acc1', null), 'acc1|');
  assert.strictEqual(starred.tabStarKey(undefined, undefined), '|');
});

// --- isTabStarred --------------------------------------------------------

test('isTabStarred : false sur un ensemble vide', function() {
  assert.strictEqual(starred.isTabStarred(new Set(), 'acc1', 'svc1'), false);
});

test('isTabStarred : true si la paire est dans l\'ensemble', function() {
  var s = new Set(['acc1|svc1']);
  assert.strictEqual(starred.isTabStarred(s, 'acc1', 'svc1'), true);
});

test('isTabStarred : false si la paire n\'est pas dans l\'ensemble', function() {
  var s = new Set(['acc1|svc1']);
  assert.strictEqual(starred.isTabStarred(s, 'acc2', 'svc1'), false);
  assert.strictEqual(starred.isTabStarred(s, 'acc1', 'svc2'), false);
});

test('isTabStarred : false si l\'ensemble est null ou invalide', function() {
  assert.strictEqual(starred.isTabStarred(null, 'acc1', 'svc1'), false);
  assert.strictEqual(starred.isTabStarred(undefined, 'acc1', 'svc1'), false);
  assert.strictEqual(starred.isTabStarred({}, 'acc1', 'svc1'), false);
});

// --- toggleTabStar -------------------------------------------------------

test('toggleTabStar : ajoute une étoile absente', function() {
  var s = new Set();
  var result = starred.toggleTabStar(s, 'acc1', 'svc1');
  assert.strictEqual(result.has('acc1|svc1'), true);
});

test('toggleTabStar : retire une étoile présente', function() {
  var s = new Set(['acc1|svc1']);
  var result = starred.toggleTabStar(s, 'acc1', 'svc1');
  assert.strictEqual(result.has('acc1|svc1'), false);
});

test('toggleTabStar : ne mute pas l\'ensemble original (immuable)', function() {
  var s = new Set(['acc1|svc1']);
  starred.toggleTabStar(s, 'acc1', 'svc1');
  assert.strictEqual(s.has('acc1|svc1'), true); // l'original est inchangé
});

test('toggleTabStar : tolère un ensemble null', function() {
  var result = starred.toggleTabStar(null, 'acc1', 'svc1');
  assert.strictEqual(result.has('acc1|svc1'), true);
});

test('toggleTabStar : bascule plusieurs paires indépendamment', function() {
  var s = new Set();
  s = starred.toggleTabStar(s, 'acc1', 'svc1');
  s = starred.toggleTabStar(s, 'acc2', 'svc1');
  s = starred.toggleTabStar(s, 'acc1', 'svc2');
  assert.strictEqual(s.has('acc1|svc1'), true);
  assert.strictEqual(s.has('acc2|svc1'), true);
  assert.strictEqual(s.has('acc1|svc2'), true);
  assert.strictEqual(s.size, 3);
  // Retirer une étoile n'affecte pas les autres
  s = starred.toggleTabStar(s, 'acc2', 'svc1');
  assert.strictEqual(s.has('acc2|svc1'), false);
  assert.strictEqual(s.has('acc1|svc1'), true);
  assert.strictEqual(s.has('acc1|svc2'), true);
  assert.strictEqual(s.size, 2);
});

// --- serializeStarredTabs ------------------------------------------------

test('serializeStarredTabs : sérialise un ensemble en JSON', function() {
  var s = new Set(['acc1|svc1', 'acc2|svc1']);
  var json = starred.serializeStarredTabs(s);
  var parsed = JSON.parse(json);
  assert.ok(Array.isArray(parsed));
  assert.strictEqual(parsed.length, 2);
  assert.ok(parsed.indexOf('acc1|svc1') !== -1);
  assert.ok(parsed.indexOf('acc2|svc1') !== -1);
});

test('serializeStarredTabs : ensemble vide -> tableau vide', function() {
  var json = starred.serializeStarredTabs(new Set());
  assert.strictEqual(json, '[]');
});

test('serializeStarredTabs : null/undefined -> tableau vide', function() {
  assert.strictEqual(starred.serializeStarredTabs(null), '[]');
  assert.strictEqual(starred.serializeStarredTabs(undefined), '[]');
});

test('serializeStarredTabs : filtre les non-strings', function() {
  var s = new Set();
  s.add('acc1|svc1');
  s.add(42);
  s.add('acc2|svc1');
  var json = starred.serializeStarredTabs(s);
  var parsed = JSON.parse(json);
  assert.strictEqual(parsed.length, 2); // seul le nombre est filtré
});

// --- deserializeStarredTabs ----------------------------------------------

test('deserializeStarredTabs : désérialise un JSON valide', function() {
  var json = JSON.stringify(['acc1|svc1', 'acc2|svc1']);
  var s = starred.deserializeStarredTabs(json);
  assert.ok(s instanceof Set);
  assert.strictEqual(s.size, 2);
  assert.strictEqual(s.has('acc1|svc1'), true);
  assert.strictEqual(s.has('acc2|svc1'), true);
});

test('deserializeStarredTabs : JSON vide -> Set vide', function() {
  var s = starred.deserializeStarredTabs('[]');
  assert.strictEqual(s.size, 0);
});

test('deserializeStarredTabs : null/undefined -> Set vide', function() {
  assert.strictEqual(starred.deserializeStarredTabs(null).size, 0);
  assert.strictEqual(starred.deserializeStarredTabs(undefined).size, 0);
});

test('deserializeStarredTabs : JSON invalide -> Set vide (ne throw pas)', function() {
  assert.strictEqual(starred.deserializeStarredTabs('not json').size, 0);
  assert.strictEqual(starred.deserializeStarredTabs('{bad}').size, 0);
});

test('deserializeStarredTabs : non-tableau -> Set vide', function() {
  assert.strictEqual(starred.deserializeStarredTabs('"hello"').size, 0);
  assert.strictEqual(starred.deserializeStarredTabs('{"a":1}').size, 0);
});

test('deserializeStarredTabs : filtre les non-strings du tableau', function() {
  var json = JSON.stringify(['acc1|svc1', 42, null, 'acc2|svc1']);
  var s = starred.deserializeStarredTabs(json);
  assert.strictEqual(s.size, 2);
});

// --- Round-trip sérialisation -------------------------------------------

test('Round-trip : serialize puis deserialize préserve les données', function() {
  var original = new Set(['acc1|svc1', 'acc2|svc2', 'acc3|svc1']);
  var json = starred.serializeStarredTabs(original);
  var restored = starred.deserializeStarredTabs(json);
  assert.strictEqual(restored.size, original.size);
  original.forEach(function(key) {
    assert.strictEqual(restored.has(key), true);
  });
});
