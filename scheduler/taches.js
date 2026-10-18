'use strict';

// scheduler/taches.js — tâches programmables (issue #199), fonctions PURES.
//
// Remplace, dans le menu « Ordonnanceur », l'ancien flux (détection des ZIP,
// registre de jobs, projets) par des tâches programmables :
//
//   fournisseur (IA)  : registre modulaire, Claude seulement pour commencer ;
//   comptes           : un, plusieurs ou tous les comptes ayant ce service ;
//   répartition       : « tous » (chaque compte, espacés de N ms) ou
//                       « rotation » (un seul compte par exécution, à tour de rôle) ;
//   nouvelle session  : ouvre l'URL « nouvelle conversation » du fournisseur ;
//   prompt            : texte envoyé ;
//   programmation     : « unique » (date/heure) ou « periodique »
//                       (toutes les N minutes/heures/jours/semaines/mois) ;
//   active            : false à la création — rien ne part tout seul.
//
// Aucune dépendance Electron/DOM/fs : testé par `node --test`
// (test/scheduler-taches.test.js). L'exécution (minuterie, onglets, envoi du
// prompt via l'automatisation Claude existante) vit hors de ce module.

// ---------------------------------------------------------------------------
// Fournisseurs (modulaire : un fournisseur = une entrée du registre)
// ---------------------------------------------------------------------------

const FOURNISSEURS_PAR_DEFAUT = Object.freeze({
  claude: Object.freeze({
    id: 'claude',
    nom: 'Claude',
    urlNouvelleSession: 'https://claude.ai/new',
    // Nom de l'automatisation qui envoie le prompt (scheduler/index.js).
    automatisation: 'claude'
  })
});

// Ajoute un fournisseur à un registre (copie, le registre d'origine est intact).
function enregistrerFournisseur(registre, def) {
  if (!def || typeof def.id !== 'string' || !/^[a-z][a-z0-9_-]*$/.test(def.id)) {
    throw new Error('fournisseur invalide : id attendu');
  }
  if (typeof def.urlNouvelleSession !== 'string' || !def.urlNouvelleSession.startsWith('https://')) {
    throw new Error('fournisseur invalide : urlNouvelleSession https attendue');
  }
  const copie = Object.assign({}, registre);
  copie[def.id] = Object.freeze(Object.assign({ nom: def.id, automatisation: def.id }, def));
  return Object.freeze(copie);
}

// ---------------------------------------------------------------------------
// Programmation
// ---------------------------------------------------------------------------

const UNITES = Object.freeze(['minute', 'heure', 'jour', 'semaine', 'mois']);
const MS_PAR_UNITE = Object.freeze({
  minute: 60 * 1000,
  heure: 60 * 60 * 1000,
  jour: 24 * 60 * 60 * 1000,
  semaine: 7 * 24 * 60 * 60 * 1000
});
// Garde-fou : pas plus d'une exécution toutes les 5 minutes par tâche.
const INTERVALLE_MIN_MS = 5 * 60 * 1000;
const ESPACEMENT_MAX_MS = 24 * 60 * 60 * 1000;
const PROMPT_MAX = 20000;
const NOM_MAX = 120;

function _date(valeur) {
  const d = valeur instanceof Date ? new Date(valeur.getTime()) : new Date(valeur);
  return Number.isNaN(d.getTime()) ? null : d;
}

// Ajoute n mois, en restant sur le dernier jour si le mois est plus court
// (31 janvier + 1 mois -> 28/29 février).
function ajouterMois(date, n) {
  const d = new Date(date.getTime());
  const jour = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + n);
  const dernier = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(jour, dernier));
  return d;
}

// k-ième occurrence (k >= 0) d'une programmation périodique.
function occurrence(prog, k) {
  const depuis = _date(prog.depuis);
  if (prog.unite === 'mois') return ajouterMois(depuis, k * prog.tous);
  return new Date(depuis.getTime() + k * prog.tous * MS_PAR_UNITE[prog.unite]);
}

