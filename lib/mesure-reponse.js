// lib/mesure-reponse.js — temps de réponse des messages envoyés À LA MAIN
// (issue #206, question 3 acceptée le 20/10/2026).
//
// Le renderer injecte `scriptMesure(service)` dans la page du service
// (webview.executeJavaScript, à chaque dom-ready). Le script :
//   - note l'heure de l'ENVOI (Entrée dans la zone de saisie, ou clic sur le
//     bouton d'envoi), si aucune génération n'est déjà en cours ;
//   - attend l'apparition de l'indicateur de génération (bouton « Stop »,
//     attribut data-is-streaming…) puis sa disparition (FIN) ;
//   - range { debut, fin } dans une file de la page (20 au plus), que le
//     renderer vide toutes les quelques secondes (`SCRIPT_LECTURE`). Pas de
//     console : certains sites la neutralisent en production.
// Seuls deux horodatages sortent de la page : jamais le texte de la question
// ni de la réponse. Le renderer valide chaque mesure (`lireMesures`) puis
// l'enregistre via stats:noter-reponse (lib/stats.js, normaliserReponse).
//
// Sélecteurs « au mieux » : les pages changent sans prévenir. Un indicateur
// introuvable ne casse rien (aucune mesure, la page fonctionne normalement) ;
// en mode debug, le renderer journalise chaque mesure reçue.
// Enveloppé dans une fonction : chargé comme <script> classique, il ne doit
// pas déclarer de noms globaux (INTERVALLE_MS existe déjà ailleurs).
(function () {
'use strict';

// Lecture (et vidage) de la file par le renderer ; '[]' si le script est absent.
const SCRIPT_LECTURE = '(function(){var f=window.__iaoMesureReponseFile;' +
  'if(!f)return "[]";var s=JSON.stringify(f);f.length=0;return s;})()';
const INTERVALLE_LECTURE_MS = 3000;
const FILE_MAX = 20;
// Génération qui ne démarre pas dans ce délai après l'envoi : mesure abandonnée
// (message vide, envoi refusé, indicateur introuvable).
const DELAI_DEBUT_MS = 60 * 1000;
// Réponse plus longue : abandonnée (onglet oublié, indicateur bloqué).
const DUREE_MAX_MS = 30 * 60 * 1000;
// Fin validée après ce temps sans indicateur (évite un clignotement).
const STABILITE_FIN_MS = 600;
const INTERVALLE_MS = 200;
// Fenêtre acceptée pour la fin annoncée par la page, par rapport à l'heure du
// renderer au moment de la lecture (lecture différée, onglet en arrière-plan
// dont les minuteries sont ralenties par Chromium).
const FIN_PASSEE_MAX_MS = 5 * 60 * 1000;
const FIN_FUTURE_MAX_MS = 5 * 1000;

// Repli commun aux services de discussion : bouton « Stop » générique.
const STOP_GENERIQUE = ['button[aria-label*="stop" i]', 'button[data-testid*="stop" i]'];
const ENVOI_GENERIQUE = ['button[type="submit"]', 'button[aria-label*="send" i]', 'button[aria-label*="envoyer" i]', 'button[data-testid*="send" i]'];

// Par service : indicateurs « génération en cours » et boutons d'envoi.
// Claude.ai en premier (signal data-is-streaming déjà utilisé par
// lib/claude-adapter.js pour les tâches programmées).
const SERVICES = {
  claude: {
    enCours: ['[data-is-streaming="true"]', 'button[aria-label="Stop response"]', 'button[aria-label="Arrêter la réponse"]'].concat(STOP_GENERIQUE),
    envoi: ['button[aria-label="Send message"]', 'button[aria-label="Envoyer le message"]'].concat(ENVOI_GENERIQUE)
  },
  chatgpt: {
    enCours: ['button[data-testid="stop-button"]'].concat(STOP_GENERIQUE),
    envoi: ['button[data-testid="send-button"]', '#composer-submit-button'].concat(ENVOI_GENERIQUE)
  },
  gemini: {
    enCours: ['button.send-button.stop', 'button[aria-label="Stop response"]', 'button[aria-label="Arrêter la réponse"]'].concat(STOP_GENERIQUE),
    envoi: ['button.send-button'].concat(ENVOI_GENERIQUE)
  },
  perplexity: {
    enCours: ['button[data-testid="stop-generating-response-button"]', 'button[aria-label="Stop"]'].concat(STOP_GENERIQUE),
    envoi: ['button[data-testid="submit-button"]', 'button[aria-label="Submit"]'].concat(ENVOI_GENERIQUE)
  },
  grok: {
    enCours: ['button[aria-label="Stop model response"]'].concat(STOP_GENERIQUE),
    envoi: ['button[aria-label="Submit"]'].concat(ENVOI_GENERIQUE)
  },
  zeta: { enCours: STOP_GENERIQUE, envoi: ['#send-message-button'].concat(ENVOI_GENERIQUE) },
  mistral: { enCours: STOP_GENERIQUE, envoi: ENVOI_GENERIQUE },
  deepseek: { enCours: STOP_GENERIQUE, envoi: ENVOI_GENERIQUE },
  qwen: { enCours: STOP_GENERIQUE.concat(['button.stop-button']), envoi: ['#send-message-button'].concat(ENVOI_GENERIQUE) }
};
// Hors périmètre : générateurs d'images, de musique, de vidéo ou de 3D
// (Leonardo, Suno, Meshy, Ideogram, Kling, Runway, Pika), traduction (DeepL),
// recherche (Wolfram, Elicit, NotebookLM), page d'accueil Copilot : pas de
// « réponse » au sens d'une génération de texte bornée par un bouton Stop.

function estMesurable(service) {
  return Object.prototype.hasOwnProperty.call(SERVICES, service);
}

// Code injecté dans la page (ES5, aucune dépendance). Renvoie 'ok', 'deja'
// (déjà présent après une navigation interne) ou 'absent' (service inconnu).
function scriptMesure(service) {
  if (!estMesurable(service)) return '"absent"';
  const cfg = {
    fileMax: FILE_MAX,
    enCours: SERVICES[service].enCours,
    envoi: SERVICES[service].envoi,
    delaiDebut: DELAI_DEBUT_MS,
    dureeMax: DUREE_MAX_MS,
    stabilite: STABILITE_FIN_MS,
    intervalle: INTERVALLE_MS
  };
  return '(' + corpsScript.toString() + ')(' + JSON.stringify(cfg) + ')';
}

/* Exécuté dans la page du service ; testé par test/mesure-reponse.test.js
   (DOM simulé) et le harnais Electron (C14). */
function corpsScript(cfg) {
  if (window.__iaoMesureReponse) return 'deja';
  window.__iaoMesureReponse = true;
  var file = window.__iaoMesureReponseFile = [];
  var etat = { envoi: 0, vu: false, absentDepuis: 0 };
  function visible(el) {
    return !!(el.offsetWidth || el.offsetHeight || (el.getClientRects && el.getClientRects().length));
  }
  function trouve(liste) {
    for (var i = 0; i < liste.length; i++) {
      var el = null;
      try { el = document.querySelector(liste[i]); } catch (e) { el = null; }
      if (el && visible(el)) return true;
    }
    return false;
  }
  function enCours() { return trouve(cfg.enCours); }
  function armer() {
    if (etat.envoi || enCours()) return;
    etat.envoi = Date.now(); etat.vu = false; etat.absentDepuis = 0;
  }
  function estSaisie(el) {
    return !!el && (el.tagName === 'TEXTAREA' || el.isContentEditable === true ||
      (el.tagName === 'INPUT' && (el.type === 'text' || el.type === 'search')));
  }
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && estSaisie(e.target)) armer();
  }, true);
  document.addEventListener('click', function (e) {
    var cible = e.target;
    while (cible && cible !== document) {
      for (var i = 0; i < cfg.envoi.length; i++) {
        var ok = false;
        try { ok = cible.matches && cible.matches(cfg.envoi[i]); } catch (err) { ok = false; }
        if (ok) { armer(); return; }
      }
      cible = cible.parentNode;
    }
  }, true);
  setInterval(function () {
    if (!etat.envoi) return;
    var t = Date.now();
    if (enCours()) { etat.vu = true; etat.absentDepuis = 0; }
    else if (etat.vu) {
      if (!etat.absentDepuis) etat.absentDepuis = t;
      else if (t - etat.absentDepuis >= cfg.stabilite) {
        if (file.length < cfg.fileMax) file.push({ debut: etat.envoi, fin: etat.absentDepuis });
        etat.envoi = 0;
      }
      return;
    }
    if ((!etat.vu && t - etat.envoi > cfg.delaiDebut) || t - etat.envoi > cfg.dureeMax) etat.envoi = 0;
  }, cfg.intervalle);
  return 'ok';
}

