'use strict';

// test/taches-ui.test.js — helpers purs de l'interface des tâches
// programmables (issue #199, lot 4, lib/taches-ui.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const ui = require('../lib/taches-ui');

// --- Conversions espacement (minutes <-> ms) ---

test('espacement secondes vers ms', () => {
  assert.strictEqual(ui.espacementSecondesVersMs(0), 0);
  assert.strictEqual(ui.espacementSecondesVersMs(10), 10000);
  assert.strictEqual(ui.espacementSecondesVersMs(86400), 86400000); // max 24 h
  assert.strictEqual(ui.espacementSecondesVersMs(-1), null);
  assert.strictEqual(ui.espacementSecondesVersMs(86401), null);
  assert.strictEqual(ui.espacementSecondesVersMs(NaN), null);
  assert.strictEqual(ui.espacementSecondesVersMs('10'), null); // pas de coercition silencieuse
});

test('espacement ms vers secondes', () => {
  assert.strictEqual(ui.espacementMsVersSecondes(0), 0);
  assert.strictEqual(ui.espacementMsVersSecondes(600000), 600);
  assert.strictEqual(ui.espacementMsVersSecondes(-1), 0);
  assert.strictEqual(ui.espacementMsVersSecondes(1.5), 0); // arrondi au-dessous
});

// --- datetime-local <-> ISO (heure locale, sans perte) ---

test('datetime-local vers ISO puis retour sans perte', () => {
  // 19/10/2026 14:30 heure locale -> ISO -> retour
  const iso = ui.datetimeLocalVersISO('2026-10-19T14:30');
  assert.ok(iso);
  assert.strictEqual(ui.isoVersDatetimeLocal(iso), '2026-10-19T14:30');
});

test('datetime-local : valeurs vides ou invalides rejetées', () => {
  assert.strictEqual(ui.datetimeLocalVersISO(''), null);
  assert.strictEqual(ui.datetimeLocalVersISO(null), null);
  assert.strictEqual(ui.datetimeLocalVersISO('2026-10-19'), null); // pas d'heure
  assert.strictEqual(ui.datetimeLocalVersISO('2026-13-01T10:00'), null); // mois invalide
  assert.ok(typeof ui.datetimeLocalVersISO('2026-10-19T14:30') === 'string'); // forme valide
});

test('isoVersDatetimeLocal : entrée invalide', () => {
  assert.strictEqual(ui.isoVersDatetimeLocal('pas-une-date'), null);
  assert.strictEqual(ui.isoVersDatetimeLocal(undefined), null);
});

// --- formVersTache : happy path ---

test('formVersTache : création complète', () => {
  const r = ui.formVersTache({
    id: null,
    nom: 'Rapport du matin',
    fournisseur: 'claude',
    comptesMode: 'liste',
    comptesProfils: ['alice', 'bob', 'alice'], // doublon éliminé ?
    repartitionMode: 'tous',
    espacementSecondes: '10',
    nouvelleSession: true,
    prompt: 'Fais le rapport',
    programmationType: 'periodique',
    programmationDepuis: '2026-10-20T08:00',
    programmationTous: '6',
    programmationUnite: 'heure',
    active: false
  });
  assert.ok(r.ok, JSON.stringify(r.erreurs));
  const t = r.tache;
  assert.strictEqual(t.nom, 'Rapport du matin');
  assert.strictEqual(t.fournisseur, 'claude');
  assert.deepStrictEqual(t.comptes, { mode: 'liste', profils: ['alice', 'bob'] });
  assert.deepStrictEqual(t.repartition, { mode: 'tous', espacementMs: 10000 });
  assert.strictEqual(t.nouvelleSession, true);
  assert.strictEqual(t.active, false);
  assert.strictEqual(t.programmation.type, 'periodique');
  assert.strictEqual(t.programmation.tous, 6);
  assert.strictEqual(t.programmation.unite, 'heure');
  assert.ok(t.programmation.depuis.endsWith('T08:00:00.000Z') || t.programmation.depuis);
});

