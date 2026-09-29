'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const {
  cooldownKey,
  getNewlyExpiredCooldowns,
  snapshotActiveCooldowns
} = require('../lib/cooldown-notify.js');

// --- cooldownKey -----------------------------------------------------------

test('cooldownKey produit une clé unique par couple compte/service', () => {
  assert.equal(cooldownKey('acc_1', 'claude'), 'acc_1::claude');
  assert.notEqual(cooldownKey('acc_1', 'claude'), cooldownKey('acc_1', 'chatgpt'));
  assert.notEqual(cooldownKey('acc_1', 'claude'), cooldownKey('acc_2', 'claude'));
});

// --- snapshotActiveCooldowns -----------------------------------------------

test('snapshotActiveCooldowns ne capture que les cooldowns actifs (> 0)', () => {
  const accounts = [
    { id: 'acc_1', cooldowns: { claude: Date.now() + 3600000, chatgpt: 0, gemini: Date.now() + 7200000 } },
    { id: 'acc_2', cooldowns: { claude: 0, grok: Date.now() + 1800000 } }
  ];
  const snap = snapshotActiveCooldowns(accounts);
  assert.equal(snap.length, 3); // claude+gemini (acc_1) + grok (acc_2)
  const keys = snap.map(e => e.key || cooldownKey(e.accId, e.svcId));
  // (le snapshot ne met pas `key`, on la calcule pour le test)
  assert.ok(snap.some(e => e.accId === 'acc_1' && e.svcId === 'claude'));
  assert.ok(snap.some(e => e.accId === 'acc_1' && e.svcId === 'gemini'));
  assert.ok(snap.some(e => e.accId === 'acc_2' && e.svcId === 'grok'));
});

test('snapshotActiveCooldowns renvoie un tableau vide sans comptes', () => {
  assert.deepEqual(snapshotActiveCooldowns([]), []);
  assert.deepEqual(snapshotActiveCooldowns(null), []);
});

// --- getNewlyExpiredCooldowns ----------------------------------------------

test('getNewlyExpiredCooldowns détecte un cooldown qui vient d expirer', () => {
  const now = Date.now();
  const previouslyActive = [
    { accId: 'acc_1', svcId: 'claude', endsAt: now - 1000 } // expiré il y a 1s
  ];
  // accounts : le cooldown est maintenant à 0 (le tick l'a effacé)
  const accounts = [{ id: 'acc_1', cooldowns: { claude: 0 } }];
  const expired = getNewlyExpiredCooldowns(accounts, previouslyActive, now);
  assert.equal(expired.length, 1);
  assert.equal(expired[0].accId, 'acc_1');
  assert.equal(expired[0].svcId, 'claude');
});

test('getNewlyExpiredCooldowns ne notifie pas un cooldown encore actif', () => {
  const now = Date.now();
  const previouslyActive = [
    { accId: 'acc_1', svcId: 'claude', endsAt: now + 3600000 } // encore 1h
  ];
  const accounts = [{ id: 'acc_1', cooldowns: { claude: now + 3600000 } }];
  const expired = getNewlyExpiredCooldowns(accounts, previouslyActive, now);
  assert.equal(expired.length, 0);
});

test('getNewlyExpiredCooldowns ne renotifie pas un cooldown réactivé', () => {
  const now = Date.now();
  const previouslyActive = [
    { accId: 'acc_1', svcId: 'claude', endsAt: now - 1000 } // était expiré
  ];
  // Mais l'utilisateur a re-cliqué « Épuiser » : cooldown réactivé
  const accounts = [{ id: 'acc_1', cooldowns: { claude: now + 3600000 } }];
  const expired = getNewlyExpiredCooldowns(accounts, previouslyActive, now);
  assert.equal(expired.length, 0); // pas notifié : toujours actif
});

test('getNewlyExpiredCooldowns gère un snapshot précédent vide', () => {
  const accounts = [{ id: 'acc_1', cooldowns: { claude: 0 } }];
  assert.deepEqual(getNewlyExpiredCooldowns(accounts, [], Date.now()), []);
  assert.deepEqual(getNewlyExpiredCooldowns(accounts, null, Date.now()), []);
});

test('getNewlyExpiredCooldowns gère plusieurs expirations simultanées', () => {
  const now = Date.now();
  const previouslyActive = [
    { accId: 'acc_1', svcId: 'claude', endsAt: now - 500 },
    { accId: 'acc_1', svcId: 'gemini', endsAt: now - 200 },
    { accId: 'acc_2', svcId: 'grok', endsAt: now + 10000 } // encore actif
  ];
  const accounts = [
    { id: 'acc_1', cooldowns: { claude: 0, gemini: 0 } },
    { id: 'acc_2', cooldowns: { grok: now + 10000 } }
  ];
  const expired = getNewlyExpiredCooldowns(accounts, previouslyActive, now);
  assert.equal(expired.length, 2);
  assert.ok(expired.some(e => e.svcId === 'claude'));
  assert.ok(expired.some(e => e.svcId === 'gemini'));
});

// --- Cas limites (couverture 100 %) ----------------------------------------

test('getNewlyExpiredCooldowns retombe sur Date.now() quand now est invalide', () => {
  const previouslyActive = [{ accId: 'acc_1', svcId: 'claude', endsAt: Date.now() - 1000 }];
  const accounts = [{ id: 'acc_1', cooldowns: { claude: 0 } }];
  for (const now of [undefined, null, 0, NaN, 'pas-un-nombre']) {
    const expired = getNewlyExpiredCooldowns(accounts, previouslyActive, now);
    assert.equal(expired.length, 1);
    assert.equal(expired[0].key, 'acc_1::claude');
  }
});

