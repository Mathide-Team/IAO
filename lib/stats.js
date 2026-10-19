'use strict';

// lib/stats.js — statistiques d'utilisation (issue #206, lot 1).
//
// Tout reste LOCAL : aucune télémétrie, aucun appel réseau. Ce module est
// PUR (horloge et système de fichiers injectés) : testé par node --test
// (test/stats.test.js), utilisé côté renderer (suivi des onglets) ET côté
// process principal (persistance, registerStatsIPC).
//
// Mesures du lot 1 :
//   - durée de session par (compte, service) : ouverture -> fermeture de
//     l'onglet ;
//   - temps actif : temps où l'onglet est au premier plan ET la fenêtre IAO
//     a le focus (la durée d'ouverture seule surestime l'usage).
//
// Enregistrement d'une session (une ligne JSON de <userData>/stats/sessions.jsonl) :
//   { id, profil, service, debut, fin, actifMs }   (dates en ms epoch)
//
// Robustesse à la fermeture d'IAO : le renderer n'a que `invoke` (pas de
// sendSync), une écriture au déchargement n'est donc pas garantie. Le
// renderer synchronise régulièrement (stats:sync) l'instantané des sessions
// EN COURS, écrit dans <userData>/stats/en-cours.json ; au démarrage suivant,
// ces sessions interrompues sont versées dans l'historique (dédoublonnées
// par id). Perte maximale : l'intervalle de synchronisation.

const CONSERVATION_JOURS = 90;
// Plafond d'événements gardés par type (temps de réponse, quotas) : au-delà
// d'un événement par minute pendant 90 jours, les plus anciens sont jetés —
// les agrégats restent représentatifs sans faire grossir le fichier.
const MAX_EVENEMENTS = 130000;
const JOUR_MS = 24 * 60 * 60 * 1000;
const SYNC_INTERVALLE_MS = 60 * 1000;
const PERIODES = Object.freeze(['jour', 'semaine', 'mois', 'tout']);

// --- Validation d'un enregistrement ---------------------------------------

const ID_RE = /^[\w.:-]{1,80}$/;
// Le profil est un texte libre saisi par l'utilisateur (espaces, accents) :
// seuls les caractères de contrôle sont refusés ; l'affichage passe par
// escapeHtml() (invariant 1).
const PROFIL_RE = /^[^\u0000-\u001f\u007f]{1,200}$/;
const SERVICE_RE = /^[a-z0-9_-]{1,40}$/;

function normaliserSession(s) {
  if (!s || typeof s !== 'object') return null;
  const { id, profil, service, debut, fin } = s;
  if (typeof id !== 'string' || !ID_RE.test(id)) return null;
  if (typeof profil !== 'string' || !PROFIL_RE.test(profil)) return null;
  if (typeof service !== 'string' || !SERVICE_RE.test(service)) return null;
  if (!Number.isFinite(debut) || !Number.isFinite(fin) || debut <= 0 || fin < debut) return null;
  const duree = fin - debut;
  let actifMs = Number.isFinite(s.actifMs) ? Math.round(s.actifMs) : 0;
  if (actifMs < 0) actifMs = 0;
  if (actifMs > duree) actifMs = duree; // jamais plus actif que présent
  return { id, profil, service, debut: Math.round(debut), fin: Math.round(fin), actifMs };
}

// --- JSONL ------------------------------------------------------------------

// Lignes invalides (fichier tronqué par un arrêt brutal, édition à la main)
// ignorées une à une : une seule ligne abîmée ne fait pas perdre l'historique.
// `normaliser` : validator par type d'enregistrement (sessions par défaut).
function parserJsonl(texte, normaliser) {
  const valider = normaliser || normaliserSession;
  const valides = [];
  for (const ligne of String(texte || '').split('\n')) {
    if (!ligne.trim()) continue;
    let brut;
    try { brut = JSON.parse(ligne); } catch (_) { continue; }
    const s = valider(brut);
    if (s) valides.push(s);
  }
  return valides;
}

