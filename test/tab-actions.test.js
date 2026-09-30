'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { tabsForAccount, buildDisconnectWarning } = require('../lib/tab-actions.js');

// --- tabsForAccount ---------------------------------------------------

test('tabsForAccount ne renvoie que les onglets du compte demandé', () => {
  const tabs = [
    { id: 't1', accId: 'acc_1', svcId: 'claude' },
    { id: 't2', accId: 'acc_2', svcId: 'chatgpt' },
    { id: 't3', accId: 'acc_1', svcId: 'gemini' }
  ];
  const result = tabsForAccount(tabs, 'acc_1');
  assert.deepEqual(result.map(t => t.id), ['t1', 't3']);
});

test('tabsForAccount renvoie un tableau vide si aucun onglet ne correspond', () => {
  const tabs = [{ id: 't1', accId: 'acc_2', svcId: 'claude' }];
  assert.deepEqual(tabsForAccount(tabs, 'acc_1'), []);
});

test('tabsForAccount gère un tableau vide ou absent sans planter', () => {
  assert.deepEqual(tabsForAccount([], 'acc_1'), []);
  assert.deepEqual(tabsForAccount(undefined, 'acc_1'), []);
  assert.deepEqual(tabsForAccount(null, 'acc_1'), []);
});

test('tabsForAccount ignore les entrées invalides du tableau', () => {
  const tabs = [null, undefined, { id: 't1', accId: 'acc_1' }];
  assert.deepEqual(tabsForAccount(tabs, 'acc_1').map(t => t.id), ['t1']);
});

// --- buildDisconnectWarning ---------------------------------------------

test('buildDisconnectWarning accorde au singulier pour un seul onglet', () => {
  const msg = buildDisconnectWarning({ accountName: 'Compte Démo', profile: 'profil_1', affectedTabsCount: 1 });
  assert.match(msg, /1 onglet ouvert pour ce compte sera rechargé/);
  assert.doesNotMatch(msg, /onglets/);
});

test('buildDisconnectWarning accorde au pluriel pour plusieurs onglets', () => {
  const msg = buildDisconnectWarning({ accountName: 'Compte Démo', profile: 'profil_1', affectedTabsCount: 3 });
  assert.match(msg, /3 onglets ouverts pour ce compte seront rechargés/);
});

test('buildDisconnectWarning signale l\'absence d\'onglet ouvert', () => {
  const msg = buildDisconnectWarning({ accountName: 'Compte Démo', profile: 'profil_1', affectedTabsCount: 0 });
  assert.match(msg, /Aucun onglet de ce compte n'est actuellement ouvert\./);
});

test('buildDisconnectWarning inclut le nom du compte et le profil', () => {
  const msg = buildDisconnectWarning({ accountName: 'Perso', profile: 'profil_3', affectedTabsCount: 2 });
  assert.match(msg, /profil_3/);
  assert.match(msg, /Perso/);
});

test('buildDisconnectWarning gère des champs manquants sans planter', () => {
  assert.doesNotThrow(() => buildDisconnectWarning({}));
  assert.doesNotThrow(() => buildDisconnectWarning());
});

// --- Chargement navigateur (branche window) — issue #72 ----------------------
// Les lignes `window.tabsForAccount` et `window.buildDisconnectWarning` (46-47)
// ne sont pas couvertes par les tests require(). On force le rechargement du
// module avec `global.window` défini pour exécuter la branche `window`.

test('tabsForAccount et buildDisconnectWarning s\'attachent à window (branche navigateur)', () => {
  const modulePath = require.resolve('../lib/tab-actions.js');
  const origWindow = global.window;
  global.window = {};
  delete require.cache[modulePath];
  require('../lib/tab-actions.js');
  assert.equal(typeof global.window.tabsForAccount, 'function');
  assert.equal(typeof global.window.buildDisconnectWarning, 'function');
  const tabs = global.window.tabsForAccount([{ accId: 'a1' }, { accId: 'a2' }], 'a1');
  assert.equal(tabs.length, 1);
  // Restaurer : recharger sans window
  global.window = origWindow;
  delete require.cache[modulePath];
  require('../lib/tab-actions.js');
});
