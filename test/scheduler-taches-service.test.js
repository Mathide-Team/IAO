'use strict';

// Tâches programmables, lot 3 (issue #199) : scheduler/taches-service.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { TachesService, registerTachesIPC, resultatEnvoi, HISTORIQUE_MAX } = require('../scheduler/taches-service.js');

const ENTREE = {
  nom: 'Découper',
  fournisseur: 'claude',
  comptes: { mode: 'liste', profils: ['profil_235', 'profil_236'] },
  repartition: { mode: 'tous', espacementMs: 30000 },
  prompt: 'va lire mes issues',
  programmation: { type: 'periodique', tous: 6, unite: 'heure', depuis: '2026-10-19T07:00:00.000Z' },
  active: true
};
const COMPTES = [
  { profile: 'profil_235', services: ['claude'] },
  { profile: 'profil_236', services: ['chatgpt'] }
];

function creer(t, options) {
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'iao-taches-'));
  t.after(() => fs.rmSync(dossier, { recursive: true, force: true }));
  const horloge = { t: new Date('2026-10-19T07:00:10Z') };
  const journal = [];
  const o = Object.assign({
    dossier,
    maintenant: () => horloge.t,
    journal: (niveau, message) => journal.push(niveau + ' ' + message)
  }, options);
  return { service: new TachesService(o), dossier, horloge, journal, o };
}

test('enregistrer : création (id, état neuf), remplacement (état d\'exécution conservé), persistance', (t) => {
  const { service, dossier, o } = creer(t);
  const r = service.enregistrer(Object.assign({}, ENTREE, { derniereExecution: '2030-01-01T00:00:00Z', indexRotation: 5 }));
  assert.equal(r.ok, true);
  assert.equal(r.tache.id, 'tache-1');
  assert.equal(r.tache.derniereExecution, null);
  assert.equal(r.tache.indexRotation, 0);
  service.dues(COMPTES); // marque l'exécution
  const r2 = service.enregistrer(Object.assign({}, ENTREE, { id: 'tache-1', nom: 'Renommée', derniereExecution: null }));
  assert.equal(r2.tache.nom, 'Renommée');
  assert.equal(r2.tache.derniereExecution, '2026-10-19T07:00:10.000Z');
  assert.equal(service.enregistrer(Object.assign({}, ENTREE, { id: 'tache-9' })).tache.id, 'tache-2');
  const relu = new TachesService(o);
  assert.deepEqual(relu.liste().map(x => x.nom), ['Renommée', 'Découper']);
  assert.ok(fs.existsSync(path.join(dossier, 'taches.json')));
});

test('enregistrer : erreurs renvoyées, rien d\'écrit', (t) => {
  const { service, dossier } = creer(t);
  const r = service.enregistrer({ nom: '' });
  assert.equal(r.ok, false);
  assert.ok(r.erreurs.length > 1);
  assert.equal(fs.existsSync(path.join(dossier, 'taches.json')), false);
});

test('liste : prochaine échéance ; supprimer ; activer', (t) => {
  const { service } = creer(t);
  service.enregistrer(ENTREE);
  service.enregistrer(Object.assign({}, ENTREE, { active: false }));
  assert.deepEqual(service.liste().map(x => x.prochaine), ['2026-10-19T07:00:00.000Z', null]);
  assert.equal(service.activer('tache-2', true).active, true);
  assert.equal(service.activer('tache-2', 'oui').active, false);
  assert.equal(service.activer('absente', true), null);
  assert.equal(service.supprimer('tache-1'), true);
  assert.equal(service.supprimer('tache-1'), false);
  assert.deepEqual(service.liste().map(x => x.id), ['tache-2']);
});