function versJsonl(sessions) {
  return sessions.map(s => JSON.stringify(s) + '\n').join('');
}

// Conservation : sessions terminées depuis moins de `jours` jours.
function purger(sessions, maintenant, jours, champ) {
  const cle = champ || 'fin';
  const limite = maintenant - (jours === undefined ? CONSERVATION_JOURS : jours) * JOUR_MS;
  return sessions.filter(s => s[cle] >= limite);
}

// --- Suivi côté renderer ----------------------------------------------------

// Suivi des onglets ouverts. `maintenant` injecté (Date.now en vrai).
// Un seul onglet peut être actif ; le temps actif ne court que si la
// fenêtre a le focus.
function creerSuivi(options) {
  const o = options || {};
  const maintenant = o.maintenant || Date.now;
  const ouvertes = new Map(); // cle -> { id, profil, service, debut, actifMs }
  let active = null;
  let focus = o.focus !== false;
  let depuis = null; // début du segment actif en cours (ms) ou null
  let seq = 0;

  function cloturerSegment(t) {
    if (depuis === null) return;
    const s = ouvertes.get(active);
    if (s) s.actifMs += Math.max(0, t - depuis);
    depuis = null;
  }
  function ouvrirSegment(t) {
    depuis = focus && active !== null && ouvertes.has(active) ? t : null;
  }
  function changer(fn) {
    const t = maintenant();
    cloturerSegment(t);
    fn(t);
    ouvrirSegment(t);
  }
  function figer(cle, s, t) {
    const actif = s.actifMs + (cle === active && depuis !== null ? Math.max(0, t - depuis) : 0);
    return normaliserSession({ id: s.id, profil: s.profil, service: s.service, debut: s.debut, fin: t, actifMs: actif });
  }

  return {
    ouvrir(cle, profil, service) {
      if (ouvertes.has(cle)) return false;
      changer((t) => {
        ouvertes.set(cle, { id: 's' + t.toString(36) + '-' + (++seq), profil, service, debut: t, actifMs: 0 });
      });
      return true;
    },
    activer(cle) {
      changer(() => { active = cle === undefined ? null : cle; });
    },
    focus(aLeFocus) {
      changer(() => { focus = aLeFocus === true; });
    },
    // Termine la session de l'onglet ; renvoie l'enregistrement (ou null).
    fermer(cle) {
      const t = maintenant();
      const s = ouvertes.get(cle);
      if (!s) return null;
      const rec = figer(cle, s, t);
      if (cle === active) { depuis = null; active = null; }
      ouvertes.delete(cle);
      return rec;
    },
    // Sessions en cours, figées à l'instant (sans les terminer).
    instantane() {
      const t = maintenant();
      const res = [];
      for (const [cle, s] of ouvertes) {
        const rec = figer(cle, s, t);
        if (rec) res.push(rec);
      }
      return res;
    },
    taille() { return ouvertes.size; }
  };
}

// --- Agrégation -------------------------------------------------------------

// Début de la période (ms) : jour = minuit local, semaine = 7 jours
// glissants, mois = 30 jours glissants, tout = aucune limite.
function debutPeriode(periode, maintenant) {
  if (periode === 'jour') {
    const d = new Date(maintenant);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }
  if (periode === 'semaine') return maintenant - 7 * JOUR_MS;
  if (periode === 'mois') return maintenant - 30 * JOUR_MS;
  return 0;
}

// Part d'une session dans [depuis, +∞[ : une session commencée avant la
// période n'y compte que pour sa partie incluse (temps actif au prorata).
function partDansPeriode(s, depuis) {
  if (s.fin < depuis) return null;
  if (s.debut >= depuis) return { dureeMs: s.fin - s.debut, actifMs: s.actifMs };
  // Ici debut < depuis <= fin : la durée totale est strictement positive.
  const dans = s.fin - depuis;
  return { dureeMs: dans, actifMs: Math.round(s.actifMs * dans / (s.fin - s.debut)) };
}

