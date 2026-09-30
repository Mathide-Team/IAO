'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const {
  compareAccountNames,
  getAccountActivityStatus,
  isTabIdle,
  isAccountAssignable,
  getAssignableAccounts
} = require('../lib/activity-status.js');

// --- compareAccountNames -----------------------------------------------

test('compareAccountNames trie "Compte 2" avant "Compte 10" (numérique, pas lexical)', () => {
  const names = ['Compte 10', 'Compte 2', 'Compte 1'];
  assert.deepEqual([...names].sort(compareAccountNames), ['Compte 1', 'Compte 2', 'Compte 10']);
});

test('compareAccountNames trie par ordre alphabétique simple', () => {
  const names = ['Zoé', 'Alice', 'Marc'];
  assert.deepEqual([...names].sort(compareAccountNames), ['Alice', 'Marc', 'Zoé']);
});

test('compareAccountNames ignore la casse (sensitivity: base)', () => {
  const names = ['bernard', 'Alice'];
  assert.deepEqual([...names].sort(compareAccountNames), ['Alice', 'bernard']);
});

test('compareAccountNames gère null/undefined sans planter', () => {
  assert.equal(compareAccountNames(null, undefined), 0);
  assert.equal(typeof compareAccountNames('Alice', null), 'number');
});

test('compareAccountNames est stable sur des noms identiques', () => {
  assert.equal(compareAccountNames('Compte perso', 'Compte perso'), 0);
});

// --- getAccountActivityStatus -------------------------------------------

test('getAccountActivityStatus renvoie "open" si un onglet est ouvert, peu importe lastUsedAt', () => {
  assert.equal(getAccountActivityStatus({ hasOpenTab: true, lastUsedAt: Date.now() }), 'open');
});

test('getAccountActivityStatus renvoie "idle" si jamais utilisé (lastUsedAt = 0)', () => {
  assert.equal(getAccountActivityStatus({ hasOpenTab: false, lastUsedAt: 0 }), 'idle');
});

test('getAccountActivityStatus renvoie "recent" sous le seuil de 5h', () => {
  const now = Date.now();
  const lastUsedAt = now - (4 * 60 * 60 * 1000); // 4h
  assert.equal(getAccountActivityStatus({ hasOpenTab: false, lastUsedAt, now }), 'recent');
});

test('getAccountActivityStatus renvoie "idle" au-delà du seuil de 5h', () => {
  const now = Date.now();
  const lastUsedAt = now - (6 * 60 * 60 * 1000); // 6h
  assert.equal(getAccountActivityStatus({ hasOpenTab: false, lastUsedAt, now }), 'idle');
});

test('getAccountActivityStatus respecte un thresholdHours personnalisé', () => {
  const now = Date.now();
  const lastUsedAt = now - (2 * 60 * 60 * 1000); // 2h
  assert.equal(getAccountActivityStatus({ hasOpenTab: false, lastUsedAt, now, thresholdHours: 1 }), 'idle');
  assert.equal(getAccountActivityStatus({ hasOpenTab: false, lastUsedAt, now, thresholdHours: 3 }), 'recent');
});

// --- isTabIdle -------------------------------------------------------------

test('isTabIdle renvoie false avant le seuil de 5 minutes', () => {
  const now = Date.now();
  assert.equal(isTabIdle(now - (2 * 60 * 1000), now), false);
});

test('isTabIdle renvoie true au-delà du seuil de 5 minutes', () => {
  const now = Date.now();
  assert.equal(isTabIdle(now - (6 * 60 * 1000), now), true);
});

test('isTabIdle renvoie false pour lastFocusAt = 0 (jamais focalisé)', () => {
  assert.equal(isTabIdle(0, Date.now()), false);
});

test('isTabIdle respecte un thresholdMinutes personnalisé', () => {
  const now = Date.now();
  const lastFocusAt = now - (90 * 1000); // 90s
  assert.equal(isTabIdle(lastFocusAt, now, 2), false);
  assert.equal(isTabIdle(lastFocusAt, now, 1), true);
});

// --- isAccountAssignable (lot 18/09/2026, point 6) -----------------------
// Les tâches ne peuvent être confiées qu'aux comptes verts (plus de 5h
// d'inactivité, pas d'onglet ouvert).