test('dues : plan remis une seule fois, comptes exclus notés, historique', (t) => {
  const { service, horloge, journal } = creer(t);
  service.enregistrer(ENTREE);
  const plans = service.dues(COMPTES);
  assert.deepEqual(plans, [{
    tache: 'tache-1', nom: 'Découper', fournisseur: 'claude', url: 'https://claude.ai/new',
    prompt: 'va lire mes issues', etapes: [{ profil: 'profil_235', delaiMs: 0 }]
  }]);
  assert.deepEqual(service.dues(COMPTES), []); // déjà lancée
  const h = service.derniersEvenements();
  assert.deepEqual(h.map(e => e.profil + ' ' + e.resultat), ['profil_235 lancee', 'profil_236 erreur']);
  assert.equal(h[1].detail, 'compte service-absent');
  assert.ok(journal.some(l => /^warning Tâche « Découper » \(« profil_236 »\) : erreur — compte service-absent/.test(l)));
  horloge.t = new Date('2026-10-19T13:00:00Z');
  assert.equal(service.dues(COMPTES).length, 1);
});

test('dues : rien de dû -> [] ; heures calmes -> reportée, toujours due ensuite', (t) => {
  const calme = { v: true };
  const { service, journal } = creer(t, { heuresCalmes: () => calme.v });
  assert.deepEqual(service.dues(COMPTES), []);
  service.enregistrer(ENTREE);
  assert.deepEqual(service.dues(COMPTES), []);
  assert.ok(journal.some(l => /1 tâche\(s\) reportée\(s\) : heures calmes/.test(l)));
  calme.v = false;
  assert.equal(service.dues(COMPTES).length, 1);
});

test('dues : sans nouvelle session -> url null ; aucun compte éligible noté', (t) => {
  const { service } = creer(t);
  service.enregistrer(Object.assign({}, ENTREE, { nouvelleSession: false, comptes: { mode: 'liste', profils: ['profil_236'] } }));
  const [plan] = service.dues(COMPTES);
  assert.equal(plan.url, null);
  assert.deepEqual(plan.etapes, []);
  assert.deepEqual(service.derniersEvenements(1).map(e => e.resultat), ['aucun-compte']);
});

test('executerMaintenant : ignore la programmation ; tâche absente -> null', (t) => {
  const { service } = creer(t);
  service.enregistrer(Object.assign({}, ENTREE, { active: false }));
  assert.equal(service.executerMaintenant('tache-1', COMPTES).etapes.length, 1);
  assert.equal(service.executerMaintenant('absente', COMPTES), null);
});

test('rapport : résultat connu seulement ; détail tronqué ; historique borné', (t) => {
  const { service, o } = creer(t);
  service.enregistrer(ENTREE);
  assert.equal(service.rapport('absente', 'p', 'envoye'), null);
  assert.equal(service.rapport('tache-1', 'p', 'inconnu'), null);
  assert.equal(service.rapport('tache-1', 'p', 'erreur', 'x'.repeat(500)).detail.length, 300);
  for (let i = 0; i < HISTORIQUE_MAX + 5; i++) service.rapport('tache-1', 'p', 'envoye');
  assert.equal(service.derniersEvenements(1000).length, HISTORIQUE_MAX);
  assert.equal(new TachesService(o).derniersEvenements(1000).length, HISTORIQUE_MAX);
});

test('fichiers illisibles ou non tableaux : ignorés, journalisés ; tâche invalide écartée', (t) => {
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'iao-taches-'));
  t.after(() => fs.rmSync(dossier, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dossier, 'taches.json'), JSON.stringify([ENTREE, { nom: 'invalide' }]));
  fs.writeFileSync(path.join(dossier, 'taches-historique.json'), '{pas du json');
  const journal = [];
  const s = new TachesService({ dossier, journal: (n, m) => journal.push(n + ' ' + m) });
  assert.equal(s.liste().length, 1);
  assert.deepEqual(s.derniersEvenements(), []);
  assert.ok(journal.some(l => /^warning Tâches : .*illisible/.test(l)));
  fs.writeFileSync(path.join(dossier, 'taches.json'), '{"a":1}');
  assert.equal(new TachesService({ dossier }).liste().length, 0);
});

