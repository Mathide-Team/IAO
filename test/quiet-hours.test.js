'use strict';

// test/quiet-hours.test.js — Tests des heures calmes (pause 15h-20h30 Paris)
// (lot 18/09/2026). Fonctions pures de scheduler/core.js, testables via
// node --test sans lancer Electron.

var test = require('node:test');
var assert = require('node:assert');

var core = require('../scheduler/core');

// --- isFrenchQuietHours ----------------------------------------------------

test('isFrenchQuietHours : false avant 15h', function() {
  // 14:59 Paris = 12:59 UTC (été) ou 13:59 UTC (hiver)
  // On construit une date UTC qui correspond à 14:59 Paris en été (UTC+2)
  var date = new Date('2026-07-15T12:59:00Z'); // 14:59 CEST
  assert.strictEqual(core.isFrenchQuietHours(date), false);
});

test('isFrenchQuietHours : true à 15h00 pile', function() {
  var date = new Date('2026-07-15T13:00:00Z'); // 15:00 CEST
  assert.strictEqual(core.isFrenchQuietHours(date), true);
});

test('isFrenchQuietHours : true à 20:29', function() {
  var date = new Date('2026-07-15T18:29:00Z'); // 20:29 CEST
  assert.strictEqual(core.isFrenchQuietHours(date), true);
});

test('isFrenchQuietHours : false à 20:30 pile', function() {
  var date = new Date('2026-07-15T18:30:00Z'); // 20:30 CEST
  assert.strictEqual(core.isFrenchQuietHours(date), false);
});

test('isFrenchQuietHours : false à 10h', function() {
  var date = new Date('2026-07-15T08:00:00Z'); // 10:00 CEST
  assert.strictEqual(core.isFrenchQuietHours(date), false);
});

test('isFrenchQuietHours : false à 23h', function() {
  var date = new Date('2026-07-15T21:00:00Z'); // 23:00 CEST
  assert.strictEqual(core.isFrenchQuietHours(date), false);
});

test('isFrenchQuietHours : true en hiver (UTC+1) à 16h Paris', function() {
  // En hiver, 16:00 Paris = 15:00 UTC
  var date = new Date('2026-01-15T15:00:00Z'); // 16:00 CET
  assert.strictEqual(core.isFrenchQuietHours(date), true);
});

test('isFrenchQuietHours : false en hiver (UTC+1) à 14h Paris', function() {
  // En hiver, 14:00 Paris = 13:00 UTC
  var date = new Date('2026-01-15T13:00:00Z'); // 14:00 CET
  assert.strictEqual(core.isFrenchQuietHours(date), false);
});

test('isFrenchQuietHours : true en hiver à 20h Paris', function() {
  // En hiver, 20:00 Paris = 19:00 UTC
  var date = new Date('2026-01-15T19:00:00Z'); // 20:00 CET
  assert.strictEqual(core.isFrenchQuietHours(date), true);
});

test('isFrenchQuietHours : false en hiver à 21h Paris', function() {
  // En hiver, 21:00 Paris = 20:00 UTC — mais 20:00 UTC = 21:00 CET, hors pause
  var date = new Date('2026-01-15T20:00:00Z'); // 21:00 CET
  assert.strictEqual(core.isFrenchQuietHours(date), false);
});

// --- quietHoursRemainingMs -------------------------------------------------

test('quietHoursRemainingMs : 0 hors pause', function() {
  var date = new Date('2026-07-15T08:00:00Z'); // 10:00 CEST
  assert.strictEqual(core.quietHoursRemainingMs(date), 0);
});

test('quietHoursRemainingMs : > 0 pendant la pause', function() {
  var date = new Date('2026-07-15T13:00:00Z'); // 15:00 CEST
  var remaining = core.quietHoursRemainingMs(date);
  assert.ok(remaining > 0, 'doit être > 0 pendant la pause');
  // À 15:00, il reste 5h30 = 19800s = 19800000ms
  assert.ok(remaining <= 19800000 + 1000, 'doit être <= 5h30');
  assert.ok(remaining >= 19800000 - 1000, 'doit être ~5h30');
});

