'use strict';

// test/i18n-pluriels.test.js — pluriels gettext (issue #51) : les compteurs
// « compte(s) » sont devenus des entrées msgid_plural ; chaque langue doit
// fournir exactement nplurals formes, et la forme générale (la dernière)
// conserver tous les marqueurs {…} du msgid_plural. Les autres formes
// peuvent omettre le nombre (« every minute », « كل دقيقتين »).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const i18n = require('../lib/i18n');

const DIR_LANG = path.join(__dirname, '..', 'lang');
const LOCALES = i18n.parseLinguas(fs.readFileSync(path.join(DIR_LANG, 'LINGUAS'), 'utf8'))
  .filter((l) => l !== i18n.SOURCE_LOCALE);

const decoder = (s) => s.replace(/\\(.)/g, (_, c) => (c === 'n' ? '\n' : c));
function entreesPluriel(texte) {
  const res = [];
  for (const bloc of texte.split(/\n\s*\n/)) {
    const pl = /^msgid_plural "((?:[^"\\]|\\.)*)"$/m.exec(bloc);
    if (!pl) continue;
    const id = /^msgid "((?:[^"\\]|\\.)*)"$/m.exec(bloc);
    const formes = [];
    const re = /^msgstr\[(\d+)\] "((?:[^"\\]|\\.)*)"$/gm;
    for (let m = re.exec(bloc); m; m = re.exec(bloc)) formes[Number(m[1])] = decoder(m[2]);
    res.push({ msgid: decoder(id[1]), pluriel: decoder(pl[1]), formes });
  }
  return res;
}
const marqueurs = (s) => (s.match(/\{[^{}]*\}/g) || []).sort();

test('le catalogue source contient les compteurs en pluriel gettext', () => {
  const pot = fs.readFileSync(path.join(DIR_LANG, 'messages.pot'), 'utf8');
  const ids = entreesPluriel(pot).map((e) => e.msgid);
  for (const id of ['{count} compte exporté', '{n} jour', 'chaque minute', '{available} service hors cooldown sur {total}']) {
    assert.ok(ids.includes(id), 'pluriel absent du .pot : ' + id);
  }
});

for (const loc of LOCALES) {
  test(loc + ' : chaque pluriel a nplurals formes et conserve ses marqueurs', () => {
    const po = fs.readFileSync(path.join(DIR_LANG, loc + '.po'), 'utf8');
    const nplurals = Number(/nplurals=(\d+)/.exec(po)[1]);
    const entrees = entreesPluriel(po);
    assert.ok(entrees.length >= 15, loc + ' : ' + entrees.length + ' pluriels seulement');
    for (const e of entrees) {
      assert.equal(e.formes.length, nplurals, loc + ' « ' + e.msgid + ' » : ' + e.formes.length + ' formes au lieu de ' + nplurals);
      const attendus = marqueurs(e.pluriel);
      e.formes.forEach((f, i) => {
        assert.ok(f, loc + ' « ' + e.msgid + ' » : forme ' + i + ' vide');
        const trouves = marqueurs(f);
        for (const t of trouves) assert.ok(attendus.includes(t), loc + ' « ' + e.msgid + ' » forme ' + i + ' : marqueur inconnu ' + t);
        if (i === nplurals - 1) assert.deepEqual(trouves, attendus, loc + ' « ' + e.msgid + ' » : la forme générale doit garder ' + attendus.join(' '));
      });
    }
  });
}

function traducteur(locale) {
  const catalog = i18n.loadCatalog({ langDir: DIR_LANG, preferred: [locale], fs, join: path.join });
  assert.equal(catalog.locale, locale);
  return i18n.createTranslator(catalog);
}

test('formes choisies selon la langue (catalogues compilés .mo)', () => {
  const ru = traducteur('ru');
  const jour = (tr, n) => i18n.formatMessage(tr.ngettext('{n} jour', '{n} jours', n), { n });
  assert.equal(jour(ru, 1), '1 день');
  assert.equal(jour(ru, 3), '3 дня');
  assert.equal(jour(ru, 5), '5 дней');
  assert.equal(jour(ru, 21), '21 день');
  const ar = traducteur('ar');
  assert.equal(ar.ngettext('chaque minute', 'toutes les {n} minutes', 2), 'كل دقيقتين');
  assert.equal(i18n.formatMessage(ar.ngettext('chaque minute', 'toutes les {n} minutes', 5), { n: 5 }), 'كل 5 دقائق');
  const en = traducteur('en');
  assert.equal(en.ngettext('chaque heure', 'toutes les {n} heures', 1), 'every hour');
  assert.equal(i18n.formatMessage(en.ngettext('chaque heure', 'toutes les {n} heures', 3), { n: 3 }), 'every 3 hours');
  const ja = traducteur('ja');
  assert.equal(i18n.formatMessage(ja.ngettext('{count} tâche', '{count} tâches', 1), { count: 1 }), '1 件のタスク');
});

test('français (langue source) : 0 et 1 au singulier, sans catalogue', () => {
  const fr = i18n.createTranslator(null);
  assert.equal(fr.ngettext('chaque minute', 'toutes les {n} minutes', 1), 'chaque minute');
  assert.equal(fr.ngettext('{n} jour', '{n} jours', 0), '{n} jour');
  assert.equal(fr.ngettext('{n} jour', '{n} jours', 2), '{n} jours');
});