test('écriture impossible : journalisée, sans lever', (t) => {
  const { o } = creer(t);
  const journal = [];
  const fauxFs = Object.assign({}, fs, { writeFileSync() { throw new Error('disque plein'); } });
  const s = new TachesService(Object.assign({}, o, { fs: fauxFs, journal: (n, m) => journal.push(n + ' ' + m) }));
  assert.equal(s.enregistrer(ENTREE).ok, true);
  assert.ok(journal.some(l => /^error Tâches : écriture .*\(disque plein\)/.test(l)), journal.join(' / '));
});

test('valeurs par défaut : horloge réelle, pas d\'heures calmes, journal muet', (t) => {
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'iao-taches-'));
  t.after(() => fs.rmSync(dossier, { recursive: true, force: true }));
  const s = new TachesService({ dossier });
  s.enregistrer(Object.assign({}, ENTREE, { programmation: { type: 'unique', le: '2000-01-01T00:00:00Z' } }));
  assert.equal(s.dues(COMPTES).length, 1);
  assert.throws(() => new TachesService(), /path/);
});

test('resultatEnvoi : correspondance avec runClaudeJob', () => {
  assert.deepEqual(resultatEnvoi({ ok: true, method: 'keyboard' }), { resultat: 'envoye', detail: 'keyboard' });
  assert.deepEqual(resultatEnvoi({ ok: true }), { resultat: 'envoye', detail: null });
  assert.deepEqual(resultatEnvoi({ error: 'quota_exhausted', quotaTime: '18:00' }), { resultat: 'quota', detail: '18:00' });
  assert.deepEqual(resultatEnvoi({ error: 'quota_exhausted' }), { resultat: 'quota', detail: null });
  assert.deepEqual(resultatEnvoi({ error: 'quiet_hours' }), { resultat: 'heures-calmes', detail: null });
  assert.equal(resultatEnvoi({ error: 'Aucune webview ouverte pour le profil « p ».' }).resultat, 'non-connecte');
  assert.equal(resultatEnvoi({ error: 'element_not_found' }).resultat, 'non-connecte');
  assert.deepEqual(resultatEnvoi({ error: 'boum' }), { resultat: 'erreur', detail: 'boum' });
  assert.deepEqual(resultatEnvoi(null), { resultat: 'erreur', detail: 'inconnue' });
});

test('registerTachesIPC : canaux, erreurs converties en { error }', async (t) => {
  const { service } = creer(t);
  const h = {};
  registerTachesIPC({ handle: (canal, fn) => { h[canal] = fn; } }, service);
  assert.deepEqual(Object.keys(h).sort(), ['taches:delete', 'taches:dues', 'taches:history', 'taches:list',
    'taches:report', 'taches:run-now', 'taches:save', 'taches:set-active']);
  assert.equal((await h['taches:save'](null, ENTREE)).ok, true);
  assert.equal((await h['taches:list'](null)).length, 1);
  assert.equal((await h['taches:set-active'](null, 'tache-1', false)).active, false);
  assert.equal((await h['taches:run-now'](null, 'tache-1', COMPTES)).etapes.length, 1);
  assert.deepEqual(await h['taches:dues'](null, COMPTES), []);
  assert.equal((await h['taches:report'](null, 'tache-1', 'profil_235', { ok: true })).resultat, 'envoye');
  assert.equal((await h['taches:history'](null, 1))[0].resultat, 'envoye');
  assert.equal(await h['taches:delete'](null, 'tache-1'), true);
  service.liste = () => { throw new Error('boum'); };
  assert.deepEqual(await h['taches:list'](null), { error: 'boum' });
  service.liste = () => { throw 'brut'; }; // eslint-disable-line no-throw-literal
  assert.deepEqual(await h['taches:list'](null), { error: 'brut' });
});