test('quietHoursRemainingMs : diminue avec le temps', function() {
  var date1 = new Date('2026-07-15T13:00:00Z'); // 15:00 CEST
  var date2 = new Date('2026-07-15T14:00:00Z'); // 16:00 CEST
  var r1 = core.quietHoursRemainingMs(date1);
  var r2 = core.quietHoursRemainingMs(date2);
  assert.ok(r1 > r2, 'le temps restant doit diminuer');
  assert.strictEqual(Math.round((r1 - r2) / 1000), 3600, 'différence = 1h');
});

test('quietHoursRemainingMs : faible juste avant 20:30', function() {
  var date = new Date('2026-07-15T18:29:00Z'); // 20:29 CEST
  var remaining = core.quietHoursRemainingMs(date);
  assert.ok(remaining > 0 && remaining <= 120000, 'doit être <= 2 min');
});

// --- Export vérification ---------------------------------------------------

test('core exporte isFrenchQuietHours et quietHoursRemainingMs', function() {
  assert.strictEqual(typeof core.isFrenchQuietHours, 'function');
  assert.strictEqual(typeof core.quietHoursRemainingMs, 'function');
});

// --- Branches manquantes (issue #80) ----------------------------------------

test('isFrenchQuietHours gère minuit (heure 24 normalisée en 0)', function() {
  // Certains environnements Intl renvoient "24" pour minuit avec hour12: false.
  // La branche `if (hours === 24) hours = 0;` doit normaliser en 0.
  // 00:00 Paris = 22:00 UTC (été) ou 23:00 UTC (hiver) -> hors pause.
  var date = new Date('2026-07-15T22:00:00Z'); // 00:00 CEST (minuit)
  assert.strictEqual(core.isFrenchQuietHours(date), false);
});

test('quietHoursRemainingMs gère le cas où waitSec <= 0', function() {
  // Ce cas ne devrait pas se produire normalement (isFrenchQuietHours filtre
  // avant), mais la branche défensive `if (waitSec <= 0) return 0;` doit être
  // couverte. On mocke isFrenchQuietHours pour forcer l'exécution.
  var orig = core.isFrenchQuietHours;
  core.isFrenchQuietHours = function() { return true; };
  try {
    // 21:00 Paris = hors pause, mais isFrenchQuietHours est mockée à true.
    // currentSec (21*3600=75600) > targetSec (20*3600+30*60=73800) -> waitSec < 0.
    var date = new Date('2026-07-15T19:00:00Z'); // 21:00 CEST
    assert.strictEqual(core.quietHoursRemainingMs(date), 0);
  } finally {
    core.isFrenchQuietHours = orig;
  }
});

// --- Branches supplémentaires (issue #80) -----------------------------------

test('isFrenchQuietHours accepte un timestamp non-Date (branche : new Date)', function() {
  // Passer un nombre (timestamp ms) au lieu d\'un objet Date
  var ts = new Date('2026-07-15T13:00:00Z').getTime(); // 15:00 CEST
  assert.strictEqual(core.isFrenchQuietHours(ts), true);
  var ts2 = new Date('2026-07-15T08:00:00Z').getTime(); // 10:00 CEST
  assert.strictEqual(core.isFrenchQuietHours(ts2), false);
});

test('isFrenchQuietHours utilise Date.now() si now est absent', function() {
  // Sans paramètre, utilise Date.now() — juste vérifier que ça ne plante pas
  var result = core.isFrenchQuietHours();
  assert.strictEqual(typeof result, 'boolean');
});

test('quietHoursRemainingMs accepte un timestamp non-Date (branche : new Date)', function() {
  var ts = new Date('2026-07-15T13:00:00Z').getTime(); // 15:00 CEST
  var remaining = core.quietHoursRemainingMs(ts);
  assert.ok(remaining > 0, 'doit être > 0 pendant la pause');
});

test('quietHoursRemainingMs utilise Date.now() si now est falsy (branche || Date.now())', function() {
  // now = 0 -> falsy -> Date.now() utilisé. On ne peut pas prédire le résultat
  // mais on vérifie juste que ça ne plante pas et renvoie un nombre.
  var result = core.quietHoursRemainingMs(0);
  assert.strictEqual(typeof result, 'number');
});
