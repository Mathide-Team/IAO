'use strict';

// lib/identifiants-preload.js — preload de session pour les identifiants
// partagés (issue #278, lot 2). Posé sur CHAQUE session (webviews ET popups
// d'authentification, qui partagent la partition de la webview) par
// main.js via session.setPreloads : il s'exécute dans le contexte isolé de
// chaque page, sans Node applicatif.
//
// Deux rôles, aucun secret ne transite en clair vers la page :
//   1. Au focus d'un champ de connexion, prévenir le process principal
//      ('iao-identifiants:focus') — il décide seul (hôte de l'URL réelle,
//      coffre) s'il propose le menu des identifiants.
//   2. Sur 'iao-identifiants:remplir' (envoyé PAR le process principal après
//      choix dans son menu), remplir les champs mémorisés : setter natif de
//      value + événements input/change (formulaires contrôlés React/Vue).
//      Jamais de soumission, jamais de champ 2FA, jamais d'iframe.
//
// Le fichier est AUTO-CONTENU (un preload sandboxé ne peut require() que
// 'electron') mais chargeable par `node --test` : les fonctions pures sont
// exportées et testées avec un DOM factice ; l'auto-branchement n'a lieu que
// si 'electron' ET document sont disponibles.

const CANAL_FOCUS = 'iao-identifiants:focus';
const CANAL_REMPLIR = 'iao-identifiants:remplir';
const TYPES_TEXTE = ['text', 'email', 'tel', 'username', ''];
const RE_2FA = /one[-_]?time[-_]?code|otp|totp/i;

// --- Fonctions pures (DOM générique, testées sans Electron) -----------------

// Champ de saisie de login : input texte-like, pas un champ 2FA.
function estChampLogin(el) {
  return !!(el && el.tagName === 'INPUT' &&
    TYPES_TEXTE.indexOf(String(el.type || '').toLowerCase()) !== -1 &&
    !estChamp2FA(el));
}

// Champ de mot de passe. Jamais considéré comme 2FA : un one-time-code
// autocomplete n'est jamais type=password.
function estChampMotDePasse(el) {
  return !!(el && el.tagName === 'INPUT' && String(el.type || '').toLowerCase() === 'password');
}

// Champ à ne JAMAIS remplir : code à usage unique (2FA), champ de saisie
// ou de confirmation de NOUVEAU mot de passe (autocomplete new-password).
function estChamp2FA(el) {
  const attr = String((el && (el.getAttribute && el.getAttribute('autocomplete'))) || '') +
    ' ' + String((el && (el.name || '')) || '') + ' ' + String((el && (el.id || '')) || '');
  if (RE_2FA.test(attr)) return true;
  const ac = String((el && (el.getAttribute && el.getAttribute('autocomplete'))) || '').toLowerCase();
  return ac === 'new-password';
}

// Remplit un champ : setter natif de la prototype + événements input/change,
// pour que les formulaires contrôlés (React…) voient la valeur.
function remplirChamp(el, valeur) {
  if (!el || typeof valeur !== 'string') return false;
  const proto = Object.getPrototypeOf(el);
  const desc = proto && Object.getOwnPropertyDescriptor(proto, 'value');
  try {
    if (desc && desc.set) desc.set.call(el, valeur);
    else el.value = valeur; // repli (DOM factice des tests ou exotic)
  } catch (_) {
    return false;
  }
  for (const nom of ['input', 'change']) {
    try {
      const Ev = (typeof Event === 'function') ? Event : (el.ownerDocument && el.ownerDocument.defaultView && el.ownerDocument.defaultView.Event);
      el.dispatchEvent(Ev ? new Ev(nom, { bubbles: true }) : { type: nom, bubbles: true });
    } catch (_) { /* le framework de la page n'exige pas l'événement */ }
  }
  return true;
}

// Remplit le couple login/mot de passe mémorisé. Ne remplit JAMAIS un champ
// 2FA, ne soumet JAMAIS le formulaire, ignore un champ détaché du document.
function remplirFormulaire(champs, identifiant) {
  const fait = { login: false, motDePasse: false };
  if (!champs || !identifiant || typeof identifiant !== 'object') return fait;
  const login = champs.login && champs.login.isConnected !== false && !estChamp2FA(champs.login) ? champs.login : null;
  const mdp = champs.motDePasse && champs.motDePasse.isConnected !== false && !estChamp2FA(champs.motDePasse) ? champs.motDePasse : null;
  if (login && identifiant.login) fait.login = remplirChamp(login, String(identifiant.login));
  if (mdp && identifiant.motDePasse) fait.motDePasse = remplirChamp(mdp, String(identifiant.motDePasse));
  return fait;
}