test('isAccountAssignable renvoie true pour un compte vert (plus de 5h, pas d\'onglet)', () => {
  const now = Date.now();
  const lastUsedAt = now - (6 * 60 * 60 * 1000); // 6h
  assert.equal(isAccountAssignable({ hasOpenTab: false, lastUsedAt }, now), true);
});

test('isAccountAssignable renvoie true pour un compte jamais utilisé (lastUsedAt = 0)', () => {
  assert.equal(isAccountAssignable({ hasOpenTab: false, lastUsedAt: 0 }, Date.now()), true);
});

test('isAccountAssignable renvoie false pour un compte avec onglet ouvert', () => {
  const now = Date.now();
  const lastUsedAt = now - (10 * 60 * 60 * 1000); // 10h
  assert.equal(isAccountAssignable({ hasOpenTab: true, lastUsedAt }, now), false);
});

test('isAccountAssignable renvoie false pour un compte rouge (moins de 5h)', () => {
  const now = Date.now();
  const lastUsedAt = now - (3 * 60 * 60 * 1000); // 3h
  assert.equal(isAccountAssignable({ hasOpenTab: false, lastUsedAt }, now), false);
});

test('isAccountAssignable renvoie true au seuil exact de 5h (limite inclusive)', () => {
  const now = Date.now();
  const lastUsedAt = now - (5 * 60 * 60 * 1000); // exactement 5h
  // À 5h exactement, le statut est "idle" (limite >= inclusive), donc assignable
  assert.equal(isAccountAssignable({ hasOpenTab: false, lastUsedAt }, now), true);
});

test('isAccountAssignable respecte un thresholdHours personnalisé', () => {
  const now = Date.now();
  const lastUsedAt = now - (2 * 60 * 60 * 1000); // 2h
  assert.equal(isAccountAssignable({ hasOpenTab: false, lastUsedAt, now, thresholdHours: 1 }), true);
  assert.equal(isAccountAssignable({ hasOpenTab: false, lastUsedAt, now, thresholdHours: 3 }), false);
});

test('isAccountAssignable gère null/undefined sans planter', () => {
  assert.equal(isAccountAssignable(null, Date.now()), false);
  assert.equal(isAccountAssignable(undefined, Date.now()), false);
});

// --- getAssignableAccounts (lot 18/09/2026, point 6) ---------------------

test('getAssignableAccounts filtre les comptes verts uniquement', () => {
  const now = Date.now();
  const accounts = [
    { id: 'a1', name: 'Compte vert', automation: { lastUsedAt: now - (6 * 60 * 60 * 1000) } },
    { id: 'a2', name: 'Compte récent', automation: { lastUsedAt: now - (2 * 60 * 60 * 1000) } },
    { id: 'a3', name: 'Compte jamais utilisé', automation: { lastUsedAt: 0 } }
  ];
  const openAccountIds = new Set(['a2']); // a2 a un onglet ouvert
  const assignable = getAssignableAccounts(accounts, openAccountIds, 5, now);
  assert.equal(assignable.length, 2, 'Deux comptes doivent être assignables (verts)');
  assert.deepEqual(assignable.map(a => a.id), ['a1', 'a3']);
});

test('getAssignableAccounts renvoie un tableau vide si aucun compte vert', () => {
  const now = Date.now();
  const accounts = [
    { id: 'a1', name: 'Récent', automation: { lastUsedAt: now - (1 * 60 * 60 * 1000) } }
  ];
  const openAccountIds = new Set();
  assert.equal(getAssignableAccounts(accounts, openAccountIds, 5, now).length, 0);
});

test('getAssignableAccounts gère un tableau vide', () => {
  assert.deepEqual(getAssignableAccounts([], new Set(), 5, Date.now()), []);
});

// --- Couverture complète : valeurs par défaut et cas limites (issue #75) ---

const H = 60 * 60 * 1000;

test('compareAccountNames : un nom plus court passe avant son extension, et inversement', () => {
  // Tous les segments communs sont égaux : seule la longueur départage.
  assert.equal(compareAccountNames('a1', 'a1b'), -1);
  assert.equal(compareAccountNames('a1b', 'a1'), 1);
});

