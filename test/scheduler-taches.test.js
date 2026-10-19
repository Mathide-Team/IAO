'use strict';

// Tâches programmables (issue #199) : scheduler/taches.js, fonctions pures.

const test = require('node:test');
const assert = require('node:assert/strict');

const t = require('../scheduler/taches.js');

const BASE = {
  nom: 'Découper les issues',
  fournisseur: 'claude',
  comptes: { mode: 'liste', profils: ['profil_235', 'profil_236'] },
  repartition: { mode: 'tous', espacementMs: 30000 },
  prompt: 'va lire mes issues, crée un squelette de la tâche divisé en tâches simples',
  programmation: { type: 'periodique', tous: 6, unite: 'heure', depuis: '2026-10-19T07:00:00.000Z' }
};

function tache(surcharge) {
  const r = t.normaliserTache(Object.assign({}, BASE, surcharge));
  assert.equal(r.ok, true, r.erreurs.join(', '));
  return r.tache;
}

// --- Fournisseurs ------------------------------------------------------------

test('registre par défaut : Claude seulement, nouvelle session claude.ai/new', () => {
  assert.deepEqual(Object.keys(t.FOURNISSEURS_PAR_DEFAUT), ['claude']);
  assert.equal(t.FOURNISSEURS_PAR_DEFAUT.claude.urlNouvelleSession, 'https://claude.ai/new');
});

test('enregistrerFournisseur ajoute sans modifier le registre d\'origine', () => {
  const r = t.enregistrerFournisseur(t.FOURNISSEURS_PAR_DEFAUT, { id: 'chatgpt', urlNouvelleSession: 'https://chatgpt.com/' });
  assert.deepEqual(Object.keys(r).sort(), ['chatgpt', 'claude']);
  assert.equal(r.chatgpt.nom, 'chatgpt');
  assert.equal(r.chatgpt.automatisation, 'chatgpt');
  assert.equal('chatgpt' in t.FOURNISSEURS_PAR_DEFAUT, false);
  assert.equal(Object.isFrozen(r), true);
  const ok = t.normaliserTache(Object.assign({}, BASE, { fournisseur: 'chatgpt' }), r);
  assert.equal(ok.ok, true);
});

test('enregistrerFournisseur refuse un id ou une URL invalides', () => {
  assert.throws(() => t.enregistrerFournisseur({}, null), /id attendu/);
  assert.throws(() => t.enregistrerFournisseur({}, { id: 'Pas bon' }), /id attendu/);
  assert.throws(() => t.enregistrerFournisseur({}, { id: 'x', urlNouvelleSession: 'http://x' }), /https/);
  assert.throws(() => t.enregistrerFournisseur({}, { id: 'x' }), /https/);
});

// --- Normalisation -------------------------------------------------------------

test('normaliserTache : valeurs par défaut sûres (inactive, nouvelle session)', () => {
  const x = tache({ nom: '  Découper  ', comptes: { mode: 'liste', profils: [' profil_235', 'profil_235', '', 7] } });
  assert.equal(x.nom, 'Découper');
  assert.equal(x.active, false);
  assert.equal(x.nouvelleSession, true);
  assert.deepEqual(x.comptes, { mode: 'liste', profils: ['profil_235'] });
  assert.equal(x.id, null);
  assert.equal(x.derniereExecution, null);
  assert.equal(x.indexRotation, 0);
});

test('normaliserTache : champs conservés', () => {
  const x = tache({
    id: 'tache-3', active: true, nouvelleSession: false, indexRotation: 2,
    derniereExecution: '2026-10-19T08:00:00Z', comptes: { mode: 'tous' },
    repartition: { mode: 'rotation' }
  });
  assert.equal(x.id, 'tache-3');
  assert.equal(x.active, true);
  assert.equal(x.nouvelleSession, false);
  assert.equal(x.indexRotation, 2);
  assert.equal(x.derniereExecution, '2026-10-19T08:00:00.000Z');
  assert.deepEqual(x.comptes, { mode: 'tous', profils: [] });
  assert.deepEqual(x.repartition, { mode: 'rotation', espacementMs: 0 });
});

test('normaliserTache : répartition absente -> tous, sans espacement ; index invalide -> 0', () => {
  const x = tache({ repartition: undefined, indexRotation: -1, derniereExecution: 'pas une date' });
  assert.deepEqual(x.repartition, { mode: 'tous', espacementMs: 0 });
  assert.equal(x.indexRotation, 0);
  assert.equal(x.derniereExecution, null);
});