// Résultat de SCRIPT_LECTURE -> mesures { debut, fin } valides (les autres
// sont ignorées : page qui forgerait la file, horloge incohérente).
function lireMesures(json, maintenant) {
  let liste;
  try { liste = JSON.parse(json); } catch (_) { return []; }
  if (!Array.isArray(liste)) return [];
  const t = Number.isFinite(maintenant) ? maintenant : Date.now();
  const res = [];
  for (const d of liste.slice(0, FILE_MAX)) {
    if (!d || !Number.isFinite(d.debut) || !Number.isFinite(d.fin)) continue;
    if (d.debut <= 0 || d.fin <= d.debut || d.fin - d.debut > DUREE_MAX_MS) continue;
    if (d.fin > t + FIN_FUTURE_MAX_MS || d.fin < t - FIN_PASSEE_MAX_MS) continue;
    res.push({ debut: Math.round(d.debut), fin: Math.round(d.fin) });
  }
  return res;
}

const iaoMesureReponse = {
  SCRIPT_LECTURE, INTERVALLE_LECTURE_MS, FILE_MAX, DELAI_DEBUT_MS, DUREE_MAX_MS,
  STABILITE_FIN_MS, INTERVALLE_MS, FIN_PASSEE_MAX_MS, FIN_FUTURE_MAX_MS,
  SERVICES, estMesurable, scriptMesure, lireMesures, corpsScript
};
if (typeof window !== 'undefined') window.iaoMesureReponse = iaoMesureReponse;
else module.exports = iaoMesureReponse;
})();
