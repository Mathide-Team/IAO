'use strict';

// lib/startup-diagnostics.js — fonctions PURES de diagnostic du démarrage
// (issue #52 : « lancement incertain, pas d'icône des erreurs, pas assez de
// debug pour dépanner »). Aucune dépendance Electron ni DOM -> testable par
// `node --test` (invariant 11, CLAUDE.md).
//
// Utilisé à la fois :
//   - côté renderer par assets/boot-guard.js (bandeau d'erreur visible) ;
//   - côté process principal par main.js (journal terminal + fichier).

// Modules qu'un preload SANDBOXÉ peut require(). Depuis Electron 20, un
// preload est sandboxé par défaut dès que nodeIntegration vaut false (cas
// d'IAO depuis l'issue #4) : il n'a accès qu'à ce sous-ensemble. Un
// require('path') y lève « module not found: path », le preload ne s'exécute
// pas, window.iaoAPI n'existe pas, et TOUTE l'interface reste vide (cause de
// l'issue #52). Référence : documentation Electron, « Process Sandboxing ».
const SANDBOXED_PRELOAD_MODULES = Object.freeze(['electron', 'events', 'timers', 'url']);

// Renvoie la liste (dédoublonnée, dans l'ordre d'apparition) des modules
// require()s par un code de preload qui ne sont PAS disponibles en sandbox.
// Analyse statique volontairement simple : require('x') / require("x"), hors
// commentaires (un commentaire qui CITE require('path') n'est pas un appel).
function stripJsComments(code) {
  return String(code == null ? '' : code)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"\\])\/\/.*$/gm, '$1');
}

function findUnsandboxedRequires(code) {
  const found = [];
  const re = /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  const src = stripJsComments(code);
  let m;
  while ((m = re.exec(src)) !== null) {
    const name = m[1].replace(/^node:/, '');
    if (!SANDBOXED_PRELOAD_MODULES.includes(name) && !found.includes(name)) found.push(name);
  }
  return found;
}

// Texte d'une erreur quelconque (Error, chaîne, objet d'événement…), borné.
function errorText(err, max) {
  const limit = max || 500;
  let s;
  if (err == null) s = 'erreur inconnue';
  else if (typeof err === 'string') s = err;
  else if (err instanceof Error || (typeof err === 'object' && typeof err.message === 'string')) {
    s = (err.name && err.name !== 'Error' ? err.name + ': ' : '') + err.message;
  } else {
    try { s = JSON.stringify(err); } catch (_) { s = String(err); }
  }
  s = String(s).trim() || 'erreur inconnue';
  return s.length > limit ? s.slice(0, limit - 1) + '…' : s;
}

// Décrit un problème de démarrage pour l'utilisateur : titre court, détail
// technique, et piste concrète de dépannage.
//   kind : 'preload' (window.iaoAPI absent) | 'error' | 'rejection'
function describeStartupProblem(kind, err, source) {
  const detail = errorText(err) + (source ? ' (' + source + ')' : '');
  if (kind === 'preload') {
    return {
      title: "Le pont sécurisé avec l'application (preload) n'a pas pu se charger",
      detail,
      hint: "Les comptes ne sont pas perdus mais ne peuvent pas s'afficher. " +
        'Relancez IAO depuis un terminal (npm start) et consultez le journal : ' +
        'les lignes [preload] et [renderer] indiquent la cause.'
    };
  }
  return {
    title: kind === 'rejection'
      ? 'Une opération asynchrone a échoué au démarrage'
      : "Une erreur a interrompu l'interface",
    detail,
    hint: "Une partie de l'interface peut être incomplète. Le détail est écrit " +
      'dans le terminal et dans le journal logs/iao.log du dossier de données.'
  };
}

// Niveau de console Electron -> libellé. Electron >= 35 fournit une chaîne
// ('info' | 'warning' | 'error' | 'debug') ; les versions antérieures un
// entier 0..3 (verbose, info, warning, error). On accepte les deux.
function consoleLevelName(level) {
  if (typeof level === 'string') return level === 'warn' ? 'warning' : level;
  return ['debug', 'info', 'warning', 'error'][level] || 'info';
}

// Faut-il recopier ce message de console du renderer dans le journal ?
// Toujours pour warning/error ; tous les niveaux en mode debug.
function shouldForwardConsole(level, debug) {
  const name = consoleLevelName(level);
  return Boolean(debug) || name === 'warning' || name === 'error';
}

// Raccourcit une URL/chemin source (file:///…/IAO/assets/app.js) en
// « assets/app.js » pour des journaux lisibles.
function shortSource(sourceId) {
  if (!sourceId) return '';
  const s = String(sourceId).replace(/\\/g, '/');
  const parts = s.split('/').filter(Boolean);
  return parts.slice(-2).join('/');
}

// Ligne de journal horodatée : « 2026-09-29T15:12:00.000Z [scope] niveau message (source:ligne) ».
function formatLogLine(date, scope, level, message, sourceId, line) {
  const iso = (date instanceof Date ? date : new Date(date)).toISOString();
  const src = shortSource(sourceId);
  const where = src ? ' (' + src + (line ? ':' + line : '') + ')' : '';
  const text = String(message == null ? '' : message).replace(/\s+$/, '');
  return iso + ' [' + scope + '] ' + consoleLevelName(level) + ' ' + text + where;
}

// Mode debug : option --iao-debug sur la ligne de commande ou IAO_DEBUG=1.
// (Anciennement --debug, mais Node.js intercepte --debug comme flag obsolète
// DEP0062 et affiche un avertissement au lieu de le passer à l'application.)
function isDebugEnabled(argv, env) {
  const args = Array.isArray(argv) ? argv : [];
  const e = env || {};
  return args.includes('--iao-debug') || args.includes('--debug') || /^(1|true|yes|oui)$/i.test(String(e.IAO_DEBUG || ''));
}

const api = {
  SANDBOXED_PRELOAD_MODULES,
  findUnsandboxedRequires,
  errorText,
  describeStartupProblem,
  consoleLevelName,
  shouldForwardConsole,
  shortSource,
  formatLogLine,
  isDebugEnabled
};

// Même double chargement que les autres lib/*.js : <script src> dans le
// renderer (window) et require() dans main.js / les tests (module).
if (typeof window !== 'undefined') {
  window.IAOStartupDiagnostics = api;
} else if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
}
