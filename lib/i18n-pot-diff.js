'use strict';
// lib/i18n-pot-diff.js — chaînes ajoutées et supprimées entre deux
// lang/messages.pot (issue #51, « identifier chaînes nouvelles / supprimées »).
// Utilisé par scripts/i18n-diff.js dans le résumé du job i18n des PR.
// Une entrée est identifiée par (msgctxt, msgid) ; msgid_plural est conservé
// pour l'affichage. L'en-tête (msgid "") et les entrées obsolètes (#~) sont
// ignorés.

function decoder(s) {
  return s.replace(/\\(.)/g, (_, c) => (c === 'n' ? '\n' : c === 't' ? '\t' : c));
}

// Lit les chaînes d'un .pot / .po : [{ ctxt, id, pluriel }].
function lireChaines(texte) {
  const res = [];
  for (const bloc of String(texte || '').split(/\r?\n\s*\r?\n/)) {
    const champs = {};
    let courant = null;
    for (const ligne of bloc.split(/\r?\n/)) {
      const m = /^(msgctxt|msgid_plural|msgid|msgstr(?:\[\d+\])?) "((?:[^"\\]|\\.)*)"$/.exec(ligne);
      if (m) { courant = m[1]; champs[courant] = decoder(m[2]); continue; }
      const suite = /^"((?:[^"\\]|\\.)*)"$/.exec(ligne);
      if (suite && courant) champs[courant] += decoder(suite[1]);
      else courant = null;
    }
    if (!champs.msgid) continue; // en-tête, commentaires seuls, obsolètes
    res.push({ ctxt: champs.msgctxt || '', id: champs.msgid, pluriel: champs.msgid_plural || '' });
  }
  return res;
}

const cle = (e) => e.ctxt + '\u0004' + e.id;

function comparer(ancienTexte, nouveauTexte) {
  const ancien = lireChaines(ancienTexte);
  const nouveau = lireChaines(nouveauTexte);
  const avant = new Set(ancien.map(cle));
  const apres = new Set(nouveau.map(cle));
  return {
    avant: ancien.length,
    apres: nouveau.length,
    ajoutees: nouveau.filter((e) => !avant.has(cle(e))),
    supprimees: ancien.filter((e) => !apres.has(cle(e)))
  };
}

function libelle(e) {
  const txt = (e.ctxt ? '[' + e.ctxt + '] ' : '') + e.id + (e.pluriel ? ' / ' + e.pluriel : '');
  const court = txt.length > 120 ? txt.slice(0, 117) + '...' : txt;
  return '`' + court.replace(/`/g, "'").replace(/\n/g, ' ') + '`';
}

// Résumé Markdown pour $GITHUB_STEP_SUMMARY ; au plus `max` lignes par liste.
function resumeMarkdown(diff, max) {
  const limite = max || 50;
  const lignes = ['### Chaînes modifiées par cette PR', '',
    '| | Nombre |', '|---|---|',
    '| Chaînes avant | ' + diff.avant + ' |',
    '| Chaînes après | ' + diff.apres + ' |',
    '| Nouvelles | ' + diff.ajoutees.length + ' |',
    '| Supprimées | ' + diff.supprimees.length + ' |', ''];
  const liste = (titre, entrees) => {
    if (!entrees.length) return;
    lignes.push('**' + titre + '**', '');
    for (const e of entrees.slice(0, limite)) lignes.push('- ' + libelle(e));
    if (entrees.length > limite) lignes.push('- … et ' + (entrees.length - limite) + ' autre(s)');
    lignes.push('');
  };
  liste('Nouvelles chaînes (à traduire dans chaque langue)', diff.ajoutees);
  liste('Chaînes supprimées (traductions retirées des .po)', diff.supprimees);
  if (!diff.ajoutees.length && !diff.supprimees.length) lignes.push('Aucune chaîne ajoutée ni supprimée.', '');
  return lignes.join('\n');
}

module.exports = { lireChaines, comparer, resumeMarkdown };
