'use strict';

// lib/taches-ui.js — helpers purs de l'interface des tâches programmables
// (issue #199, lot 4). Aucune dépendance au DOM ni à l'IPC : les conversions
// et les descriptions sont testées par node --test (test/taches-ui.test.js).
//
// Conventions (issues #199, CLAUDE.md) :
//   - les dates du modèle sont des chaînes ISO (scheduler/taches.js) ;
//   - l'interface saisit une heure LOCALE via <input type="datetime-local"> :
//     les allers-retours doivent être sans perte (pas de toISOString().slice,
//     qui décalerait l'heure) ;
//   - l'espacement se saisit en minutes (0..1440), stocké en ms côté modèle ;
//   - la validation reste la responsabilité du service (taches:save) : ces
//     helpers se contentent de convertir et de pré-rejeter les valeurs vides.

// Unités de programmation périodique, telles que définies par le modèle
// (scheduler/taches.js : UNITES).
const PROGRAMMATION_UNITES = Object.freeze(['minute', 'heure', 'jour', 'semaine', 'mois']);

// Espacement : saisie en SECONDES (granularité du formulaire, max 24 h),
// modèle en millisecondes. L'aller-retour est exact pour tout multiple de
// 1000 ms ; une valeur à la milliseconde près (JSON édité à la main) est
// arrondie à la seconde la plus proche — c'est la granularité du formulaire.
function espacementSecondesVersMs(secondes) {
  if (!Number.isFinite(secondes) || secondes < 0 || secondes > 86400) return null;
  return Math.round(secondes * 1000);
}

function espacementMsVersSecondes(ms) {
  if (!Number.isInteger(ms) || ms < 0) return 0;
  return Math.round(ms / 1000);
}