test('formVersTache : programmation unique', () => {
  const r = ui.formVersTache({
    nom: 'Une fois',
    fournisseur: 'claude',
    comptesMode: 'tous',
    repartitionMode: 'rotation',
    nouvelleSession: false,
    prompt: 'p',
    programmationType: 'unique',
    programmationLe: '2026-10-21T09:15',
    active: true
  });
  assert.ok(r.ok, JSON.stringify(r.erreurs));
  assert.strictEqual(r.tache.programmation.type, 'unique');
  assert.strictEqual(r.tache.repartition.mode, 'rotation');
  assert.strictEqual(r.tache.nouvelleSession, false);
  assert.strictEqual(r.tache.active, true);
});

// --- formVersTache : erreurs de pré-validation ---

test('formVersTache : nom et prompt obligatoires', () => {
  const r = ui.formVersTache({ programmationType: 'unique', programmationLe: '2026-10-21T09:15' });
  assert.ok(!r.ok);
  assert.ok(r.erreurs.includes('nom'));
  assert.ok(r.erreurs.includes('prompt'));
});

test('formVersTache : liste sans profil, espacement invalide, date vide', () => {
  const r = ui.formVersTache({
    nom: 'x', prompt: 'p',
    comptesMode: 'liste', comptesProfils: [],
    repartitionMode: 'tous', espacementSecondes: 'abc',
    programmationType: 'unique', programmationLe: ''
  });
  assert.ok(!r.ok);
  assert.ok(r.erreurs.includes('comptes-vides'));
  assert.ok(r.erreurs.includes('espacement'));
  assert.ok(r.erreurs.includes('date-le'));
});

// --- Aller-retour complet tâche -> formulaire -> tâche (édition sans perte) ---

test('aller-retour tache -> form -> tache sans perte', () => {
  const tache = {
    id: 't1',
    nom: 'Veille',
    fournisseur: 'claude',
    comptes: { mode: 'liste', profils: ['alice', 'bob'] },
    repartition: { mode: 'tous', espacementMs: 900000 },
    nouvelleSession: false,
    prompt: 'Résume les actualités',
    programmation: { type: 'periodique', tous: 2, unite: 'jour', depuis: '2026-10-20T06:30:00.000Z' },
    active: true
  };
  const form = ui.tacheVersForm(tache);
  const r = ui.formVersTache(Object.assign({}, form, {
    comptesProfils: form.comptesProfils,
    espacementSecondes: form.espacementSecondes,
    programmationTous: form.programmationTous,
    programmationUnite: form.programmationUnite,
    programmationDepuis: form.programmationDepuis
  }));
  assert.ok(r.ok, JSON.stringify(r.erreurs));
  const t = r.tache;
  assert.strictEqual(t.nom, tache.nom);
  assert.deepStrictEqual(t.comptes, tache.comptes);
  assert.deepStrictEqual(t.repartition, tache.repartition);
  assert.strictEqual(t.nouvelleSession, false);
  assert.strictEqual(t.active, true);
  assert.strictEqual(t.programmation.tous, 2);
  assert.strictEqual(t.programmation.unite, 'jour');
  // La date fait l'aller-retour local sans décalage d'heure.
  assert.strictEqual(new Date(t.programmation.depuis).getTime(),
    new Date(tache.programmation.depuis).getTime());
});

test('aller-retour espacement : 900 secondes restent 900 secondes (pas d’arrondi au-dessus)', () => {
  // 90000 ms = 90 s : l’ancienne saisie en minutes arrondissait 90 s à 2 min ;
  // la saisie en secondes préserve exactement la valeur.
  assert.strictEqual(ui.espacementMsVersSecondes(ui.espacementSecondesVersMs(90)), 90);
});

test('édition sans perte : modifier seulement le nom ne touche ni l’espacement ni les dates', () => {
  const tache = {
    id: 't1', nom: 'Veille', fournisseur: 'claude',
    comptes: { mode: 'liste', profils: ['alice'] },
    repartition: { mode: 'tous', espacementMs: 90000 }, // 90 s, pas un multiple de minute
    nouvelleSession: false, prompt: 'p',
    programmation: { type: 'periodique', tous: 2, unite: 'jour', depuis: '2026-10-20T06:30:00.000Z' },
    active: true
  };
  const form = ui.tacheVersForm(tache);
  // L’utilisateur ne touche qu’au nom : le formulaire renvoie le reste tel quel.
  const r = ui.formVersTache(Object.assign({}, form, { nom: 'Veille renommée' }));
  assert.ok(r.ok, JSON.stringify(r.erreurs));
  assert.strictEqual(r.tache.repartition.espacementMs, 90000, 'l’espacement de 90 s doit être préservé');
  assert.strictEqual(new Date(r.tache.programmation.depuis).getTime(),
    new Date(tache.programmation.depuis).getTime(), 'la date « depuis » doit être préservée');
  assert.strictEqual(r.tache.programmation.tous, 2);
  assert.strictEqual(r.tache.programmation.unite, 'jour');
  // NB : derniereExecution et indexRotation ne passent PAS par le formulaire :
  // le service les préserve lui-même (scheduler/taches-service.js enregistrer).
});