function cumul(map, cle, part, s) {
  let l = map.get(cle);
  if (!l) { l = { cle, sessions: 0, dureeMs: 0, actifMs: 0, dernier: 0 }; map.set(cle, l); }
  l.sessions += 1;
  l.dureeMs += part.dureeMs;
  l.actifMs += part.actifMs;
  if (s.fin > l.dernier) l.dernier = s.fin;
}

function trier(lignes) {
  return lignes.sort((a, b) => (b.actifMs - a.actifMs) || (b.dureeMs - a.dureeMs) || (a.cle < b.cle ? -1 : 1));
  // (deux lignes n'ont jamais la même clé : elles viennent d'une Map)
}

// Totaux, par compte (profil) et par service. `parService[i].part` : part du
// temps actif total (0..1). Lignes triées par temps actif décroissant.
function agreger(sessions, options) {
  const o = options || {};
  const maintenant = Number.isFinite(o.maintenant) ? o.maintenant : Date.now();
  const depuis = debutPeriode(o.periode, maintenant);
  const totaux = { sessions: 0, dureeMs: 0, actifMs: 0 };
  const comptes = new Map();
  const services = new Map();
  for (const s of Array.isArray(sessions) ? sessions : []) {
    const part = partDansPeriode(s, depuis);
    if (!part) continue;
    totaux.sessions += 1;
    totaux.dureeMs += part.dureeMs;
    totaux.actifMs += part.actifMs;
    cumul(comptes, s.profil, part, s);
    cumul(services, s.service, part, s);
  }
  const parService = trier([...services.values()]).map(l =>
    Object.assign(l, { part: totaux.actifMs ? l.actifMs / totaux.actifMs : 0 }));
  return { depuis, totaux, parCompte: trier([...comptes.values()]), parService };
}

// Décomposition d'une durée pour l'affichage (traduit par l'app.js).
function decomposerDuree(ms) {
  const totalMin = Math.floor((Number.isFinite(ms) && ms > 0 ? ms : 0) / 60000);
  return { heures: Math.floor(totalMin / 60), minutes: totalMin % 60 };
}

// --- Événements du lot 2 : temps de réponse et quotas -----------------------

// Un temps de réponse : envoi du prompt -> fin de la génération (collecte).
//   { id, profil, service, debut, fin }  (ms epoch, fin > debut)
// Durée plafonnée à 24 h : au-delà c'est une donnée aberrante (collecte
// après un week-end, horloge modifiée) — on ne garde pas la mesure.
function normaliserReponse(r) {
  if (!r || typeof r !== 'object') return null;
  const { id, profil, service, debut, fin } = r;
  if (typeof id !== 'string' || !ID_RE.test(id)) return null;
  if (typeof profil !== 'string' || !PROFIL_RE.test(profil)) return null;
  if (typeof service !== 'string' || !SERVICE_RE.test(service)) return null;
  if (!Number.isFinite(debut) || !Number.isFinite(fin)) return null;
  if (debut <= 0 || fin <= debut || fin - debut > JOUR_MS) return null;
  return { id, profil, service, debut: Math.round(debut), fin: Math.round(fin) };
}

// Un quota atteint (cooldown déclenché) : { id, profil, service, date }.
function normaliserQuota(q) {
  if (!q || typeof q !== 'object') return null;
  const { id, profil, service, date } = q;
  if (typeof id !== 'string' || !ID_RE.test(id)) return null;
  if (typeof profil !== 'string' || !PROFIL_RE.test(profil)) return null;
  if (typeof service !== 'string' || !SERVICE_RE.test(service)) return null;
  if (!Number.isFinite(date) || date <= 0) return null;
  return { id, profil, service, date: Math.round(date) };
}

// Médiane d'une liste TRIÉE croissante (paires pour les listes paires).
function mediane(tri) {
  if (!tri.length) return 0;
  const m = Math.floor(tri.length / 2);
  return tri.length % 2 ? tri[m] : Math.round((tri[m - 1] + tri[m]) / 2);
}

