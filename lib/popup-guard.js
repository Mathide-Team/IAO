'use strict';

// popup-guard.js — politique des popups des <webview>, pure et testable via
// `node --test` sans lancer Electron. Aucune dépendance à `electron` : ce
// fichier ne fait que du parsing d'URL (API `URL` native de Node).
//
// Issue #277 : l'ancienne liste blanche explicite ALLOWED_POPUP_HOSTS (chantier
// B) renvoyait vers le navigateur système toute popup dont l'origine n'y
// figurait pas. Or une popup d'authentification OAuth vit dans la session
// (partition) de la webview : ouverte dans le navigateur système, la connexion
// échoue silencieusement. Dès qu'un service ou un connecteur utilisait un
// fournisseur d'identité absent de la liste (context7, Clerk, Auth0, tout
// domaine neuf), sa popup « ne fonctionnait pas ». Maintenir une liste à la
// main ne peut pas « toujours fonctionner ».
//
// Politique : une popup ouverte par une <webview> s'ouvre AVEC LES
// WEBPREFERENCES DE L'INVITÉ (sandboxée, sans Node, jamais celles de l'hôte) —
// elle ne peut donc pas gagner de privilèges, quelle que soit son origine.
// En conséquence, toute popup web « https: » est acceptée dans l'application,
// ainsi que « about:blank » (ouverte vide par certains flux OAuth avant leur
// redirection). Tout le reste — « http: » (schéma non chiffré), « data: »,
// « javascript: », « file: », URL illisible — est refusé sans repli externe.
// La fenêtre hôte, elle, reste en deny-all total (elle est privilégiée).
function decidePopup(urlStr) {
  try {
    const u = new URL(String(urlStr));
    if (u.protocol === 'https:') return 'allow';
    // window.open('about:blank') puis redirection : flux OAuth courant.
    // Sans privilèges, une popup vide n'est pas plus dangereuse qu'une https.
    if (u.protocol === 'about:' && u.pathname === 'blank') return 'allow';
    return 'deny';
  } catch (_) {
    return 'deny'; // URL non parsable (data:, javascript:, texte libre) -> refusée
  }
}

module.exports = { decidePopup };