// --- Descripteurs ---

test('decrireProgrammation', () => {
  assert.deepStrictEqual(ui.decrireProgrammation({ type: 'unique', le: '2026-10-21T09:15:00.000Z' }),
    { cle: 'unique', iso: '2026-10-21T09:15:00.000Z' });
  assert.deepStrictEqual(ui.decrireProgrammation({ type: 'periodique', tous: 6, unite: 'heure', depuis: 'x' }),
    { cle: 'periodique', tous: 6, unite: 'heure', iso: 'x' });
  assert.deepStrictEqual(ui.decrireProgrammation(null), { cle: 'inconnue' });
});

test('decrireComptes / decrireRepartition', () => {
  assert.deepStrictEqual(ui.decrireComptes({ mode: 'tous', profils: [] }), { cle: 'tous' });
  assert.deepStrictEqual(ui.decrireComptes({ mode: 'liste', profils: ['a', 'b'] }), { cle: 'liste', n: 2 });
  assert.deepStrictEqual(ui.decrireRepartition({ mode: 'rotation', espacementMs: 0 }), { cle: 'rotation' });
  assert.deepStrictEqual(ui.decrireRepartition({ mode: 'tous', espacementMs: 600000 }),
    { cle: 'tous', secondes: 600 });
});

// --- Résultats ---

test('cleResultat', () => {
  assert.strictEqual(ui.cleResultat('lancee'), 'lancee');
  assert.strictEqual(ui.cleResultat('lancee | envoye | 2026-10-19T08:00:00.000Z'), 'lancee');
  assert.strictEqual(ui.cleResultat('envoye | success'), 'envoye');
  assert.strictEqual(ui.cleResultat('quota | ...'), 'quota');
  assert.strictEqual(ui.cleResultat('heures-calmes'), 'heures-calmes');
  assert.strictEqual(ui.cleResultat('non-connecte | x'), 'non-connecte');
  assert.strictEqual(ui.cleResultat('aucun-compte'), 'aucun-compte');
  assert.strictEqual(ui.cleResultat('erreur | boom'), 'erreur');
  assert.strictEqual(ui.cleResultat('nimporte'), 'autre');
  assert.strictEqual(ui.cleResultat(null), 'autre');
});

test('datetime-local : secondes conservées à l’aller-retour', () => {
  const iso = ui.datetimeLocalVersISO('2026-10-19T14:30:25');
  assert.ok(iso);
  assert.strictEqual(ui.isoVersDatetimeLocal(iso), '2026-10-19T14:30:25');
});

// --- Préservation des valeurs non modifiables finement (édition) ---

test('édition : valeurs non rondes préservées quand les champs ne changent pas', () => {
  // Espacement 90050 ms (pas un multiple de 1000) et date avec millisecondes :
  // le formulaire ne peut pas les représérer exactement — une édition du seul
  // nom ne doit NI arrondir l'espacement NI tronquer la date.
  const originale = {
    id: 't1', nom: 'Veille', fournisseur: 'claude',
    comptes: { mode: 'liste', profils: ['alice'] },
    repartition: { mode: 'tous', espacementMs: 90050 },
    nouvelleSession: false, prompt: 'p',
    programmation: { type: 'periodique', tous: 2, unite: 'jour',
      depuis: '2026-10-20T06:30:00.500Z' },
    active: true
  };
  const form = ui.tacheVersForm(originale);
  // L'utilisateur ne change QUE le nom.
  const r = ui.formVersTache(Object.assign({}, form, { nom: 'Renommée' }));
  assert.ok(r.ok, JSON.stringify(r.erreurs));
  const preservée = ui.preserverValeursNonModifiees(r.tache, originale, form);
  assert.strictEqual(preservée.repartition.espacementMs, 90050,
    'l’espacement de 90050 ms doit rester exact');
  assert.strictEqual(preservée.programmation.depuis, '2026-10-20T06:30:00.500Z',
    'la date avec millisecondes doit rester exacte');
  assert.strictEqual(preservée.nom, 'Renommée');
});