// Prochaine échéance d'une tâche, ou null (désactivée, unique déjà exécutée).
// Une échéance manquée (application fermée) donne UNE exécution de
// rattrapage, jamais une rafale : on cherche la première occurrence
// postérieure à la dernière exécution.
function prochaineEcheance(tache) {
  if (!tache || !tache.active) return null;
  const prog = tache.programmation;
  const derniere = tache.derniereExecution ? _date(tache.derniereExecution) : null;
  if (prog.type === 'unique') {
    return derniere ? null : _date(prog.le);
  }
  const depuis = _date(prog.depuis);
  if (!derniere || derniere < depuis) return depuis;
  // Estimation directe de k, puis ajustement (mois de longueur variable).
  const pas = prog.unite === 'mois' ? 28 * MS_PAR_UNITE.jour : MS_PAR_UNITE[prog.unite];
  let k = Math.max(0, Math.floor((derniere - depuis) / (prog.tous * pas)) - 1);
  while (occurrence(prog, k) <= derniere) k++;
  return occurrence(prog, k);
}

// Tâches dont l'échéance est atteinte à `maintenant`.
function tachesDues(taches, maintenant) {
  const t = _date(maintenant);
  return (taches || []).filter(tache => {
    const e = prochaineEcheance(tache);
    return e !== null && e <= t;
  });
}

// ---------------------------------------------------------------------------
// Validation / normalisation
// ---------------------------------------------------------------------------

function _entierPositif(v) {
  return Number.isInteger(v) && v > 0;
}

function _programmation(p, erreurs) {
  if (!p || (p.type !== 'unique' && p.type !== 'periodique')) {
    erreurs.push('programmation : type « unique » ou « periodique » attendu');
    return null;
  }
  if (p.type === 'unique') {
    const le = _date(p.le);
    if (!le) { erreurs.push('programmation : date « le » invalide'); return null; }
    return { type: 'unique', le: le.toISOString() };
  }
  const depuis = _date(p.depuis);
  if (!depuis) erreurs.push('programmation : date « depuis » invalide');
  if (!UNITES.includes(p.unite)) erreurs.push('programmation : unité inconnue');
  if (!_entierPositif(p.tous)) erreurs.push('programmation : « tous » doit être un entier > 0');
  else if (p.unite in MS_PAR_UNITE && p.tous * MS_PAR_UNITE[p.unite] < INTERVALLE_MIN_MS) {
    erreurs.push('programmation : intervalle minimal 5 minutes');
  }
  if (erreurs.length) return null;
  return { type: 'periodique', tous: p.tous, unite: p.unite, depuis: depuis.toISOString() };
}

