'use strict';

// lib/activity-status.js — fonctions PURES pour l'affichage d'état de la
// liste de comptes et de la barre d'onglets (lot demandé le 16/09/2026 :
// tri alphanumérique des comptes, badge de statut par compte, onglet
// "inactif"). Aucune dépendance à Electron ni au DOM -> testable par
// `node --test` (voir invariant 11, CLAUDE.md).
//
// Portée volontairement limitée à de l'AFFICHAGE : ces fonctions ne décident
// jamais quel compte utiliser ni n'envoient rien à un service IA — voir
// docs/PROJECT_CONTEXT.md pour la discussion sur ce qui a été exclu de ce lot.

// ---------------------------------------------------------------------------
// Tri alphanumérique des comptes (ordo demandé, point « liste triée par
// alpha numérique »). Découpe en segments chiffres/non-chiffres pour que
// "Compte 2" se place avant "Compte 10" (un tri texte pur les inverserait).
// ---------------------------------------------------------------------------
function compareAccountNames(nameA, nameB) {
  const a = String(nameA == null ? '' : nameA);
  const b = String(nameB == null ? '' : nameB);
  const splitter = /(\d+)|(\D+)/g;
  const partsA = a.match(splitter) || [];
  const partsB = b.match(splitter) || [];
  const len = Math.max(partsA.length, partsB.length);
  for (let i = 0; i < len; i++) {
    const pa = partsA[i];
    const pb = partsB[i];
    if (pa === undefined) return -1;
    if (pb === undefined) return 1;
    const isNumA = /^\d+$/.test(pa);
    const isNumB = /^\d+$/.test(pb);
    if (isNumA && isNumB) {
      const diff = Number(pa) - Number(pb);
      if (diff !== 0) return diff;
    } else {
      const cmp = pa.localeCompare(pb, 'fr', { sensitivity: 'base' });
      if (cmp !== 0) return cmp;
    }
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Statut d'activité d'un compte, pour le badge de couleur de la liste :
//   'open'   -> un onglet de ce compte est actuellement ouvert (bleu)
//   'recent' -> aucun onglet ouvert, mais utilisé manuellement il y a moins
//               de thresholdHours (rouge)
//   'idle'   -> aucun onglet ouvert, jamais utilisé OU utilisé il y a plus
//               de thresholdHours (vert)
// Se base sur acc.automation.lastUsedAt (déjà tracé par openService() pour
// l'ordonnanceur, chantier E) et sur la présence d'un onglet ouvert — jamais
// sur un contenu lu dans une <webview> de service. thresholdHours a par
// défaut la même valeur (5h) que DEFAULT_CONFIG.profileAgeThresholdHours de
// scheduler/core.js, mais ce module ne l'importe pas : affichage totalement
// indépendant de l'ordonnanceur, pour rester un simple badge d'information
// (voir docs/PROJECT_CONTEXT.md).
// ---------------------------------------------------------------------------
function getAccountActivityStatus(opts) {
  const o = opts || {};
  if (o.hasOpenTab) return 'open';
  const lastUsedAt = Number(o.lastUsedAt) || 0;
  if (lastUsedAt === 0) return 'idle'; // jamais ouvert manuellement
  const now = Number(o.now) || Date.now();
  const thresholdHours = Number(o.thresholdHours) || 5;
  const thresholdMs = thresholdHours * 60 * 60 * 1000;
  return (now - lastUsedAt) >= thresholdMs ? 'idle' : 'recent';
}

// ---------------------------------------------------------------------------
// Issue #137 : même statut, mais par couple (compte, service), pour la puce
// posée sur chaque bouton d'IA (9 puces par compte au lieu d'une). Règles
// inchangées (getAccountActivityStatus) : bleu si un onglet de CE service de
// CE compte est ouvert, rouge si ce service a été ouvert manuellement il y a
// moins de thresholdHours, vert sinon. lastUsedBySvc = { [svcId]: ms },
// tracé par openService() à côté de acc.automation.lastUsedAt (qui reste
// l'horodatage par compte utilisé par l'ordonnanceur).
// ---------------------------------------------------------------------------
function getServiceActivityStatus(opts) {
  const o = opts || {};
  const tabs = Array.isArray(o.tabs) ? o.tabs : [];
  const used = o.lastUsedBySvc && typeof o.lastUsedBySvc === 'object' ? o.lastUsedBySvc : {};
  return getAccountActivityStatus({
    hasOpenTab: tabs.some(t => t && t.accId === o.accId && t.svcId === o.svcId),
    lastUsedAt: used[o.svcId] || 0,
    now: o.now,
    thresholdHours: o.thresholdHours
  });
}

// Libellé (attribut title) d'une puce de statut.
function activityStatusTitle(status) {
  return status === 'open' ? 'Onglet ouvert'
    : status === 'recent' ? 'Utilisé il y a moins de 5h'
    : 'Inactif depuis plus de 5h (ou jamais ouvert)';
}

// ---------------------------------------------------------------------------
// Un onglet est "inactif" (visuel de rappel) s'il n'a pas été au premier
// plan depuis plus de thresholdMinutes (5 par défaut). lastFocusAt est mis à
// jour côté index.html à chaque activateTab() — ne lit rien dans la
// <webview> elle-même (pas de contenu de page IA inspecté).
// ---------------------------------------------------------------------------
function isTabIdle(lastFocusAt, now, thresholdMinutes) {
  const last = Number(lastFocusAt) || 0;
  if (last === 0) return false;
  const nowMs = Number(now) || Date.now();
  const thresholdMs = (Number(thresholdMinutes) || 5) * 60 * 1000;
  return (nowMs - last) >= thresholdMs;
}

// ---------------------------------------------------------------------------
// Comptes assignables à une tâche de l'ordonnanceur (lot 18/09/2026, point 6).
// Un compte est « assignable » s'il est VERT : pas d'onglet ouvert (pas 'open')
// ET inactif depuis au moins thresholdHours (statut 'idle'). Les comptes
// 'recent' (rouge, < thresholdHours) et 'open' (bleu, onglet actif) sont
// exclus — l'utilisateur a demandé que les tâches ne soient confiées qu'aux
// comptes verts (plus de 5h d'inactivité).
// ---------------------------------------------------------------------------
function isAccountAssignable(opts) {
  if (!opts) return false; // null/undefined -> pas assignable
  const o = opts;
  if (o.hasOpenTab) return false; // bleu = onglet ouvert, pas assignable
  const lastUsedAt = Number(o.lastUsedAt) || 0;
  if (lastUsedAt === 0) return true; // jamais ouvert = vert = assignable
  const now = Number(o.now) || Date.now();
  const thresholdHours = Number(o.thresholdHours) || 5;
  const thresholdMs = thresholdHours * 60 * 60 * 1000;
  return (now - lastUsedAt) >= thresholdMs;
}

// Filtre une liste de comptes pour ne garder que les comptes « verts »
// assignables à une tâche. Renvoie les comptes complets (pas juste les ids).
// `openAccountIds` est un Set/Array des ids de comptes qui ont un onglet ouvert.
function getAssignableAccounts(accounts, openAccountIds, thresholdHours, now) {
  if (!Array.isArray(accounts)) return [];
  const openSet = openAccountIds instanceof Set ? openAccountIds : new Set(openAccountIds || []);
  const nowMs = Number(now) || Date.now();
  const th = Number(thresholdHours) || 5;
  return accounts.filter(acc => {
    if (!acc || (acc.automation && acc.automation.enabled === false)) return false;
    const hasOpenTab = openSet.has(acc.id);
    return isAccountAssignable({
      hasOpenTab,
      lastUsedAt: acc.automation ? acc.automation.lastUsedAt : 0,
      now: nowMs,
      thresholdHours: th
    });
  });
}

// Chargé à la fois via <script src="lib/activity-status.js"> dans index.html
// et via require() depuis test/ (même pattern que lib/escape-html.js).
if (typeof window !== 'undefined') {
  window.compareAccountNames = compareAccountNames;
  window.getAccountActivityStatus = getAccountActivityStatus;
  window.getServiceActivityStatus = getServiceActivityStatus;
  window.activityStatusTitle = activityStatusTitle;
  window.isTabIdle = isTabIdle;
  window.isAccountAssignable = isAccountAssignable;
  window.getAssignableAccounts = getAssignableAccounts;
} else if (typeof module !== 'undefined' && module.exports) {
  module.exports = { compareAccountNames, getAccountActivityStatus, getServiceActivityStatus, activityStatusTitle, isTabIdle, isAccountAssignable, getAssignableAccounts };
}