test('compareAccountNames : segments numériques égaux -> on passe au segment suivant', () => {
  assert.equal(compareAccountNames('a01', 'a1'), 0);
  assert.ok(compareAccountNames('a1 b', 'a01 c') < 0);
});

test('compareAccountNames : segment numérique face à un segment texte', () => {
  assert.notEqual(compareAccountNames('1', 'a'), 0);
  assert.notEqual(compareAccountNames('a', '1'), 0);
});

test('getAccountActivityStatus sans argument : compte jamais utilisé -> idle', () => {
  assert.equal(getAccountActivityStatus(), 'idle');
  assert.equal(getAccountActivityStatus(null), 'idle');
});

test('getAccountActivityStatus utilise Date.now() et le seuil de 5h par défaut', () => {
  assert.equal(getAccountActivityStatus({ lastUsedAt: Date.now() - 4 * H }), 'recent');
  assert.equal(getAccountActivityStatus({ lastUsedAt: Date.now() - 6 * H }), 'idle');
});

test('isTabIdle utilise Date.now() par défaut pour now', () => {
  assert.equal(isTabIdle(Date.now() - 10 * 60 * 1000), true);
  assert.equal(isTabIdle(Date.now() - 1000), false);
});

test('isAccountAssignable utilise Date.now() et le seuil de 5h par défaut', () => {
  assert.equal(isAccountAssignable({ lastUsedAt: Date.now() - 6 * H }), true);
  assert.equal(isAccountAssignable({ lastUsedAt: Date.now() - 4 * H }), false);
});

test('getAssignableAccounts renvoie [] si accounts n\'est pas un tableau', () => {
  assert.deepEqual(getAssignableAccounts(null, new Set(), 5, Date.now()), []);
  assert.deepEqual(getAssignableAccounts(undefined), []);
  assert.deepEqual(getAssignableAccounts({ id: 'a1' }), []);
});

test('getAssignableAccounts accepte openAccountIds sous forme de tableau', () => {
  const accounts = [{ id: 'a1', automation: { lastUsedAt: 0 } }, { id: 'a2', automation: { lastUsedAt: 0 } }];
  assert.deepEqual(getAssignableAccounts(accounts, ['a1'], 5, Date.now()).map(a => a.id), ['a2']);
});

test('getAssignableAccounts accepte openAccountIds absent (aucun onglet ouvert)', () => {
  const accounts = [{ id: 'a1', automation: { lastUsedAt: 0 } }];
  assert.deepEqual(getAssignableAccounts(accounts).map(a => a.id), ['a1']);
});

test('getAssignableAccounts applique now et thresholdHours par défaut (Date.now(), 5h)', () => {
  const accounts = [
    { id: 'vieux', automation: { lastUsedAt: Date.now() - 6 * H } },
    { id: 'recent', automation: { lastUsedAt: Date.now() - 4 * H } }
  ];
  assert.deepEqual(getAssignableAccounts(accounts, new Set()).map(a => a.id), ['vieux']);
});

test('getAssignableAccounts ignore les entrées nulles et les comptes dont l\'automatisation est désactivée', () => {
  const accounts = [
    null,
    undefined,
    { id: 'off', automation: { enabled: false, lastUsedAt: 0 } },
    { id: 'on', automation: { enabled: true, lastUsedAt: 0 } }
  ];
  assert.deepEqual(getAssignableAccounts(accounts, new Set(), 5, Date.now()).map(a => a.id), ['on']);
});

test('getAssignableAccounts traite un compte sans champ automation comme jamais utilisé', () => {
  const accounts = [{ id: 'sans-automation' }];
  assert.deepEqual(getAssignableAccounts(accounts, new Set(), 5, Date.now()).map(a => a.id), ['sans-automation']);
});

// --- Export : contexte navigateur (window) vs Node (module) ----------------

const MODULE_PATH = require.resolve('../lib/activity-status.js');
const EXPORTED = ['compareAccountNames', 'getAccountActivityStatus', 'getServiceActivityStatus', 'activityStatusTitle', 'isTabIdle', 'isAccountAssignable', 'getAssignableAccounts'];

