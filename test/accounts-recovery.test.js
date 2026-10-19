'use strict';

// Issue #186 : comptes absents de l'interface au démarrage, restaurés depuis
// l'instantané de l'ordonnanceur.

const test = require('node:test');
const assert = require('node:assert/strict');
const r = require('../lib/accounts-recovery');

test('accountsFromSnapshot reconstruit id, nom, profil et automatisation ; e-mail vide', () => {
  const out = r.accountsFromSnapshot([
    { id: 'a1', name: ' Compte Un ', profile: ' profil_1 ', automation: { enabled: false, lastUsedAt: '12', lastAutomationAt: 34 } }
  ]);
  assert.deepEqual(out, [{
    id: 'a1', name: 'Compte Un', email: '', profile: 'profil_1',
    automation: { enabled: false, lastUsedAt: 12, lastAutomationAt: 34 }
  }]);
});

test('accountsFromSnapshot : nom absent -> profil ; automatisation absente -> valeurs par défaut', () => {
  const out = r.accountsFromSnapshot([{ id: 'a1', profile: 'p1' }, { id: 'a2', name: '   ', profile: 'p2', automation: 'x' }]);
  assert.equal(out[0].name, 'p1');
  assert.equal(out[1].name, 'p2');
  assert.deepEqual(out[0].automation, { enabled: true, lastUsedAt: 0, lastAutomationAt: 0 });
  assert.deepEqual(out[1].automation, { enabled: true, lastUsedAt: 0, lastAutomationAt: 0 });
});

test('accountsFromSnapshot ignore les entrées invalides et les doublons d\'id ou de profil (invariant 4)', () => {
  const out = r.accountsFromSnapshot([
    null, 'texte', { id: '', profile: 'p' }, { id: 'x', profile: '  ' }, { id: 5, profile: 'p5' },
    { id: 'a1', profile: 'p1' }, { id: 'a1', profile: 'p9' }, { id: 'a2', profile: 'p1' }, { id: 'a3', profile: 'p3' }
  ]);
  assert.deepEqual(out.map((a) => a.id + ':' + a.profile), ['a1:p1', 'a3:p3']);
});

test('accountsFromSnapshot : instantané absent ou non tableau -> liste vide', () => {
  assert.deepEqual(r.accountsFromSnapshot(undefined), []);
  assert.deepEqual(r.accountsFromSnapshot({ id: 'a1' }), []);
});

test('startupAccountsReport : interface vide et instantané non vide -> warning et restauration proposée', () => {
  const rep = r.startupAccountsReport({ status: 'empty', count: 0 }, 70);
  assert.equal(rep.offerRestore, true);
  assert.equal(rep.level, 'warning');
  assert.match(rep.message, /Comptes lus au démarrage : 0 \(stockage de l'interface : empty\) ; instantané de l'ordonnanceur : 70 compte\(s\)\. .*#186/);
});

test('startupAccountsReport : JSON valide mais liste vide -> restauration proposée aussi', () => {
  assert.equal(r.startupAccountsReport({ status: 'ok', count: 0 }, 2).offerRestore, true);
});

test('startupAccountsReport : comptes présents -> info, pas de proposition', () => {
  const rep = r.startupAccountsReport({ status: 'ok', count: 3 }, 3);
  assert.deepEqual(rep, {
    level: 'info',
    message: "Comptes lus au démarrage : 3 (stockage de l'interface : ok) ; instantané de l'ordonnanceur : 3 compte(s).",
    offerRestore: false
  });
});

test('startupAccountsReport : stockage corrompu -> pas de seconde proposition (backup du chantier C)', () => {
  assert.equal(r.startupAccountsReport({ status: 'corrupt', count: 0 }, 5).offerRestore, false);
});

test('startupAccountsReport : entrées invalides -> statut « inconnu », compteurs à 0', () => {
  for (const loaded of [undefined, null, 'x', { status: 'bizarre', count: -2 }, { count: 1.5 }]) {
    const rep = r.startupAccountsReport(loaded, 'x');
    assert.equal(rep.offerRestore, false);
    assert.match(rep.message, /: 0 \(stockage de l'interface : inconnu\) ; instantané de l'ordonnanceur : 0 /);
  }
  assert.equal(r.startupAccountsReport({ status: 'empty', count: 0 }, 0).offerRestore, false);
});