// Mémorise les derniers champs de connexion focusés (le menu du process
// principal prend le focus : activeElement n'est plus le champ au moment du
// remplissage). Au focus d'un seul des deux champs, l'autre est cherché dans
// le même <form> : l'utilisateur n'a pas besoin de visiter chaque champ.
function champFrere(champ, selecteur) {
  // Portée volontairement limitée au formulaire du champ focusé : pas de
  // devinette à l'échelle de la page.
  try {
    const form = champ && champ.closest ? champ.closest('form') : null;
    if (!form || typeof form.querySelector !== 'function') return null;
    return form.querySelector(selecteur);
  } catch (_) {
    return null; // DOM exotique : pas de champ frère
  }
}

// Formulaire (<form>) d'un champ, ou null (absent, DOM exotique) : deux champs
// du même formulaire forment une paire, pas deux champs de formulaires différents.
function formulaireDe(champ) {
  try {
    return champ && champ.closest ? champ.closest('form') : null;
  } catch (_) {
    return null;
  }
}

// Portée commune réellement vérifiée : les deux champs déclarent le MÊME
// formulaire lisible (null — absent, DOM exotique — ne prouve rien).
function memePortee(a, b) {
  const fa = formulaireDe(a);
  const fb = formulaireDe(b);
  return !!fa && fa === fb;
}

function creerEcouteurs(ipc, document) {
  const champs = { login: null, motDePasse: null };
  return {
    champs,
    surFocus(e) {
      const t = e && e.target;
      if (estChampMotDePasse(t)) {
        // On ne réutilise un champ mémorisé que si une portée commune est
        // RÉELLEMENT vérifiée (même <form>) ; sans formulaire lisible, on
        // abandonne : pas de paire entre deux groupes distincts de la page.
        if (champs.login && !memePortee(champs.login, t)) champs.login = null;
        champs.motDePasse = t;
        if (!champs.login) {
          const frere = champFrere(t, 'input[type="email"], input[type="text"], input:not([type])');
          if (frere && estChampLogin(frere) && !estChamp2FA(frere)) champs.login = frere;
        }
        ipc.send(CANAL_FOCUS, { motDePasse: true });
      } else if (estChampLogin(t)) {
        if (champs.motDePasse && !memePortee(champs.motDePasse, t)) champs.motDePasse = null;
        champs.login = t;
        if (!champs.motDePasse) {
          const frere = champFrere(t, 'input[type="password"]');
          if (frere && estChampMotDePasse(frere) && !estChamp2FA(frere)) champs.motDePasse = frere;
        }
        ipc.send(CANAL_FOCUS, { motDePasse: !!champs.motDePasse });
      }
    },
    surRemplir(_e, identifiant) {
      return remplirFormulaire(champs, identifiant);
    }
  };
}

// Branchement : focusin (capture, formulaires ajoutés dynamiquement) + canal
// de remplissage. Retourne les écouteurs (pour les tests).
function brancher(ipc, document) {
  const ecouteurs = creerEcouteurs(ipc, document);
  document.addEventListener('focusin', ecouteurs.surFocus, true);
  ipc.on(CANAL_REMPLIR, ecouteurs.surRemplir);
  return ecouteurs;
}

module.exports = { CANAL_FOCUS, CANAL_REMPLIR, estChampLogin, estChampMotDePasse, estChamp2FA, remplirChamp, remplirFormulaire, creerEcouteurs, brancher };

// --- Auto-branchement en contexte Electron (preload de session) ------------
// En dehors (node --test) : require('electron') échoue, on reste une
// bibliothèque pure.
let electron = null;
try {
  electron = require('electron');
} catch (_) {
  electron = null; // node --test : pas d'Electron, on reste une bibliothèque pure
}
if (electron && electron.ipcRenderer && typeof document !== 'undefined' && document && document.addEventListener) {
  brancher(electron.ipcRenderer, document);
}