test('en contexte navigateur, les fonctions sont exposées sur window', () => {
  const hadWindow = Object.prototype.hasOwnProperty.call(globalThis, 'window');
  const previous = globalThis.window;
  const fakeWindow = {};
  globalThis.window = fakeWindow;
  delete require.cache[MODULE_PATH];
  try {
    const exported = require(MODULE_PATH);
    for (const name of EXPORTED) {
      assert.equal(typeof fakeWindow[name], 'function', name + ' doit être sur window');
    }
    // Branche window : pas d'export CommonJS.
    assert.deepEqual(Object.keys(exported), []);
  } finally {
    if (hadWindow) globalThis.window = previous; else delete globalThis.window;
    delete require.cache[MODULE_PATH];
    require(MODULE_PATH);
  }
});

test('sans window ni module, le chargement ne plante pas et ne crée ni window ni module', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'activity-status.js'), 'utf8');
  const sandbox = {};
  assert.doesNotThrow(() => vm.runInNewContext(source, sandbox, { filename: MODULE_PATH }));
  assert.equal('window' in sandbox, false);
  assert.equal('module' in sandbox, false);
});

// --- Issue #137 : puce par bouton d'IA (compte, service) --------------------

const { getServiceActivityStatus, activityStatusTitle } = require('../lib/activity-status.js');

test('#137 getServiceActivityStatus : bleu seulement pour le service dont l\'onglet est ouvert', () => {
  const tabs = [{ accId: 'a1', svcId: 'claude' }];
  assert.equal(getServiceActivityStatus({ tabs, accId: 'a1', svcId: 'claude' }), 'open');
  assert.equal(getServiceActivityStatus({ tabs, accId: 'a1', svcId: 'chatgpt' }), 'idle');
  assert.equal(getServiceActivityStatus({ tabs, accId: 'a2', svcId: 'claude' }), 'idle', 'autre compte');
});

test('#137 getServiceActivityStatus : rouge / vert selon lastUsedBySvc du service', () => {
  const now = Date.now();
  const lastUsedBySvc = { claude: now - 1 * H, gemini: now - 6 * H };
  assert.equal(getServiceActivityStatus({ accId: 'a1', svcId: 'claude', lastUsedBySvc, now }), 'recent');
  assert.equal(getServiceActivityStatus({ accId: 'a1', svcId: 'gemini', lastUsedBySvc, now }), 'idle');
  assert.equal(getServiceActivityStatus({ accId: 'a1', svcId: 'grok', lastUsedBySvc, now }), 'idle', 'jamais ouvert');
  assert.equal(getServiceActivityStatus({ accId: 'a1', svcId: 'gemini', lastUsedBySvc, now, thresholdHours: 8 }), 'recent');
});

test('#137 getServiceActivityStatus : entrées absentes ou invalides -> idle', () => {
  assert.equal(getServiceActivityStatus(), 'idle');
  assert.equal(getServiceActivityStatus({ tabs: 'x', lastUsedBySvc: 'x', svcId: 'claude' }), 'idle');
  assert.equal(getServiceActivityStatus({ tabs: [null], accId: 'a', svcId: 'b' }), 'idle');
});

test('#137 activityStatusTitle : libellés des trois états', () => {
  assert.equal(activityStatusTitle('open'), 'Onglet ouvert');
  assert.equal(activityStatusTitle('recent'), 'Utilisé il y a moins de 5h');
  assert.equal(activityStatusTitle('idle'), 'Inactif depuis plus de 5h (ou jamais ouvert)');
});

test('#137 câblage : puce dans chaque bouton d\'IA, plus sur l\'avatar', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const app = fs.readFileSync(path.join(__dirname, '..', 'assets', 'app.js'), 'utf-8');
  assert.match(app, /\$\{escapeHtml\(svc\.name\)\}\$\{svcStatusDot\(acc, svc\.id, lastUsedBySvc\)\}.*?<\/button>/s);
  assert.ok(!/account-avatar[^\n]*status-dot/.test(app), 'plus de puce sur l\'avatar');
  assert.match(app, /acc\.automation\.lastUsedBySvc\[svcId\] = acc\.automation\.lastUsedAt;/);
  assert.match(app, /querySelectorAll\('#accountsList \.svc-btn\[data-action="open-service"\]'\)/);
});
