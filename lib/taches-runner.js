'use strict';

// lib/taches-runner.js — minuterie des tâches programmables, côté renderer
// (issue #199, lot 3). Fonctions PURES : toutes les actions passent par des
// dépendances injectées, testées par node --test sans DOM.
//
//   deps.invoke(canal, ...args)                 ipcRenderer.invoke
//   deps.comptes()                              [{ profile, services }]
//   deps.ouvrirOnglet(profil, fournisseur, url) true si l'onglet est ouvert
//   deps.attendre(ms)                           Promise (setTimeout)
//
// Déroulé d'un plan (scheduler/taches-service.js) : pour chaque étape, dans
// l'ordre et après son délai, ouvrir l'onglet (nouvelle session si `url`),
// envoyer le prompt par `scheduler:run-claude-job` (diagnostic, quota,
// heures calmes et délai anti-détection y sont déjà gérés), réessayer tant
// que la page n'est pas prête (webview pas encore attachée, zone de saisie
// absente pendant le chargement), puis rendre compte par `taches:report`.

const INTERVALLE_MS = 30 * 1000;
const TENTATIVES = 6;
const PAUSE_TENTATIVE_MS = 10 * 1000;

function _pasPrete(res) {
  const err = res && res.error ? String(res.error) : '';
  return /Aucune webview|element_not_found/.test(err);
}

async function executerEtape(plan, etape, deps) {
  if (!deps.ouvrirOnglet(etape.profil, plan.fournisseur, plan.url)) {
    return deps.invoke('taches:report', plan.tache, etape.profil,
      { error: 'Aucune webview ouverte pour le profil « ' + etape.profil + ' ».' });
  }
  let res = null;
  for (let i = 0; i < TENTATIVES; i++) {
    if (i) await deps.attendre(PAUSE_TENTATIVE_MS);
    try {
      res = await deps.invoke('scheduler:run-claude-job', etape.profil, plan.prompt, null);
    } catch (e) {
      res = { error: e && e.message ? e.message : String(e) };
    }
    if (!_pasPrete(res)) break;
  }
  return deps.invoke('taches:report', plan.tache, etape.profil, res);
}

// Étapes dans l'ordre ; `delaiMs` est compté depuis le début du plan.
async function executerPlan(plan, deps) {
  let ecoule = 0;
  for (const etape of plan.etapes) {
    if (etape.delaiMs > ecoule) {
      await deps.attendre(etape.delaiMs - ecoule);
      ecoule = etape.delaiMs;
    }
    await executerEtape(plan, etape, deps);
  }
}

// Un passage de la minuterie ; jamais deux en même temps (un compte à la fois).
function creerMinuterie(deps) {
  let enCours = false;
  return async function passage() {
    if (enCours) return false;
    enCours = true;
    try {
      const plans = await deps.invoke('taches:dues', deps.comptes());
      for (const plan of Array.isArray(plans) ? plans : []) await executerPlan(plan, deps);
      return true;
    } finally {
      enCours = false;
    }
  };
}

const iaoTachesRunner = {
  INTERVALLE_MS, TENTATIVES, PAUSE_TENTATIVE_MS,
  executerEtape, executerPlan, creerMinuterie
};
if (typeof window !== 'undefined') window.iaoTachesRunner = iaoTachesRunner;
else module.exports = iaoTachesRunner;