test('édition : champ réellement modifié -> conversion appliquée', () => {
  const originale = {
    id: 't1', nom: 'Veille', fournisseur: 'claude',
    comptes: { mode: 'liste', profils: ['alice'] },
    repartition: { mode: 'tous', espacementMs: 90050 },
    nouvelleSession: false, prompt: 'p',
    programmation: { type: 'periodique', tous: 2, unite: 'jour',
      depuis: '2026-10-20T06:30:00.500Z' },
    active: true
  };
  const form = ui.tacheVersForm(originale);
  // L'utilisateur change l'espacement affiché (90 -> 120 s) et la date.
  const modifie = Object.assign({}, form, { espacementSecondes: 120 });
  const r = ui.formVersTache(modifie);
  assert.ok(r.ok);
  const preservée = ui.preserverValeursNonModifiees(r.tache, originale, modifie);
  assert.strictEqual(preservée.repartition.espacementMs, 120000, 'nouvel espacement converti');
  // La date, elle, n'a pas changé -> ISO d'origine conservé.
  assert.strictEqual(preservée.programmation.depuis, '2026-10-20T06:30:00.500Z');
});

test('préservation : création (pas d’originale) -> conversion inchangée', () => {
  const r = ui.formVersTache({
    nom: 'N', prompt: 'p', comptesMode: 'tous', repartitionMode: 'tous',
    espacementSecondes: 10, programmationType: 'unique',
    programmationLe: '2026-10-21T09:15', active: true
  });
  assert.ok(r.ok);
  const preservée = ui.preserverValeursNonModifiees(r.tache, null, {});
  assert.strictEqual(preservée.repartition.espacementMs, 10000);
});

// --- Couverture des branches défensives (seuil 100 % de la CI) ---

test('préservation : date unique inchangée -> ISO d’origine conservé, modifiée -> conversion', () => {
  const originale = {
    id: 't2', nom: 'Une fois', fournisseur: 'claude',
    comptes: { mode: 'tous', profils: [] },
    repartition: { mode: 'tous' }, // espacementMs absent -> 0
    nouvelleSession: true, prompt: 'p',
    programmation: { type: 'unique', le: '2026-10-21T09:15:00.250Z' },
    active: false
  };
  const form = ui.tacheVersForm(originale);
  assert.strictEqual(form.espacementSecondes, 0);
  const r = ui.formVersTache(form);
  assert.ok(r.ok, JSON.stringify(r.erreurs));
  const garde = ui.preserverValeursNonModifiees(r.tache, originale, form);
  assert.strictEqual(garde.programmation.le, '2026-10-21T09:15:00.250Z');
  assert.strictEqual(garde.repartition.espacementMs, 0);

  const modifie = Object.assign({}, form, { programmationLe: '2026-10-22T10:00' });
  const r2 = ui.formVersTache(modifie);
  const conv = ui.preserverValeursNonModifiees(r2.tache, originale, modifie);
  assert.strictEqual(conv.programmation.le, ui.datetimeLocalVersISO('2026-10-22T10:00'));

  // Champ absent (non chaîne) : aucune préservation tentée.
  const sansChamp = ui.preserverValeursNonModifiees(r.tache, originale, { espacementSecondes: 0 });
  assert.strictEqual(sansChamp.programmation.le, r.tache.programmation.le);
  // Types différents (unique -> périodique) : rien à préserver.
  const perio = Object.assign({}, r.tache, { programmation: { type: 'periodique', tous: 1, unite: 'heure', depuis: 'x' } });
  assert.strictEqual(ui.preserverValeursNonModifiees(perio, originale, form).programmation.depuis, 'x');
  // Répartition rotation : l’espacement n’est pas touché ; programmation absente tolérée.
  const rot = Object.assign({}, r.tache, { repartition: { mode: 'rotation', espacementMs: 0 }, programmation: null });
  const res = ui.preserverValeursNonModifiees(rot, originale, form);
  assert.deepEqual(res.repartition, { mode: 'rotation', espacementMs: 0 });
  assert.strictEqual(res.programmation, null);
});

