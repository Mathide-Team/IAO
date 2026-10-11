'use strict';

// lib/settings.js — fonctions PURES pour le panneau de réglages (lot 18/09/2026,
// FEATURES.md P2 « Panneau de réglages »). Aucune dépendance à Electron ni au
// DOM -> testable par `node --test` (invariant 11, CLAUDE.md).
//
// Périmètre : normalisation et validation des réglages utilisateur. Les
// réglages sont persistés côté main.js (userData/settings.json) via IPC dédiés.
// Ce module fournit uniquement la logique de validation/normalisation.

// Valeurs par défaut des réglages utilisateur.
var DEFAULT_SETTINGS = {
  editorFontSize: 14,       // taille de police Monaco (px)
  editorWordWrap: 'off',    // 'off' | 'on' | 'wordWrapColumn'
  theme: 'system',   // 'system' | 'iao' | 'light' | 'dark' (issue #139 : défaut = thème du bureau)
  confirmBeforeClose: true, // modale de confirmation à la fermeture d'un onglet
  showAutomationWindows: false, // afficher les fenêtres d'automatisation
  startWithLastSession: false,  // restaurer les onglets ouverts au démarrage
  language: 'auto'              // issue #51 : 'auto' (langue du système) ou code de locale (lang/LINGUAS)
};

// Bornes pour la validation des valeurs numériques.
var EDITOR_FONT_SIZE_MIN = 8;
var EDITOR_FONT_SIZE_MAX = 32;
var VALID_THEMES = ['system', 'iao', 'light', 'dark'];
var VALID_WORD_WRAP = ['off', 'on', 'wordWrapColumn'];

// Normalise une valeur de taille de police éditeur.
// Renvoie la valeur bornée et entière, ou la valeur par défaut.
function normalizeEditorFontSize(value) {
  var n = parseInt(value, 10);
  if (isNaN(n)) return DEFAULT_SETTINGS.editorFontSize;
  if (n < EDITOR_FONT_SIZE_MIN) return EDITOR_FONT_SIZE_MIN;
  if (n > EDITOR_FONT_SIZE_MAX) return EDITOR_FONT_SIZE_MAX;
  return n;
}

// Normalise une valeur de thème. Renvoie la valeur par défaut si invalide.
function normalizeTheme(value) {
  if (typeof value === 'string' && VALID_THEMES.indexOf(value) !== -1) {
    return value;
  }
  return DEFAULT_SETTINGS.theme;
}

// Normalise une valeur de word wrap.
function normalizeWordWrap(value) {
  if (typeof value === 'string' && VALID_WORD_WRAP.indexOf(value) !== -1) {
    return value;
  }
  return DEFAULT_SETTINGS.editorWordWrap;
}

// Issue #51 : langue de l'interface. 'auto' ou un code de locale (« en »,
// « pt_BR »...). Aucune liste codée ici (elle vit dans lang/LINGUAS) : un
// code bien formé mais non livré retombe sur le français au chargement.
var LANGUAGE_RE = /^[a-z]{2,3}(_[A-Z]{2})?$/;
function normalizeLanguage(value) {
  if (typeof value === 'string' && (value === 'auto' || LANGUAGE_RE.test(value))) return value;
  return DEFAULT_SETTINGS.language;
}

// Normalise un booléen. Accepte true/false, 'true'/'false', 1/0.
function normalizeBoolean(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') return value === 'true' || value === '1';
  return false;
}

// Normalise un objet de réglages brut (venant d'un JSON chargé par exemple).
// Renvoie un objet complet avec toutes les clés de DEFAULT_SETTINGS, les
// valeurs invalides remplacées par les valeurs par défaut.
function normalizeSettings(raw) {
  var s = raw && typeof raw === 'object' ? raw : {};
  return {
    editorFontSize: s.editorFontSize !== undefined ? normalizeEditorFontSize(s.editorFontSize) : DEFAULT_SETTINGS.editorFontSize,
    editorWordWrap: s.editorWordWrap !== undefined ? normalizeWordWrap(s.editorWordWrap) : DEFAULT_SETTINGS.editorWordWrap,
    theme: s.theme !== undefined ? normalizeTheme(s.theme) : DEFAULT_SETTINGS.theme,
    confirmBeforeClose: s.confirmBeforeClose !== undefined ? normalizeBoolean(s.confirmBeforeClose) : DEFAULT_SETTINGS.confirmBeforeClose,
    showAutomationWindows: s.showAutomationWindows !== undefined ? normalizeBoolean(s.showAutomationWindows) : DEFAULT_SETTINGS.showAutomationWindows,
    startWithLastSession: s.startWithLastSession !== undefined ? normalizeBoolean(s.startWithLastSession) : DEFAULT_SETTINGS.startWithLastSession,
    language: s.language !== undefined ? normalizeLanguage(s.language) : DEFAULT_SETTINGS.language
  };
}

// Vérifie si deux objets de réglages sont différents (deep equality simple).
// Utilisé pour éviter de sauvegarder si rien n'a changé.
function settingsChanged(a, b) {
  if (!a || !b) return true;
  return JSON.stringify(a) !== JSON.stringify(b);
}

