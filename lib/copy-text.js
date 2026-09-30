'use strict';

// copyText() — issue #138 : un clic sur l'e-mail d'un compte (menu latéral)
// le copie dans le presse-papiers. Extrait vers lib/ dès l'écriture
// (invariant 11) : les dépendances (navigator.clipboard, document) sont
// injectées, ce qui rend la fonction testable par `node --test` sans DOM.
//
// Stratégie : API asynchrone navigator.clipboard.writeText d'abord ; si elle
// est absente ou refusée, repli sur un <textarea> hors écran +
// document.execCommand('copy'). Résout toujours (jamais de rejet) avec
// true si la copie a réussi, false sinon (texte vide, aucune API, échec).
async function copyText(text, env) {
  const value = String(text == null ? '' : text);
  if (!value) return false;
  const e = env || {};
  const clipboard = e.clipboard;
  if (clipboard && typeof clipboard.writeText === 'function') {
    try {
      await clipboard.writeText(value);
      return true;
    } catch (_) { /* permission refusée / document sans focus -> repli */ }
  }
  const doc = e.document;
  if (!doc || typeof doc.execCommand !== 'function' || !doc.body) return false;
  const area = doc.createElement('textarea');
  area.value = value;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.left = '-9999px';
  doc.body.appendChild(area);
  // Pas de try/finally avec return dans les deux blocs : V8 y compte une
  // branche « sortie du finally » impossible à exécuter (couverture, #55).
  let ok = false;
  try {
    area.select();
    ok = doc.execCommand('copy') === true;
  } catch (_) { /* ok reste false */ }
  doc.body.removeChild(area);
  return ok;
}

// Même double chargement que lib/escape-html.js : `window` d'abord (renderer),
// module.exports sinon (tests node --test).
if (typeof window !== 'undefined') {
  window.copyText = copyText;
} else if (typeof module !== 'undefined' && module.exports) {
  module.exports = { copyText };
}