// datetime-local (yyyy-mm-ddThh:mm[:ss], heure locale) -> chaîne ISO.
// Renvoie null si vide ou invalide (pas de conversion silencieuse). Les
// secondes sont conservées (l'attribut step=1 du champ les permet) ; les
// millisecondes ne sont pas représentables dans le champ.
function datetimeLocalVersISO(valeur) {
  if (typeof valeur !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(valeur)) return null;
  const d = new Date(valeur);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

// Chaîne ISO -> datetime-local (heure locale). Les secondes sont conservées
// quand elles ne sont pas nulles, pour un aller-retour à la seconde près.
function isoVersDatetimeLocal(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  const p = n => String(n).padStart(2, '0');
  const base = d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
    + 'T' + p(d.getHours()) + ':' + p(d.getMinutes());
  return d.getSeconds() > 0 ? base + ':' + p(d.getSeconds()) : base;
}

// Préserve les valeurs EXACTES du modèle quand le champ correspondant n'a
// pas été modifié dans le formulaire. La granularité des champs (seconde,
// minute) est plus grossière que celle du modèle (ms) : une valeur non ronde
// (espacementMs 90050, date en .500Z) ne peut pas y être représentée. Si la
// valeur saisie est IDENTIQUE à celle affichée depuis l'original (l'utilisateur
// n'a rien changé, ou a retapé la même valeur), on renvoie la valeur d'origine
// au lieu de la conversion arrondie. Un champ réellement modifié garde sa
// conversion.
function preserverValeursNonModifiees(convertie, originale, champs) {
  if (!originale) return convertie; // création : rien à préserver
  const r = Object.assign({}, convertie);
  // Espacement (ms exacts) — uniquement en mode « tous » des deux côtés, et
  // seulement si l'original porte un entier (sinon la conversion, toujours un
  // entier, est gardée : jamais d'espacementMs undefined).
  if (r.repartition && r.repartition.mode === 'tous' &&
      originale.repartition && originale.repartition.mode === 'tous' &&
      Number.isInteger(originale.repartition.espacementMs)) {
    const affiche = espacementMsVersSecondes(originale.repartition.espacementMs);
    if (Number(champs && champs.espacementSecondes) === affiche) {
      r.repartition = Object.assign({}, r.repartition,
        { espacementMs: originale.repartition.espacementMs });
    }
  }
  // Dates (ISO exacts, avec secondes et millisecondes) — le champ affiche
  // la valeur arrondie à la seconde ; si elle n'a pas bougé, on garde l'ISO
  // d'origine (qui peut porter des ms).
  if (r.programmation && originale.programmation) {
    if (r.programmation.type === 'unique' && originale.programmation.type === 'unique' &&
        typeof champs.programmationLe === 'string' &&
        isoVersDatetimeLocal(originale.programmation.le) === champs.programmationLe) {
      r.programmation = Object.assign({}, r.programmation, { le: originale.programmation.le });
    }
    if (r.programmation.type === 'periodique' && originale.programmation.type === 'periodique' &&
        typeof champs.programmationDepuis === 'string' &&
        isoVersDatetimeLocal(originale.programmation.depuis) === champs.programmationDepuis) {
      r.programmation = Object.assign({}, r.programmation, { depuis: originale.programmation.depuis });
    }
  }
  return r;
}

// Champs du formulaire -> entrée pour normaliserTache (taches:save).
// Renvoie { ok: true, tache } ou { ok: false, erreurs } SANS appeler le
// service : ces erreurs-là (format de date, espacement) sont corrigeables
// avant l'appel IPC ; le service reste l'autorité finale. Les erreurs sont
// des CODES (pas du français) : l'app.js les traduit par des appels _()
// littéraux pour qu'xgettext les extraie.
function formVersTache(champs) {
  const c = champs || {};
  const erreurs = [];
  const nom = typeof c.nom === 'string' ? c.nom.trim() : '';
  if (!nom) erreurs.push('nom');
  const prompt = typeof c.prompt === 'string' ? c.prompt.trim() : '';
  if (!prompt) erreurs.push('prompt');

  let comptes;
  if (c.comptesMode === 'tous') {
    comptes = { mode: 'tous', profils: [] };
  } else if (c.comptesMode === 'liste') {
    const profils = [...new Set((Array.isArray(c.comptesProfils) ? c.comptesProfils : [])
      .filter(p => typeof p === 'string' && p.trim()).map(p => p.trim()))];
    if (!profils.length) erreurs.push('comptes-vides');
    comptes = { mode: 'liste', profils };
  } else {
    erreurs.push('comptes-mode');
  }

  let repartition;
  if (c.repartitionMode === 'rotation') {
    repartition = { mode: 'rotation', espacementMs: 0 };
  } else if (c.repartitionMode === 'tous') {
    const ms = espacementSecondesVersMs(Number(c.espacementSecondes));
    if (ms === null) erreurs.push('espacement');
    repartition = { mode: 'tous', espacementMs: ms === null ? 0 : ms };
  } else {
    erreurs.push('repartition-mode');
  }

  let programmation;
  if (c.programmationType === 'unique') {
    const le = datetimeLocalVersISO(c.programmationLe);
    if (!le) erreurs.push('date-le');
    programmation = { type: 'unique', le: le || null };
  } else if (c.programmationType === 'periodique') {
    const depuis = datetimeLocalVersISO(c.programmationDepuis);
    if (!depuis) erreurs.push('date-depuis');
    const tous = Number(c.programmationTous);
    if (!Number.isInteger(tous) || tous < 1) erreurs.push('tous');
    if (!PROGRAMMATION_UNITES.includes(c.programmationUnite)) erreurs.push('unite');
    programmation = {
      type: 'periodique',
      tous: Number.isInteger(tous) && tous >= 1 ? tous : 1,
      unite: PROGRAMMATION_UNITES.includes(c.programmationUnite) ? c.programmationUnite : 'heure',
      depuis: depuis || null
    };
  } else {
    erreurs.push('programmation-type');
    programmation = null;
  }

  if (erreurs.length) return { ok: false, erreurs, tache: null };
  return {
    ok: true,
    erreurs: [],
    tache: {
      id: typeof c.id === 'string' && c.id ? c.id : null,
      nom,
      fournisseur: c.fournisseur || 'claude',
      comptes,
      repartition,
      nouvelleSession: c.nouvelleSession !== false,
      prompt,
      programmation,
      active: c.active === true
    }
  };
}

// Tâche normalisée -> champs du formulaire (édition sans perte : les dates
// font l'aller-retour ISO -> datetime-local -> ISO).
function tacheVersForm(tache) {
  const t = tache || {};
  const prog = t.programmation || {};
  const rep = t.repartition || { mode: 'tous', espacementMs: 0 };
  return {
    id: t.id || null,
    nom: t.nom || '',
    fournisseur: t.fournisseur || 'claude',
    comptesMode: t.comptes && t.comptes.mode ? t.comptes.mode : 'tous',
    comptesProfils: t.comptes && Array.isArray(t.comptes.profils) ? t.comptes.profils.slice() : [],
    repartitionMode: rep.mode || 'tous',
    espacementSecondes: espacementMsVersSecondes(rep.espacementMs || 0),
    nouvelleSession: t.nouvelleSession !== false,
    prompt: t.prompt || '',
    programmationType: prog.type === 'unique' ? 'unique' : 'periodique',
    programmationLe: prog.type === 'unique' ? isoVersDatetimeLocal(prog.le) : '',
    programmationDepuis: prog.type === 'periodique' ? isoVersDatetimeLocal(prog.depuis) : '',
    programmationTous: prog.type === 'periodique' ? String(prog.tous) : '1',
    programmationUnite: prog.type === 'periodique' ? prog.unite : 'heure',
    active: t.active === true
  };
}

// Descripteurs (clé + paramètres) : l'app.js les traduit par des appels _()
// littéraux, pour que xgettext extrait chaque message complet.
function decrireProgrammation(prog) {
  const p = prog || {};
  if (p.type === 'unique') return { cle: 'unique', iso: p.le || null };
  if (p.type === 'periodique') {
    return { cle: 'periodique', tous: p.tous, unite: p.unite, iso: p.depuis || null };
  }
  return { cle: 'inconnue' };
}

function decrireComptes(comptes) {
  const c = comptes || {};
  if (c.mode === 'liste') return { cle: 'liste', n: (c.profils || []).length };
  return { cle: 'tous' };
}

function decrireRepartition(repartition) {
  const r = repartition || {};
  if (r.mode === 'rotation') return { cle: 'rotation' };
  return { cle: 'tous', secondes: espacementMsVersSecondes(r.espacementMs || 0) };
}

// Résultats d'exécution (RESULTATS du service) -> clé de libellé.
function cleResultat(resultat) {
  const r = String(resultat || '').trim();
  if (r.startsWith('lancee')) return 'lancee';
  if (r.startsWith('envoye')) return 'envoye';
  if (r.startsWith('quota')) return 'quota';
  if (r.startsWith('heures-calmes')) return 'heures-calmes';
  if (r.startsWith('non-connecte')) return 'non-connecte';
  if (r.startsWith('aucun-compte')) return 'aucun-compte';
  if (r.startsWith('erreur')) return 'erreur';
  return 'autre';
}

const iaoTachesUi = {
  PROGRAMMATION_UNITES,
  espacementSecondesVersMs,
  espacementMsVersSecondes,
  datetimeLocalVersISO,
  isoVersDatetimeLocal,
  formVersTache,
  tacheVersForm,
  preserverValeursNonModifiees,
  decrireProgrammation,
  decrireComptes,
  decrireRepartition,
  cleResultat
};
if (typeof window !== 'undefined') window.iaoTachesUi = iaoTachesUi;
else module.exports = iaoTachesUi;