test('getNewlyExpiredCooldowns tolère des comptes absents ou non tableau', () => {
  const now = Date.now();
  const previouslyActive = [{ accId: 'acc_1', svcId: 'claude', endsAt: now - 1000 }];
  // Sans liste de comptes exploitable, plus rien n'est actif : expiration notifiée.
  for (const accounts of [null, undefined, {}, 'x']) {
    assert.equal(getNewlyExpiredCooldowns(accounts, previouslyActive, now).length, 1);
  }
});

test('getNewlyExpiredCooldowns ignore les comptes invalides ou sans cooldowns', () => {
  const now = Date.now();
  const previouslyActive = [{ accId: 'acc_1', svcId: 'claude', endsAt: now - 1000 }];
  const accounts = [
    null,
    undefined,
    { id: 'acc_0' },
    { id: 'acc_9', cooldowns: null },
    { id: 'acc_1', cooldowns: { claude: 0, gemini: 'abc', grok: null } }
  ];
  const expired = getNewlyExpiredCooldowns(accounts, previouslyActive, now);
  assert.equal(expired.length, 1);
  assert.equal(expired[0].svcId, 'claude');
});

test('getNewlyExpiredCooldowns ignore les entrées du snapshot invalides ou inactives', () => {
  const now = Date.now();
  const previouslyActive = [
    null,
    undefined,
    {},
    { accId: 'acc_1' },
    { svcId: 'claude' },
    { accId: 'acc_1', svcId: 'claude', endsAt: 0 },
    { accId: 'acc_1', svcId: 'gemini', endsAt: 'abc' },
    { accId: 'acc_1', svcId: 'grok' },
    { accId: 'acc_1', svcId: 'suno', endsAt: now - 1 }
  ];
  const accounts = [{ id: 'acc_1', cooldowns: {} }];
  const expired = getNewlyExpiredCooldowns(accounts, previouslyActive, now);
  assert.deepEqual(expired, [{ accId: 'acc_1', svcId: 'suno', key: 'acc_1::suno' }]);
});

test('getNewlyExpiredCooldowns traite endsAt === now comme expiré', () => {
  const now = 1700000000000;
  const previouslyActive = [{ accId: 'acc_1', svcId: 'claude', endsAt: now }];
  const accounts = [{ id: 'acc_1', cooldowns: { claude: 0 } }];
  assert.equal(getNewlyExpiredCooldowns(accounts, previouslyActive, now).length, 1);
});

test('snapshotActiveCooldowns ignore les comptes invalides et les valeurs non numériques', () => {
  const accounts = [
    null,
    undefined,
    { id: 'acc_0' },
    { id: 'acc_9', cooldowns: null },
    { id: 'acc_1', cooldowns: { claude: 'abc', gemini: -5, grok: null, suno: 1234 } }
  ];
  assert.deepEqual(snapshotActiveCooldowns(accounts), [
    { accId: 'acc_1', svcId: 'suno', endsAt: 1234 }
  ]);
  assert.deepEqual(snapshotActiveCooldowns(undefined), []);
  assert.deepEqual(snapshotActiveCooldowns({}), []);
});

// --- Chargement du module selon l'environnement ----------------------------
// Le fichier est chargé via <script> dans index.html (window) et via require()
// (module.exports). On l'évalue dans un bac à sable `vm` pour couvrir chaque
// branche de l'export.

const SOURCE_PATH = path.join(__dirname, '..', 'lib', 'cooldown-notify.js');
const SOURCE = fs.readFileSync(SOURCE_PATH, 'utf8');

function loadInSandbox(sandbox) {
  vm.createContext(sandbox);
  new vm.Script(SOURCE, { filename: SOURCE_PATH }).runInContext(sandbox);
  return sandbox;
}

test('chargé dans un renderer (window), il expose ses fonctions globalement', () => {
  const sandbox = loadInSandbox({ window: {} });
  assert.equal(typeof sandbox.window.cooldownKey, 'function');
  assert.equal(typeof sandbox.window.getNewlyExpiredCooldowns, 'function');
  assert.equal(typeof sandbox.window.snapshotActiveCooldowns, 'function');
  assert.equal(sandbox.window.cooldownKey('a', 'b'), 'a::b');
  assert.equal(sandbox.module, undefined);
});

test('chargé avec module.exports (sans window), il exporte ses fonctions', () => {
  const sandbox = loadInSandbox({ module: { exports: {} } });
  assert.deepEqual(Object.keys(sandbox.module.exports).sort(), [
    'cooldownKey',
    'getNewlyExpiredCooldowns',
    'snapshotActiveCooldowns'
  ]);
  assert.equal(sandbox.module.exports.cooldownKey('a', 'b'), 'a::b');
});

test('chargé sans window ni module exploitable, il ne plante pas et n exporte rien', () => {
  // Ni window, ni module : aucune exportation, aucune exception.
  assert.doesNotThrow(() => loadInSandbox({}));
  // module présent mais sans exports : même comportement.
  const sandbox = { module: {} };
  assert.doesNotThrow(() => loadInSandbox(sandbox));
  assert.deepEqual(sandbox.module, {});
});