test('formVersTache : entrée absente ou incomplète -> tous les codes d’erreur', () => {
  const r = ui.formVersTache(undefined);
  assert.equal(r.ok, false);
  assert.deepEqual(r.erreurs, ['nom', 'prompt', 'comptes-mode', 'repartition-mode', 'programmation-type']);
  assert.strictEqual(r.tache, null);

  const p = ui.formVersTache({
    nom: 'N', prompt: 'p', comptesMode: 'liste', comptesProfils: 'pas-un-tableau',
    repartitionMode: 'rotation', programmationType: 'periodique',
    programmationDepuis: '', programmationTous: '0', programmationUnite: 'siecle'
  });
  assert.deepEqual(p.erreurs, ['comptes-vides', 'date-depuis', 'tous', 'unite']);
});

test('formVersTache : périodique valide, profils dédoublonnés, id et fournisseur', () => {
  const r = ui.formVersTache({
    id: 'abc', fournisseur: 'claude', nom: ' N ', prompt: ' p ',
    comptesMode: 'liste', comptesProfils: [' a ', 'a', '', 3, 'b'],
    repartitionMode: 'rotation', nouvelleSession: false,
    programmationType: 'periodique', programmationDepuis: '2026-10-20T08:00',
    programmationTous: '3', programmationUnite: 'semaine', active: true
  });
  assert.ok(r.ok, JSON.stringify(r.erreurs));
  assert.deepEqual(r.tache.comptes, { mode: 'liste', profils: ['a', 'b'] });
  assert.equal(r.tache.id, 'abc');
  assert.equal(r.tache.nouvelleSession, false);
  assert.deepEqual(r.tache.programmation, {
    type: 'periodique', tous: 3, unite: 'semaine', depuis: ui.datetimeLocalVersISO('2026-10-20T08:00')
  });
  const sansId = ui.formVersTache(Object.assign({}, r.tache, {
    id: '', fournisseur: '', comptesMode: 'tous', repartitionMode: 'rotation',
    programmationType: 'periodique', programmationDepuis: '2026-10-20T08:00',
    programmationTous: 1, programmationUnite: 'heure'
  }));
  assert.strictEqual(sansId.tache.id, null);
  assert.equal(sansId.tache.fournisseur, 'claude');
});

test('tacheVersForm : tâche absente ou partielle -> valeurs par défaut', () => {
  assert.deepEqual(ui.tacheVersForm(undefined), {
    id: null, nom: '', fournisseur: 'claude', comptesMode: 'tous', comptesProfils: [],
    repartitionMode: 'tous', espacementSecondes: 0, nouvelleSession: true, prompt: '',
    programmationType: 'periodique', programmationLe: '', programmationDepuis: '',
    programmationTous: '1', programmationUnite: 'heure', active: false
  });
  const f = ui.tacheVersForm({ comptes: { profils: 'x' }, repartition: {} });
  assert.equal(f.comptesMode, 'tous');
  assert.deepEqual(f.comptesProfils, []);
  assert.equal(f.repartitionMode, 'tous');
});

test('descripteurs : entrées absentes ou partielles', () => {
  assert.deepEqual(ui.decrireProgrammation(undefined), { cle: 'inconnue' });
  assert.deepEqual(ui.decrireProgrammation({ type: 'unique' }), { cle: 'unique', iso: null });
  assert.deepEqual(ui.decrireProgrammation({ type: 'periodique', tous: 2, unite: 'jour' }),
    { cle: 'periodique', tous: 2, unite: 'jour', iso: null });
  assert.deepEqual(ui.decrireComptes(undefined), { cle: 'tous' });
  assert.deepEqual(ui.decrireComptes({ mode: 'liste' }), { cle: 'liste', n: 0 });
  assert.deepEqual(ui.decrireRepartition(undefined), { cle: 'tous', secondes: 0 });
  assert.deepEqual(ui.decrireRepartition({ mode: 'tous', espacementMs: 5000 }), { cle: 'tous', secondes: 5 });
});

test('taches-ui s’attache à window dans le renderer', () => {
  const chemin = require.resolve('../lib/taches-ui.js');
  const avant = global.window;
  global.window = {};
  try {
    delete require.cache[chemin];
    require(chemin);
    assert.equal(typeof global.window.iaoTachesUi.formVersTache, 'function');
  } finally {
    if (avant === undefined) delete global.window; else global.window = avant;
    delete require.cache[chemin];
  }
});