test('normaliserTache : programmation unique', () => {
  const x = tache({ programmation: { type: 'unique', le: '2026-10-20T09:00:00+02:00' } });
  assert.deepEqual(x.programmation, { type: 'unique', le: '2026-10-20T07:00:00.000Z' });
});

test('normaliserTache : toutes les erreurs sont listées', () => {
  const r = t.normaliserTache(null);
  assert.equal(r.ok, false);
  assert.equal(r.tache, null);
  assert.deepEqual(r.erreurs, [
    'nom obligatoire', 'fournisseur inconnu', 'prompt obligatoire',
    'comptes : mode « tous » ou « liste » attendu',
    'programmation : type « unique » ou « periodique » attendu'
  ]);
});

test('normaliserTache : erreurs de champ', () => {
  const cas = [
    [{ nom: 'x'.repeat(t.NOM_MAX + 1) }, /nom trop long/],
    [{ nom: 3 }, /nom obligatoire/],
    [{ prompt: 'x'.repeat(t.PROMPT_MAX + 1) }, /prompt trop long/],
    [{ prompt: null }, /prompt obligatoire/],
    [{ fournisseur: 'toString' }, /fournisseur inconnu/],
    [{ comptes: { mode: 'liste', profils: [] } }, /au moins un profil/],
    [{ comptes: { mode: 'liste' } }, /au moins un profil/],
    [{ repartition: { mode: 'hasard' } }, /mode « tous » ou « rotation »/],
    [{ repartition: { mode: 'tous', espacementMs: -1 } }, /espacement/],
    [{ repartition: { mode: 'tous', espacementMs: 1.5 } }, /espacement/],
    [{ repartition: { mode: 'tous', espacementMs: t.ESPACEMENT_MAX_MS + 1 } }, /espacement/],
    [{ programmation: { type: 'unique', le: 'demain' } }, /date « le » invalide/],
    [{ programmation: { type: 'periodique', tous: 1, unite: 'heure', depuis: 'x' } }, /date « depuis »/],
    [{ programmation: { type: 'periodique', tous: 1, unite: 'siecle', depuis: BASE.programmation.depuis } }, /unité inconnue/],
    [{ programmation: { type: 'periodique', tous: 0, unite: 'jour', depuis: BASE.programmation.depuis } }, /entier > 0/],
    [{ programmation: { type: 'periodique', tous: 4, unite: 'minute', depuis: BASE.programmation.depuis } }, /5 minutes/]
  ];
  for (const [surcharge, motif] of cas) {
    const r = t.normaliserTache(Object.assign({}, BASE, surcharge));
    assert.equal(r.ok, false, JSON.stringify(surcharge));
    assert.match(r.erreurs.join(' | '), motif);
  }
  assert.equal(t.normaliserTache(Object.assign({}, BASE, {
    programmation: { type: 'periodique', tous: 5, unite: 'minute', depuis: BASE.programmation.depuis }
  })).ok, true);
  assert.equal(t.normaliserTache(Object.assign({}, BASE, {
    programmation: { type: 'periodique', tous: 1, unite: 'mois', depuis: BASE.programmation.depuis }
  })).ok, true);
});

test('idSuivant : max + 1, ignore les ids étrangers', () => {
  assert.equal(t.idSuivant([]), 'tache-1');
  assert.equal(t.idSuivant(undefined), 'tache-1');
  assert.equal(t.idSuivant([{ id: 'tache-2' }, { id: 'tache-9' }, { id: 'autre' }, null]), 'tache-10');
});

// --- Programmation ---------------------------------------------------------------

test('ajouterMois reste sur le dernier jour du mois', () => {
  const d = t.ajouterMois(new Date(2026, 0, 31, 9, 0), 1);
  assert.deepEqual([d.getMonth(), d.getDate(), d.getHours()], [1, 28, 9]);
  const e = t.ajouterMois(new Date(2026, 10, 15), 3);
  assert.deepEqual([e.getFullYear(), e.getMonth(), e.getDate()], [2027, 1, 15]);
});

test('prochaineEcheance : inactive ou absente -> null', () => {
  assert.equal(t.prochaineEcheance(null), null);
  assert.equal(t.prochaineEcheance(tache({ active: false })), null);
});

test('prochaineEcheance : unique, une seule fois', () => {
  const x = tache({ active: true, programmation: { type: 'unique', le: '2026-10-20T07:00:00Z' } });
  assert.equal(t.prochaineEcheance(x).toISOString(), '2026-10-20T07:00:00.000Z');
  x.derniereExecution = '2026-10-20T07:00:05Z';
  assert.equal(t.prochaineEcheance(x), null);
});