// Issue #139 : résout le thème à poser sur <html data-theme>. « system » suit
// le thème du bureau (prefers-color-scheme, relayé par Electron nativeTheme) :
// sombre -> 'dark', clair -> 'light'. Si la préférence est inconnue
// (prefersDark ni true ni false), repli sur le thème maison 'iao'.
function resolveTheme(theme, prefersDark) {
  var t = normalizeTheme(theme);
  if (t !== 'system') return t;
  if (prefersDark === true) return 'dark';
  if (prefersDark === false) return 'light';
  return 'iao';
}

// Construit un plan d'application des réglages (quels effets de bord
// déclencher). Fonction PURE — l'application réelle (DOM, IPC) se fait dans
// index.html applySettings(). Ce plan est testable sans DOM.
// env (optionnel) : { prefersDark } — préférence du bureau, pour « system ».
// Renvoie : { themeAttr, followsSystem, monacoOptions, fallbackFontSizePx,
//             schedulerConfigPush, shouldRestoreTabs, shouldConfirmClose }
function buildApplySettingsPlan(settings, env) {
  var s = normalizeSettings(settings);
  return {
    themeAttr: resolveTheme(s.theme, env ? env.prefersDark : undefined),
    followsSystem: s.theme === 'system',
    monacoOptions: { fontSize: s.editorFontSize, wordWrap: s.editorWordWrap },
    fallbackFontSizePx: s.editorFontSize + 'px',
    schedulerConfigPush: { showAutomationWindows: s.showAutomationWindows },
    shouldRestoreTabs: s.startWithLastSession === true,
    shouldConfirmClose: s.confirmBeforeClose === true
  };
}

// Sérialise la liste des onglets ouverts pour persistance localStorage.
// Fonction PURE — extrait les paires { accId, svcId } d'un tableau d'onglets.
function serializeOpenTabs(tabs) {
  if (!Array.isArray(tabs)) return JSON.stringify([]);
  var tabList = tabs.map(function(t) {
    if (!t) return null;
    return { accId: t.accId || null, svcId: t.svcId || null };
  }).filter(function(t) { return t && t.accId && t.svcId; });
  return JSON.stringify(tabList);
}

// Désérialise la liste des onglets sauvegardés. Renvoie [] si invalide/vide.
// Fonction PURE — l'appelant (restoreOpenTabs dans index.html) itère le résultat.
function deserializeOpenTabs(json) {
  if (typeof json !== 'string') return [];
  try {
    var parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(function(t) {
      return t && typeof t === 'object' && t.accId && t.svcId;
    });
  } catch (_) {
    return [];
  }
}

// Construit le prompt de livraison par défaut pour un job.
// Utilisé quand un job n'a pas de tâche associée avec un prompt personnalisé.
function buildDeliveryPrompt(job) {
  var id = (job && job.id) || 'job_inconnu';
  var profile = (job && job.profile) || 'profil_inconnu';
  return 'Projet ' + id + ' — continuer les features à faire. ' +
    'Faire évoluer les fichiers de suivi, de tests et de documentation. ' +
    'Livraison du zip horodaté {YYYYMMDD-HHMMSS} sans passer à la suite. ' +
    'Profil : ' + profile + '.';
}

// Chargé à la fois via <script src="lib/settings.js"> dans index.html
// et via require() depuis test/ (même pattern que les autres modules lib/).
if (typeof window !== 'undefined') {
  window.DEFAULT_SETTINGS = DEFAULT_SETTINGS;
  window.normalizeSettings = normalizeSettings;
  window.normalizeEditorFontSize = normalizeEditorFontSize;
  window.normalizeTheme = normalizeTheme;
  window.normalizeWordWrap = normalizeWordWrap;
  window.normalizeBoolean = normalizeBoolean;
  window.normalizeLanguage = normalizeLanguage;
  window.settingsChanged = settingsChanged;
  window.buildApplySettingsPlan = buildApplySettingsPlan;
  window.resolveTheme = resolveTheme;
  window.serializeOpenTabs = serializeOpenTabs;
  window.deserializeOpenTabs = deserializeOpenTabs;
  window.buildDeliveryPrompt = buildDeliveryPrompt;
} else if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    DEFAULT_SETTINGS: DEFAULT_SETTINGS,
    normalizeSettings: normalizeSettings,
    normalizeEditorFontSize: normalizeEditorFontSize,
    normalizeTheme: normalizeTheme,
    normalizeWordWrap: normalizeWordWrap,
    normalizeBoolean: normalizeBoolean,
    normalizeLanguage: normalizeLanguage,
    settingsChanged: settingsChanged,
    buildApplySettingsPlan: buildApplySettingsPlan,
    resolveTheme: resolveTheme,
    serializeOpenTabs: serializeOpenTabs,
    deserializeOpenTabs: deserializeOpenTabs,
    buildDeliveryPrompt: buildDeliveryPrompt,
    EDITOR_FONT_SIZE_MIN: EDITOR_FONT_SIZE_MIN,
    EDITOR_FONT_SIZE_MAX: EDITOR_FONT_SIZE_MAX,
    VALID_THEMES: VALID_THEMES,
    VALID_WORD_WRAP: VALID_WORD_WRAP
  };
}
