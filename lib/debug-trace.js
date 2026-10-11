// lib/debug-trace.js — mode debug sur toute l'application (issue #162).
//
// `--iao-debug` (ou IAO_DEBUG=1, voir lib/startup-diagnostics.js isDebugEnabled)
// ne recopiait jusqu'ici que la console de la fenêtre principale. Ce module
// regroupe la logique pure des autres traces, testable sans Electron :
//
//   - traceIpcMain : chaque appel IPC (canal, durée, succès ou erreur) ;
//   - describeRuntime : versions et options de lancement, au démarrage ;
//   - shouldForwardGuestConsole : console des onglets IA (<webview>).
//
// Règle de confidentialité : les ARGUMENTS des appels IPC ne sont jamais
// journalisés (contenu de fichiers, export de comptes, prompts...), seulement
// leur nombre. Les URL d'onglets sont réduites à l'hôte par main.js (hostOf) :
// une URL d'auth peut porter des jetons OAuth en paramètres.
//
// Hors mode debug, traceIpcMain renvoie l'objet ipcMain tel quel : aucun coût.

'use strict';

function errorMessage(e) {
  if (e && typeof e.message === 'string' && e.message) return e.message;
  return String(e);
}

// Réponse de type { error: '…' } : convention des gestionnaires de
// l'ordonnanceur (scheduler/index.js, enveloppe `safe`), qui n'échouent
// jamais par exception.
function isErrorResult(result) {
  return Boolean(result && typeof result === 'object' && result.error);
}

// Enveloppe ipcMain.handle pour tracer chaque appel en mode debug.
// `log(scope, level, message)` : la fonction de journal de main.js.
// `now()` : horloge en millisecondes (injectable pour les tests).
function traceIpcMain(ipcMain, options) {
  const opts = options || {};
  if (!opts.enabled) return ipcMain;
  const log = opts.log;
  const now = typeof opts.now === 'function' ? opts.now : Date.now;
  const traced = Object.create(ipcMain);
  traced.handle = function(channel, handler) {
    return ipcMain.handle(channel, async (event, ...args) => {
      const started = now();
      const suffix = () => ' (' + (now() - started) + ' ms, ' + args.length + ' argument(s))';
      try {
        const result = await handler(event, ...args);
        if (isErrorResult(result)) log('ipc', 'debug', channel + ' → erreur : ' + result.error + suffix());
        else log('ipc', 'debug', channel + ' → ok' + suffix());
        return result;
      } catch (e) {
        log('ipc', 'debug', channel + ' → exception : ' + errorMessage(e) + suffix());
        throw e;
      }
    });
  };
  return traced;
}

// Ligne de démarrage du mode debug : versions et options de lancement.
// `proc` : l'objet process (ou un équivalent dans les tests).
function describeRuntime(proc) {
  const p = proc || {};
  const v = p.versions || {};
  const argv = Array.isArray(p.argv) ? p.argv.slice(1) : [];
  return 'mode debug actif — Electron ' + (v.electron || '?') + ', Chrome ' + (v.chrome || '?') +
    ', Node ' + (v.node || '?') + ', V8 ' + (v.v8 || '?') +
    ' ; options : ' + (argv.length ? argv.join(' ') : '(aucune)');
}

// Console d'un onglet IA : les sites tiers écrivent énormément en niveau
// debug/info ; seuls avertissements et erreurs sont utiles au diagnostic.
function shouldForwardGuestConsole(level) {
  return level === 2 || level === 3 || level === 'warning' || level === 'warn' || level === 'error';
}

const api = {
  traceIpcMain,
  describeRuntime,
  shouldForwardGuestConsole,
  isErrorResult
};

// Utilisé par main.js uniquement (pas de <script> dans le renderer).
module.exports = api;
