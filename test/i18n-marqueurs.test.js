'use strict';

// test/i18n-marqueurs.test.js — contrôle des marqueurs {…} des catalogues
// .po (issue #51, durcissement #229) : chaque traduction doit conserver
// EXACTEMENT les marqueurs du msgid (même ensemble, quantités comprises).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const DIR_LANG = path.join(ROOT, 'lang');

// --- Analyse d'un fichier .po -------------------------------------------------
// Machine à états minimale : msgid "…" / msgstr "…" + continuations "…".
// Les échappements gettext sont décodés (\" \\ \n \t).
function decoderChaine(ligne) {
  const m = ligne.match(/^"((?:[^"\\]|\\.)*)"\s*$/);
  if (!m) return null;
  return m[1].replace(/\\(.)/g, (tout, c) => {
    if (c === 'n') return '\n';
    if (c === 't') return '\t';
    return c; // \" -> ", \\ -> \, et tout autre échappement : littéral
  });
}

function parserPo(texte) {
  const entrees = [];
  let msgid = null; let msgstr = null;
  let courante = null; // 'msgid' | 'msgstr' | null
  for (const ligneBrute of texte.split('\n')) {
    const ligne = ligneBrute.trim();
    if (!ligne || ligne.startsWith('#')) continue; // commentaires / vides
    if (ligne.startsWith('msgid ')) {
      if (msgid !== null && msgstr !== null) entrees.push({ msgid, msgstr });
      msgid = decoderChaine(ligne.slice(6));
      msgstr = null;
      courante = 'msgid';
    } else if (ligne.startsWith('msgstr ')) {
      msgstr = decoderChaine(ligne.slice(7));
      courante = 'msgstr';
    } else if (ligne.startsWith('"')) {
      const morceau = decoderChaine(ligne);
      if (morceau === null) continue;
      if (courante === 'msgid' && msgid !== null) msgid += morceau;
      else if (courante === 'msgstr' && msgstr !== null) msgstr += morceau;
    }
  }
  if (msgid !== null && msgstr !== null) entrees.push({ msgid, msgstr });
  return entrees;
}

// Marqueurs {…} d'une chaîne (ensemble TRIÉ : l'ordre peut différer entre
// langues, pas les marqueurs ni leurs quantités).
function marqueurs(chaine) {
  return (chaine.match(/\{[^{}]*\}/g) || []).sort();
}

// Contrôle d'un texte .po : renvoie la liste des écarts.
function ecartsMarqueurs(texte) {
  const ecarts = [];
  for (const { msgid, msgstr } of parserPo(texte)) {
    if (msgstr === null || msgstr === '') continue; // non traduit : hors périmètre
    const attendus = marqueurs(msgid);
    const trouves = marqueurs(msgstr);
    if (JSON.stringify(attendus) !== JSON.stringify(trouves)) {
      ecarts.push({ msgid, attendus, trouves });
    }
  }
  return ecarts;
}

// --- Auto-vérification : le contrôle doit ÉCHOUER sur un marqueur altéré ------

test('le contrôle des marqueurs détecte un marqueur altéré (auto-vérification)', () => {
  // Un marqueur renommé, un supprimé, un dupliqué, un ajouté : tous signalés.
  const corrompu = [
    'msgid "{available} service(s) sans cooldown sur {total}"',
    'msgstr "{disponibles} serviço(s) sem cooldown em {total}"',
    '',
    'msgid "Page d\u2019accueil de {service}"',
    'msgstr "Página inicial de {service} {service}"'
  ].join('\n');
  const ecarts = ecartsMarqueurs(corrompu);
  assert.equal(ecarts.length, 2, 'les deux entrées corrompues sont signalées');
  assert.deepEqual(ecarts[0].attendus.sort(), ['{available}', '{total}']);
  assert.deepEqual(ecarts[0].trouves.sort(), ['{disponibles}', '{total}']);
  assert.deepEqual(ecarts[1].attendus.sort(), ['{service}']);
  assert.deepEqual(ecarts[1].trouves.sort(), ['{service}', '{service}']);
  // Une traduction SINCÈRE ne produit aucun écart.
  const correct = 'msgid "{available} sur {total}"\nmsgstr "{available} em {total}"';
  assert.deepEqual(ecartsMarqueurs(correct), []);
});

// --- Contrôle réel : tous les catalogues --------------------------------------

test('tous les catalogues .po conservent exactement les marqueurs {…} du msgid', () => {
  const fichiers = fs.readdirSync(DIR_LANG).filter(f => f.endsWith('.po'));
  assert.ok(fichiers.length > 0, 'au moins un catalogue trouvé');
  const problemes = [];
  for (const fichier of fichiers) {
    const texte = fs.readFileSync(path.join(DIR_LANG, fichier), 'utf-8');
    for (const ecart of ecartsMarqueurs(texte)) {
      problemes.push(fichier + ' : « ' + ecart.msgid.slice(0, 60) +
        '… » attendus ' + JSON.stringify(ecart.attendus) +
        ' trouvés ' + JSON.stringify(ecart.trouves));
    }
  }
  assert.deepEqual(problemes, [], 'aucun marqueur manquant/renommé/dupliqué :\n' + problemes.join('\n'));
});