// Temps de réponse par (compte, service) : nombre, médiane, min, max.
// Lignes triées par nombre décroissant. `options.periode` comme agreger().
function agregerReponses(reponses, options) {
  const o = options || {};
  const maintenant = Number.isFinite(o.maintenant) ? o.maintenant : Date.now();
  const depuis = debutPeriode(o.periode, maintenant);
  const parCle = new Map();
  const toutes = [];
  for (const r of Array.isArray(reponses) ? reponses : []) {
    if (r.fin < depuis) continue;
    const cle = r.profil + '|' + r.service;
    let l = parCle.get(cle);
    if (!l) { l = { profil: r.profil, service: r.service, durees: [] }; parCle.set(cle, l); }
    const d = r.fin - r.debut;
    l.durees.push(d);
    toutes.push(d);
  }
  const lignes = [...parCle.values()].map(l => {
    const t = l.durees.slice().sort((a, b) => a - b);
    return { profil: l.profil, service: l.service, nombre: t.length,
      medianeMs: mediane(t), minMs: t[0], maxMs: t[t.length - 1] };
  }).sort((a, b) => (b.nombre - a.nombre) || (a.profil < b.profil ? -1 : 1));
  const tt = toutes.sort((a, b) => a - b);
  return { depuis, totaux: { nombre: tt.length, medianeMs: mediane(tt), minMs: tt[0] || 0, maxMs: tt[tt.length - 1] || 0 }, parCompteService: lignes };
}

// Quotas atteints par (compte, service) : nombre + répartition par heure de
// la journée (0..23, heure locale) — « heure habituelle des quotas ».
function agregerQuotas(quotas, options) {
  const o = options || {};
  const maintenant = Number.isFinite(o.maintenant) ? o.maintenant : Date.now();
  const depuis = debutPeriode(o.periode, maintenant);
  const parCle = new Map();
  for (const q of Array.isArray(quotas) ? quotas : []) {
    if (q.date < depuis) continue;
    const cle = q.profil + '|' + q.service;
    let l = parCle.get(cle);
    if (!l) { l = { profil: q.profil, service: q.service, nombre: 0, parHeure: new Array(24).fill(0) }; parCle.set(cle, l); }
    l.nombre += 1;
    l.parHeure[new Date(q.date).getHours()] += 1;
  }
  const lignes = [...parCle.values()].sort((a, b) => (b.nombre - a.nombre) || (a.profil < b.profil ? -1 : 1));
  return { depuis, parCompteService: lignes };
}

// Carte de chaleur jour de semaine × heure : temps actif (prorata d'une
// session sur les heures qu'elle recouvre — même logique que partDansPeriode).
// `matrice[jour][heure]` en ms (jour 0 = dimanche), + maximum pour l'échelle.
function carteHeures(sessions, options) {
  const o = options || {};
  const maintenant = Number.isFinite(o.maintenant) ? o.maintenant : Date.now();
  const depuis = debutPeriode(o.periode, maintenant);
  const matrice = Array.from({ length: 7 }, () => new Array(24).fill(0));
  for (const s of Array.isArray(sessions) ? sessions : []) {
    const part = partDansPeriode(s, depuis);
    if (!part) continue;
    const total = s.fin - s.debut;
    if (total <= 0) continue;
    // Découpe en segments D'UNE HEURE : chaque segment tombe dans la case
    // (jour de semaine, heure) où il commence ; le temps actif est réparti
    // au prorata de la durée des segments (même logique que partDansPeriode).
    let t = Math.max(s.debut, depuis);
    while (t < s.fin) {
      const d = new Date(t);
      const prochaineHeure = t + (60 - d.getMinutes() - d.getSeconds() / 60) * 60000;
      const finSeg = Math.min(prochaineHeure, s.fin);
      const ratio = (finSeg - t) / total;
      matrice[d.getDay()][d.getHours()] += Math.round(s.actifMs * ratio);
      t = finSeg;
    }
  }
  let max = 0;
  for (const ligne of matrice) for (const v of ligne) if (v > max) max = v;
  return { depuis, matrice, max };
}

