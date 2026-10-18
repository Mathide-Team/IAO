'use strict';

// lib/startup-accounts.js — comptes lus au démarrage, pour iao.log (issue #203,
// piste #186 « les profils ne sont pas chargés au démarrage »). Fonctions PURES,
// chargées par le renderer (<script src>, window.iaoStartupAccounts) et par
// node --test (module.exports).

// Résumé de la lecture des comptes au démarrage (renderer, issue #186).
// `etat` : { statut: 'ok'|'empty'|'corrupt'|'invalid', nombre, sauvegarde }.
function resumeComptes(etat) {
  const statuts = {
    ok: 'lu', empty: 'absent', corrupt: 'CORROMPU', invalid: 'illisible (pas un tableau)'
  };
  return 'Comptes lus au démarrage : ' + (etat.nombre || 0) + ' — ai_accounts : ' +
    (statuts[etat.statut] || etat.statut) + ' — sauvegarde ai_accounts_backup : ' +
    (etat.sauvegarde ? 'présente' : 'absente') + '.';
}

// Niveau de la ligne : avertissement si des comptes ont disparu ou sont illisibles.
function niveauComptes(etat) {
  if (etat.statut === 'corrupt' || etat.statut === 'invalid') return 'warning';
  if (!etat.nombre && etat.sauvegarde) return 'warning';
  return 'info';
}

// Même schéma que lib/starred-tabs.js : <script src> dans index.html, require() dans test/.
const iaoStartupAccounts = { resumeComptes: resumeComptes, niveauComptes: niveauComptes };
if (typeof window !== 'undefined') window.iaoStartupAccounts = iaoStartupAccounts;
else module.exports = iaoStartupAccounts;
