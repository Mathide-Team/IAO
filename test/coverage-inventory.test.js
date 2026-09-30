'use strict';

// Issue #101 : le seuil de couverture (package.json, test:coverage) ne compte
// que les fichiers CHARGÉS pendant les tests. Sans ce test, supprimer l'unique
// fichier de test d'un module de lib/ le ferait disparaître du rapport au lieu
// de faire échouer le seuil. On charge donc explicitement chaque module pur :
// un module qui n'est plus testé apparaît alors non couvert (< 100 % lignes).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const MODULES = [
  ...fs.readdirSync(path.join(ROOT, 'lib')).filter(f => f.endsWith('.js')).sort().map(f => 'lib/' + f),
  'scheduler/core.js'
];

test('#101 : chaque module pur est chargé par la suite de tests', () => {
  assert.ok(MODULES.length >= 10, 'inventaire inattendu : ' + MODULES.join(', '));
  for (const rel of MODULES) {
    const exported = require(path.join(ROOT, rel));
    assert.equal(typeof exported, 'object', rel + ' doit exporter un objet (module.exports)');
    assert.ok(Object.keys(exported).length > 0, rel + ' n\'exporte rien');
  }
});

test('#101 : test:coverage impose les seuils et exclut test/', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'));
  const cmd = pkg.scripts['test:coverage'];
  assert.match(cmd, /--test-coverage-lines=100\b/);
  assert.match(cmd, /--test-coverage-branches=97\b/);
  assert.match(cmd, /--test-coverage-functions=98\b/);
  assert.match(cmd, /--test-coverage-exclude='test\/\*\*'/);
});