// Normalise une tâche saisie ; renvoie { ok, tache, erreurs }.
// `fournisseurs` : registre (FOURNISSEURS_PAR_DEFAUT par défaut).
function normaliserTache(entree, fournisseurs) {
  const registre = fournisseurs || FOURNISSEURS_PAR_DEFAUT;
  const e = entree || {};
  const erreurs = [];
  const nom = typeof e.nom === 'string' ? e.nom.trim() : '';
  if (!nom) erreurs.push('nom obligatoire');
  else if (nom.length > NOM_MAX) erreurs.push('nom trop long (' + NOM_MAX + ' caractères max)');
  if (!Object.prototype.hasOwnProperty.call(registre, e.fournisseur)) {
    erreurs.push('fournisseur inconnu');
  }
  const prompt = typeof e.prompt === 'string' ? e.prompt.trim() : '';
  if (!prompt) erreurs.push('prompt obligatoire');
  else if (prompt.length > PROMPT_MAX) erreurs.push('prompt trop long (' + PROMPT_MAX + ' caractères max)');

  const c = e.comptes || {};
  let comptes = null;
  if (c.mode === 'tous') comptes = { mode: 'tous', profils: [] };
  else if (c.mode === 'liste') {
    const profils = Array.isArray(c.profils)
      ? [...new Set(c.profils.filter(p => typeof p === 'string' && p.trim()).map(p => p.trim()))]
      : [];
    if (!profils.length) erreurs.push('comptes : au moins un profil');
    comptes = { mode: 'liste', profils };
  } else erreurs.push('comptes : mode « tous » ou « liste » attendu');

  const r = e.repartition || { mode: 'tous', espacementMs: 0 };
  const espacementMs = r.espacementMs === undefined ? 0 : r.espacementMs;
  if (r.mode !== 'tous' && r.mode !== 'rotation') erreurs.push('répartition : mode « tous » ou « rotation » attendu');
  if (!Number.isInteger(espacementMs) || espacementMs < 0 || espacementMs > ESPACEMENT_MAX_MS) {
    erreurs.push('répartition : espacement entre 0 et 24 h');
  }

  const programmation = _programmation(e.programmation, erreurs);
  if (erreurs.length) return { ok: false, tache: null, erreurs };
  return {
    ok: true,
    erreurs: [],
    tache: {
      id: typeof e.id === 'string' && e.id ? e.id : null,
      nom,
      fournisseur: e.fournisseur,
      comptes,
      repartition: { mode: r.mode, espacementMs },
      nouvelleSession: e.nouvelleSession !== false,
      prompt,
      programmation,
      active: e.active === true,
      derniereExecution: _date(e.derniereExecution) ? _date(e.derniereExecution).toISOString() : null,
      indexRotation: Number.isInteger(e.indexRotation) && e.indexRotation >= 0 ? e.indexRotation : 0
    }
  };
}

// Identifiant suivant : « tache-N », N = max existant + 1.
function idSuivant(taches) {
  let max = 0;
  for (const t of taches || []) {
    const m = /^tache-(\d+)$/.exec(t && t.id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return 'tache-' + (max + 1);
}

// ---------------------------------------------------------------------------
// Comptes et plan d'exécution
// ---------------------------------------------------------------------------

// Comptes de la tâche qui ont le service du fournisseur.
// Renvoie { eligibles: [profil], exclus: [{ profil, raison }] } ;
// raison : 'service-absent' | 'introuvable'. La validité de la session
// (connecté, quota) se vérifie à l'exécution, dans l'onglet.
function comptesEligibles(tache, comptes) {
  const liste = Array.isArray(comptes) ? comptes : [];
  const parProfil = new Map(liste.map(a => [a.profile, a]));
  const voulus = tache.comptes.mode === 'tous' ? liste.map(a => a.profile) : tache.comptes.profils;
  const eligibles = [];
  const exclus = [];
  for (const profil of voulus) {
    const compte = parProfil.get(profil);
    if (!compte) exclus.push({ profil, raison: 'introuvable' });
    else if (!Array.isArray(compte.services) || !compte.services.includes(tache.fournisseur)) {
      exclus.push({ profil, raison: 'service-absent' });
    } else eligibles.push(profil);
  }
  return { eligibles, exclus };
}

// Plan d'une exécution : [{ profil, delaiMs }] et index de rotation suivant.
//   tous     : chaque compte éligible, le i-ème après i × espacement ;
//   rotation : un seul compte, eligibles[indexRotation mod n].
function planExecution(tache, eligibles) {
  const n = eligibles.length;
  if (!n) return { etapes: [], indexRotation: tache.indexRotation };
  if (tache.repartition.mode === 'rotation') {
    const i = tache.indexRotation % n;
    return { etapes: [{ profil: eligibles[i], delaiMs: 0 }], indexRotation: (i + 1) % n };
  }
  return {
    etapes: eligibles.map((profil, i) => ({ profil, delaiMs: i * tache.repartition.espacementMs })),
    indexRotation: tache.indexRotation
  };
}

module.exports = {
  FOURNISSEURS_PAR_DEFAUT, enregistrerFournisseur,
  UNITES, INTERVALLE_MIN_MS, ESPACEMENT_MAX_MS, PROMPT_MAX, NOM_MAX,
  ajouterMois, prochaineEcheance, tachesDues,
  normaliserTache, idSuivant, comptesEligibles, planExecution
};