// Comptes sous-utilisés (rarement ouverts) et surchargés (quota souvent
// atteint), pour mieux répartir l'usage. Seuils configurables.
function classerComptes(sessions, quotas, options) {
  const o = options || {};
  const seuilSessions = Number.isFinite(o.seuilSessions) ? o.seuilSessions : 2;
  const seuilQuotas = Number.isFinite(o.seuilQuotas) ? o.seuilQuotas : 3;
  const maintenant = Number.isFinite(o.maintenant) ? o.maintenant : Date.now();
  const depuis = debutPeriode(o.periode, maintenant);
  const nbSessions = new Map();
  for (const s of Array.isArray(sessions) ? sessions : []) {
    if (!partDansPeriode(s, depuis)) continue;
    nbSessions.set(s.profil, (nbSessions.get(s.profil) || 0) + 1);
  }
  const nbQuotas = new Map();
  for (const q of Array.isArray(quotas) ? quotas : []) {
    if (q.date < depuis) continue;
    nbQuotas.set(q.profil, (nbQuotas.get(q.profil) || 0) + 1);
  }
  const sousUtilises = [];
  const surcharges = [];
  const profils = new Set([...nbSessions.keys(), ...nbQuotas.keys()]);
  for (const p of profils) {
    if ((nbSessions.get(p) || 0) <= seuilSessions) sousUtilises.push(p);
    if ((nbQuotas.get(p) || 0) >= seuilQuotas) surcharges.push(p);
  }
  return { seuilSessions, seuilQuotas, sousUtilises, surcharges };
}

// --- Persistance (process principal) ----------------------------------------

