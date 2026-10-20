'use strict';
// Chaînes ajoutées / supprimées entre deux .pot (issue #51).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { lireChaines, comparer, resumeMarkdown } = require('../lib/i18n-pot-diff');

const ENTETE = 'msgid ""\nmsgstr ""\n"Content-Type: text/plain; charset=UTF-8\\n"\n';
const pot = (...blocs) => [ENTETE, ...blocs].join('\n\n') + '\n';

test('lireChaines : en-tête ignoré, contexte, pluriel, suites et obsolètes', () => {
  const t = pot('#: a.js\nmsgid "Bonjour"\nmsgstr ""',
    'msgctxt "menu"\nmsgid "Ouvrir"\nmsgstr ""',
    'msgid "{n} jour"\nmsgid_plural "{n} jours"\nmsgstr[0] ""\nmsgstr[1] ""',
    'msgid ""\n"Ligne \\"un\\"\\n"\n"deux\\tfin"\nmsgstr ""',
    '#~ msgid "Ancien"\n#~ msgstr "Old"',
    '# commentaire seul');
  assert.deepEqual(lireChaines(t), [
    { ctxt: '', id: 'Bonjour', pluriel: '' },
    { ctxt: 'menu', id: 'Ouvrir', pluriel: '' },
    { ctxt: '', id: '{n} jour', pluriel: '{n} jours' },
    { ctxt: '', id: 'Ligne "un"\ndeux\tfin', pluriel: '' }
  ]);
  assert.deepEqual(lireChaines(undefined), []);
});

test('comparer : nouvelles et supprimées, le contexte distingue deux entrées', () => {
  const a = pot('msgid "A"\nmsgstr ""', 'msgid "B"\nmsgstr ""', 'msgctxt "x"\nmsgid "C"\nmsgstr ""');
  const b = pot('msgid "A"\nmsgstr ""', 'msgid "C"\nmsgstr ""', 'msgid "D"\nmsgid_plural "Ds"\nmsgstr[0] ""');
  const d = comparer(a, b);
  assert.equal(d.avant, 3);
  assert.equal(d.apres, 3);
  assert.deepEqual(d.ajoutees.map((e) => e.id), ['C', 'D']);
  assert.deepEqual(d.supprimees.map((e) => e.ctxt + ':' + e.id), [':B', 'x:C']);
});

test('resumeMarkdown : tableau, listes, troncature et cas sans changement', () => {
  const a = pot('msgid "A"\nmsgstr ""');
  const long = 'x'.repeat(200) + '`';
  const b = pot('msgctxt "c"\nmsgid "N1"\nmsgstr ""', 'msgid "N2 `code`"\nmsgid_plural "N2s"\nmsgstr[0] ""', 'msgid "' + long + '"\nmsgstr ""');
  const md = resumeMarkdown(comparer(a, b), 2);
  assert.match(md, /\| Nouvelles \| 3 \|/);
  assert.match(md, /\| Supprimées \| 1 \|/);
  assert.match(md, /- `\[c\] N1`/);
  assert.match(md, /- `N2 'code' \/ N2s`/);
  assert.match(md, /… et 1 autre\(s\)/);
  assert.match(md, /- `A`/);
  const md2 = resumeMarkdown(comparer(b, b));
  assert.match(md2, /Aucune chaîne ajoutée ni supprimée/);
  const tronque = resumeMarkdown(comparer('', pot('msgid "' + long + '"\nmsgstr ""')));
  assert.match(tronque, /x{117}\.\.\.`/);
});

test('le .pot du dépôt est lisible (sans doublon)', () => {
  const t = fs.readFileSync(path.join(__dirname, '..', 'lang', 'messages.pot'), 'utf8');
  const e = lireChaines(t);
  assert.ok(e.length > 400);
  assert.equal(new Set(e.map((x) => x.ctxt + '\u0004' + x.id)).size, e.length);
  assert.equal(comparer(t, t).ajoutees.length, 0);
});