test('prochaineEcheance : périodique, première occurrence puis la suivante', () => {
  const x = tache({ active: true });
  assert.equal(t.prochaineEcheance(x).toISOString(), '2026-10-19T07:00:00.000Z');
  x.derniereExecution = '2026-10-19T07:00:03Z';
  assert.equal(t.prochaineEcheance(x).toISOString(), '2026-10-19T13:00:00.000Z');
  x.derniereExecution = '2026-10-19T06:00:00Z'; // avant « depuis »
  assert.equal(t.prochaineEcheance(x).toISOString(), '2026-10-19T07:00:00.000Z');
});

test('prochaineEcheance : rattrapage unique après une longue absence, pas de rafale', () => {
  const x = tache({ active: true, derniereExecution: '2026-10-19T07:00:00Z' });
  const dues = t.tachesDues([x], '2026-10-25T10:00:00Z');
  assert.equal(dues.length, 1);
  x.derniereExecution = '2026-10-25T10:00:00Z'; // exécutée au rattrapage
  assert.equal(t.prochaineEcheance(x).toISOString(), '2026-10-25T13:00:00.000Z');
  assert.equal(t.tachesDues([x], '2026-10-25T10:00:01Z').length, 0);
});

test('prochaineEcheance : mensuelle, fin de mois', () => {
  const x = tache({
    active: true,
    programmation: { type: 'periodique', tous: 1, unite: 'mois', depuis: new Date(2026, 0, 31, 9).toISOString() }
  });
  x.derniereExecution = new Date(2026, 0, 31, 9, 1).toISOString();
  const e = t.prochaineEcheance(x);
  assert.deepEqual([e.getMonth(), e.getDate()], [1, 28]);
  x.derniereExecution = new Date(2026, 5, 2).toISOString();
  const f = t.prochaineEcheance(x);
  assert.deepEqual([f.getMonth(), f.getDate()], [5, 30]);
});

test('tachesDues : seulement les échéances atteintes', () => {
  const a = tache({ active: true });
  const b = tache({ active: true, programmation: { type: 'unique', le: '2026-12-01T00:00:00Z' } });
  const c = tache({ active: false });
  assert.deepEqual(t.tachesDues([a, b, c], '2026-10-19T07:00:00Z'), [a]);
  assert.deepEqual(t.tachesDues(undefined, new Date()), []);
});

// --- Comptes et plan ---------------------------------------------------------------

const COMPTES = [
  { profile: 'profil_235', services: ['claude', 'chatgpt'] },
  { profile: 'profil_236', services: ['chatgpt'] },
  { profile: 'profil_237', services: ['claude'] },
  { profile: 'profil_238' }
];

test('comptesEligibles : liste, service absent, introuvable', () => {
  const x = tache({ comptes: { mode: 'liste', profils: ['profil_235', 'profil_236', 'profil_999', 'profil_238'] } });
  assert.deepEqual(t.comptesEligibles(x, COMPTES), {
    eligibles: ['profil_235'],
    exclus: [
      { profil: 'profil_236', raison: 'service-absent' },
      { profil: 'profil_999', raison: 'introuvable' },
      { profil: 'profil_238', raison: 'service-absent' }
    ]
  });
});

test('comptesEligibles : tous les comptes ayant le service', () => {
  const x = tache({ comptes: { mode: 'tous' } });
  assert.deepEqual(t.comptesEligibles(x, COMPTES).eligibles, ['profil_235', 'profil_237']);
  assert.deepEqual(t.comptesEligibles(x, null), { eligibles: [], exclus: [] });
});

test('planExecution : tous, espacés', () => {
  const x = tache({});
  assert.deepEqual(t.planExecution(x, ['a', 'b', 'c']), {
    etapes: [{ profil: 'a', delaiMs: 0 }, { profil: 'b', delaiMs: 30000 }, { profil: 'c', delaiMs: 60000 }],
    indexRotation: 0
  });
});

test('planExecution : rotation, un compte à tour de rôle', () => {
  const x = tache({ repartition: { mode: 'rotation' }, indexRotation: 4 });
  assert.deepEqual(t.planExecution(x, ['a', 'b', 'c']), { etapes: [{ profil: 'b', delaiMs: 0 }], indexRotation: 2 });
  x.indexRotation = 2;
  assert.deepEqual(t.planExecution(x, ['a', 'b', 'c']), { etapes: [{ profil: 'c', delaiMs: 0 }], indexRotation: 0 });
});

test('planExecution : aucun compte éligible', () => {
  const x = tache({ indexRotation: 1 });
  assert.deepEqual(t.planExecution(x, []), { etapes: [], indexRotation: 1 });
});