// Store des statistiques. `fs` = fs.promises (ou double de test).
//   dossier/sessions.jsonl   historique (sessions terminées)
//   dossier/en-cours.json    instantané des sessions ouvertes
function creerStore(o) {
  const path = o.path;
  const fichier = path.join(o.dossier, 'sessions.jsonl');
  const fichierEnCours = path.join(o.dossier, 'en-cours.json');
  const maintenant = o.maintenant || Date.now;
  const fs = o.fs;
  let recuperation = null;
  // Dernier instantané reçu : une session qui en disparaît sans être passée
  // par `terminees` a été interrompue (page rechargée) -> versée à l'historique.
  let precedent = [];

  async function lireHistorique() {
    try { return parserJsonl(await fs.readFile(fichier, 'utf-8')); } catch (_) { return []; }
  }

  // Une seule fois par lancement : verse les sessions interrompues du
  // lancement précédent dans l'historique, purge les sessions trop
  // anciennes, réécrit le fichier si quelque chose a changé.
  function recuperer() {
    if (!recuperation) {
      recuperation = (async () => {
        await fs.mkdir(o.dossier, { recursive: true });
        const historique = await lireHistorique();
        let interrompues = [];
        try {
          const brut = JSON.parse(await fs.readFile(fichierEnCours, 'utf-8'));
          interrompues = (Array.isArray(brut) ? brut : []).map(normaliserSession).filter(Boolean);
        } catch (_) { /* pas de fichier : arrêt propre ou premier lancement */ }
        const ids = new Set(historique.map(s => s.id));
        const ajout = interrompues.filter(s => !ids.has(s.id));
        const gardees = purger(historique.concat(ajout), maintenant());
        if (ajout.length || gardees.length !== historique.length) {
          await fs.writeFile(fichier, versJsonl(gardees), 'utf-8');
        }
        await fs.writeFile(fichierEnCours, '[]', 'utf-8');
      })();
    }
    return recuperation;
  }

  // --- Événements du lot 2 : temps de réponse, quotas (fichiers séparés) ---
  const fichierReponses = path.join(o.dossier, 'reponses.jsonl');
  const fichierQuotas = path.join(o.dossier, 'quotas.jsonl');
  let seqEvenements = 0;
  const idEvenement = (prefixe) => prefixe + maintenant().toString(36) + '-' + (++seqEvenements);
  // Plafond d'événements par type (injectable pour les tests).
  const maxEvenements = Number.isFinite(o.maxEvenements) ? o.maxEvenements : MAX_EVENEMENTS;

  async function lireJsonl(fichier, normaliser) {
    try { return parserJsonl(await fs.readFile(fichier, 'utf-8'), normaliser); } catch (_) { return []; }
  }
  async function noter(fichier, normaliser, evenement, champ) {
    const rec = normaliser(evenement);
    if (!rec) return { ok: false, error: 'evenement invalide' };
    await recuperer(); // purge/versement des sessions : dossier garanti présent
    const historique = purger(await lireJsonl(fichier, normaliser), maintenant(), undefined, champ);
    if (historique.length >= maxEvenements) historique.splice(0, historique.length - maxEvenements + 1);
    historique.push(rec);
    await fs.writeFile(fichier, versJsonl(historique), 'utf-8');
    return { ok: true };
  }

  return {
    fichier, fichierEnCours, fichierReponses, fichierQuotas,
    async sync(terminees, enCours) {
      await recuperer();
      const t = (Array.isArray(terminees) ? terminees : []).map(normaliserSession).filter(Boolean);
      const e = (Array.isArray(enCours) ? enCours : []).map(normaliserSession).filter(Boolean);
      const connues = new Set(t.concat(e).map(x => x.id));
      const interrompues = precedent.filter(x => !connues.has(x.id));
      const ajout = t.concat(interrompues);
      if (ajout.length) await fs.appendFile(fichier, versJsonl(ajout), 'utf-8');
      await fs.writeFile(fichierEnCours, JSON.stringify(e), 'utf-8');
      precedent = e;
      return { ok: true, terminees: t.length, enCours: e.length, interrompues: interrompues.length };
    },
    async charger() {
      await recuperer();
      return purger(await lireHistorique(), maintenant());
    },
    // Lot 2 : temps de réponse (envoi -> fin de génération) et quotas atteints.
    async noterReponse(evenement) {
      return noter(fichierReponses, normaliserReponse,
        Object.assign({ id: idEvenement('r') }, evenement));
    },
    async noterQuota(evenement) {
      return noter(fichierQuotas, normaliserQuota,
        Object.assign({ id: idEvenement('q') }, evenement), 'date');
    },
    async chargerReponses() {
      await recuperer();
      return purger(await lireJsonl(fichierReponses, normaliserReponse), maintenant());
    },
    async chargerQuotas() {
      await recuperer();
      return purger(await lireJsonl(fichierQuotas, normaliserQuota), maintenant(), undefined, 'date');
    }
  };
}

function registerStatsIPC(ipc, store) {
  const sur = (fn) => async (_e, ...args) => {
    try { return await fn(...args); } catch (e) { return { error: e.message || String(e) }; }
  };
  ipc.handle('stats:sync', sur((terminees, enCours) => store.sync(terminees, enCours)));
  ipc.handle('stats:load', sur(() => store.charger()));
  ipc.handle('stats:noter-reponse', sur((e) => store.noterReponse(e)));
  ipc.handle('stats:noter-quota', sur((e) => store.noterQuota(e)));
  ipc.handle('stats:reponses', sur(() => store.chargerReponses()));
  ipc.handle('stats:quotas', sur(() => store.chargerQuotas()));
}

const iaoStats = {
  CONSERVATION_JOURS, MAX_EVENEMENTS, JOUR_MS, SYNC_INTERVALLE_MS, PERIODES,
  normaliserSession, normaliserReponse, normaliserQuota,
  parserJsonl, versJsonl, purger, mediane,
  creerSuivi, debutPeriode, agreger, agregerReponses, agregerQuotas,
  carteHeures, classerComptes, decomposerDuree,
  creerStore, registerStatsIPC
};
if (typeof window !== 'undefined') window.iaoStats = iaoStats;
else module.exports = iaoStats;
