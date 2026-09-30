'use strict';

// lib/starred-tabs.js — Fonctions PURES pour la gestion des onglets étoilés
// (issue #154). Aucune dépendance à Electron ni au DOM -> testable par
// `node --test` (invariant 11, CLAUDE.md). La persistance localStorage reste
// dans assets/app.js — seules les fonctions pures de manipulation de l'état
// sont extraites ici.

// ---------------------------------------------------------------------------
// Clé stable identifiant un onglet par la paire (accId, svcId). Survit à la
// fermeture/rouverture de l'onglet : l'étoile n'est pas liée à l'instance
// de l'onglet mais à la paire compte+service.
// ---------------------------------------------------------------------------
function tabStarKey(accId, svcId) {
  return String(accId || '') + '|' + String(svcId || '');
}

// ---------------------------------------------------------------------------
// Vérifie si une paire (accId, svcId) est étoilée dans l'ensemble donné.
// ---------------------------------------------------------------------------
function isTabStarred(starredSet, accId, svcId) {
  if (!starredSet || typeof starredSet.has !== 'function') return false;
  return starredSet.has(tabStarKey(accId, svcId));
}

// ---------------------------------------------------------------------------
// Bascule l'étoile d'une paire (accId, svcId) dans l'ensemble donné.
// Retourne le nouvel ensemble (immuable — ne mute pas l'original).
// ---------------------------------------------------------------------------
function toggleTabStar(starredSet, accId, svcId) {
  var set = new Set(starredSet || []);
  var key = tabStarKey(accId, svcId);
  if (set.has(key)) {
    set.delete(key);
  } else {
    set.add(key);
  }
  return set;
}

// ---------------------------------------------------------------------------
// Sérialise un ensemble d'étoiles pour persistance localStorage.
// Retourne un tableau JSON-stringifiable de clés.
// ---------------------------------------------------------------------------
function serializeStarredTabs(starredSet) {
  if (!starredSet || typeof starredSet[Symbol.iterator] !== 'function') {
    return JSON.stringify([]);
  }
  var arr = [];
  starredSet.forEach(function(key) {
    if (typeof key === 'string') arr.push(key);
  });
  return JSON.stringify(arr);
}

// ---------------------------------------------------------------------------
// Désérialise une liste d'étoiles depuis localStorage. Retourne un Set.
// Tolérant : renvoie un Set vide si invalide/vide.
// ---------------------------------------------------------------------------
function deserializeStarredTabs(json) {
  if (typeof json !== 'string') return new Set();
  try {
    var parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter(function(s) { return typeof s === 'string'; }));
  } catch (_) {
    return new Set();
  }
}

// Chargé à la fois via <script src="lib/starred-tabs.js"> dans index.html
// et via require() depuis test/ (même pattern que lib/escape-html.js).
if (typeof window !== 'undefined') {
  window.tabStarKey = tabStarKey;
  window.isTabStarred = isTabStarred;
  window.toggleTabStar = toggleTabStar;
  window.serializeStarredTabs = serializeStarredTabs;
  window.deserializeStarredTabs = deserializeStarredTabs;
} else if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    tabStarKey: tabStarKey,
    isTabStarred: isTabStarred,
    toggleTabStar: toggleTabStar,
    serializeStarredTabs: serializeStarredTabs,
    deserializeStarredTabs: deserializeStarredTabs
  };
}
