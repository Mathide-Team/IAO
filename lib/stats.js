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
function parserJsonl(texte) {
  const sessions = [];
  for (const ligne of String(texte || '').split('\n')) {
    if (!ligne.trim()) continue;
    let brut;
    try { brut = JSON.parse(ligne); } catch (_) { continue; }
    const s = normaliserSession(brut);
    if (s) sessions.push(s);
  }
  return sessions;
}

function versJsonl(sessions) {
  return sessions.map(s => JSON.stringify(s) + '\n').join('');
}

// Conservation : sessions terminées depuis moins de `jours` jours.
function purger(sessions, maintenant, jours) {
  const limite = maintenant - (jours === undefined ? CONSERVATION_JOURS : jours) * JOUR_MS;
  return sessions.filter(s => s.fin >= limite);
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

  return {
    fichier, fichierEnCours,
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
    }
  };
}

function registerStatsIPC(ipc, store) {
  const sur = (fn) => async (_e, ...args) => {
    try { return await fn(...args); } catch (e) { return { error: e.message || String(e) }; }
  };
  ipc.handle('stats:sync', sur((terminees, enCours) => store.sync(terminees, enCours)));
  ipc.handle('stats:load', sur(() => store.charger()));
}

const iaoStats = {
  CONSERVATION_JOURS, JOUR_MS, SYNC_INTERVALLE_MS, PERIODES,
  normaliserSession, parserJsonl, versJsonl, purger,
  creerSuivi, debutPeriode, agreger, decomposerDuree,
  creerStore, registerStatsIPC
};
if (typeof window !== 'undefined') window.iaoStats = iaoStats;
else module.exports = iaoStats;
