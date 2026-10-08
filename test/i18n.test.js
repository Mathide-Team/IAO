'use strict';

// test/i18n.test.js — internationalisation gettext (issue #51).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const i18n = require('../lib/i18n');
const ROOT = path.join(__dirname, '..');

// Construit un .mo minimal (même format que msgfmt), petit- ou gros-boutiste.
function buildMo(entries, bigEndian) {
  const keys = Object.keys(entries).sort();
  const n = keys.length;
  const headerSize = 28;
  const origTable = headerSize;
  const transTable = origTable + n * 8;
  let offset = transTable + n * 8;
  const parts = [];
  const orig = []; const trans = [];
  for (const k of keys) {
    const b = Buffer.from(k, 'utf8'); orig.push([b.length, offset]); parts.push(b, Buffer.from([0])); offset += b.length + 1;
  }
  for (const k of keys) {
    const b = Buffer.from(entries[k], 'utf8'); trans.push([b.length, offset]); parts.push(b, Buffer.from([0])); offset += b.length + 1;
  }
  const head = Buffer.alloc(transTable + n * 8);
  const w = (v, o) => (bigEndian ? head.writeUInt32BE(v, o) : head.writeUInt32LE(v, o));
  w(0x950412de, 0); w(0, 4); w(n, 8); w(origTable, 12); w(transTable, 16); w(0, 20); w(0, 24);
  orig.forEach(([l, o], i) => { w(l, origTable + i * 8); w(o, origTable + i * 8 + 4); });
  trans.forEach(([l, o], i) => { w(l, transTable + i * 8); w(o, transTable + i * 8 + 4); });
  return Buffer.concat([head, ...parts]);
}

const SAMPLE = {
  '': 'Language: en\nPlural-Forms: nplurals=2; plural=(n != 1);\nligne sans deux-points\n',
  'Annuler': 'Cancel',
  '%d compte\u0000%d comptes': '%d account\u0000%d accounts',
  'menu\u0004Fichier': 'File'
};

// --- parseMo -----------------------------------------------------------------

test('parseMo lit un catalogue petit-boutiste : en-têtes, simples, pluriels, contextes', () => {
  const mo = i18n.parseMo(buildMo(SAMPLE, false));
  assert.equal(mo.headers.language, 'en');
  assert.equal(mo.pluralForms, 'nplurals=2; plural=(n != 1);');
  assert.equal(mo.messages.Annuler, 'Cancel');
  assert.deepEqual(mo.messages['%d compte'], ['%d account', '%d accounts']);
  assert.equal(mo.messages['menu\u0004Fichier'], 'File');
});

test('parseMo lit un catalogue gros-boutiste et sans en-tête Plural-Forms', () => {
  const mo = i18n.parseMo(buildMo({ Oui: 'Yes' }, true));
  assert.equal(mo.messages.Oui, 'Yes');
  assert.equal(mo.pluralForms, '');
});

test('parseMo rejette les tampons invalides', () => {
  assert.throws(() => i18n.parseMo(null), /trop court/);
  assert.throws(() => i18n.parseMo(Buffer.alloc(10)), /trop court/);
  assert.throws(() => i18n.parseMo(Buffer.alloc(40)), /magique/);
  const tables = buildMo({ a: 'b' }, false);
  tables.writeUInt32LE(1000, 12);
  assert.throws(() => i18n.parseMo(tables), /tables hors/);
  const strings = buildMo({ a: 'b' }, false);
  strings.writeUInt32LE(9999, 28 + 4);
  assert.throws(() => i18n.parseMo(strings), /chaîne hors/);
});

test('parseMo lit les catalogues compilés du dépôt (lang/<xx>/LC_MESSAGES/iao.mo)', () => {
  const mo = i18n.parseMo(fs.readFileSync(path.join(ROOT, 'lang/en/LC_MESSAGES/iao.mo')));
  assert.equal(mo.headers.language, 'en');
  assert.equal(mo.messages.Annuler, 'Cancel');
});

// --- Plural-Forms ------------------------------------------------------------

test('compilePluralForms : règles réelles (fr, en, ru, ar, ja)', () => {
  const fr = i18n.compilePluralForms('nplurals=2; plural=(n > 1);');
  assert.deepEqual([0, 1, 2].map(fr.plural), [0, 0, 1]);
  const en = i18n.compilePluralForms('nplurals=2; plural=(n != 1);');
  assert.deepEqual([0, 1, 2].map(en.plural), [1, 0, 1]);
  const ru = i18n.compilePluralForms('nplurals=3; plural=(n%10==1 && n%100!=11 ? 0 : n%10>=2 && n%10<=4 && (n%100<10 || n%100>=20) ? 1 : 2);');
  assert.deepEqual([1, 2, 5, 11, 21, 22, 25].map(ru.plural), [0, 1, 2, 2, 0, 1, 2]);
  const ar = i18n.compilePluralForms('nplurals=6; plural=(n==0 ? 0 : n==1 ? 1 : n==2 ? 2 : n%100>=3 && n%100<=10 ? 3 : n%100>=11 ? 4 : 5);');
  assert.deepEqual([0, 1, 2, 3, 11, 100].map(ar.plural), [0, 1, 2, 3, 4, 5]);
  const ja = i18n.compilePluralForms('nplurals=1; plural=0;');
  assert.equal(ja.plural(7), 0);
  assert.equal(ja.nplurals, 1);
});

test('compilePluralForms : tous les opérateurs, division par zéro, index hors bornes', () => {
  const ops = i18n.compilePluralForms('nplurals=99; plural=(n < 3) + (n <= 3) + (n >= 3) + (n == 3) + !(n) + -(-1) + n*2 - n/2 - n%2 + n/0 + n%0 + (0 || 0) + (1 && 0);');
  // n=3 : 0+1+1+1+0+1 +6 -1 -1 +0 +0 +0 +0 = 8
  assert.equal(ops.plural(3), 8);
  assert.deepEqual([0, 4].map(i18n.compilePluralForms('nplurals=2; plural=!n;').plural), [1, 0]);
  const out = i18n.compilePluralForms('nplurals=2; plural=n+5;');
  assert.equal(out.plural(1), 0, 'index >= nplurals -> 0');
  assert.equal(out.plural('pas un nombre'), 0, 'NaN -> 0 -> index 5 -> 0');
});

test('compilePluralForms : en-tête absent -> règle germanique', () => {
  const d = i18n.compilePluralForms(undefined);
  assert.equal(d.nplurals, 2);
  assert.deepEqual([0, 1, 2].map(d.plural), [1, 0, 1]);
});

test('compilePluralForms rejette les expressions invalides sans rien exécuter', () => {
  for (const bad of ['nplurals=2; plural=(n', 'nplurals=2; plural=n ? 1', 'nplurals=2; plural=)',
    'nplurals=2; plural=n n', 'nplurals=2; plural=n $ 1', 'nplurals=2; plural=alert(1)', 'nplurals=2; plural=(n > 1']) {
    assert.throws(() => i18n.compilePluralForms(bad), /Plural-Forms invalide/, bad);
  }
  assert.throws(() => i18n.compilePluralForms('nplurals=2; plural=1 +'), /incomplète/);
  assert.equal(i18n.compilePluralForms('nplurals=2; plural=n   ').plural(1), 1, 'espaces finaux tolérés');
});

// --- createTranslator ----------------------------------------------------------

test('createTranslator : gettext, ngettext, pgettext et has', () => {
  const tr = i18n.createTranslator(Object.assign({ locale: 'en' }, i18n.parseMo(buildMo(SAMPLE, false))));
  assert.equal(tr.locale, 'en');
  assert.equal(tr.gettext('Annuler'), 'Cancel');
  assert.equal(tr.gettext('Inconnu'), 'Inconnu');
  assert.equal(tr.gettext('%d compte'), '%d account', 'gettext sur une entrée plurielle -> forme 0');
  assert.equal(tr.ngettext('%d compte', '%d comptes', 1), '%d account');
  assert.equal(tr.ngettext('%d compte', '%d comptes', 3), '%d accounts');
  assert.equal(tr.ngettext('Annuler', 'Annulers', 3), 'Annulers', 'entrée non plurielle -> repli source');
  assert.equal(tr.pgettext('menu', 'Fichier'), 'File');
  assert.equal(tr.pgettext('autre', 'Fichier'), 'Fichier');
  assert.equal(tr.has('Annuler'), true);
  assert.equal(tr.has('toString'), false, 'pas de fuite du prototype');
});

test('createTranslator : replis (catalogue absent, msgstr vides, Plural-Forms invalide)', () => {
  const none = i18n.createTranslator(null);
  assert.equal(none.locale, 'fr');
  assert.equal(none.gettext('Bonjour'), 'Bonjour');
  assert.equal(none.ngettext('%d jour', '%d jours', 1), '%d jour');
  assert.equal(none.ngettext('%d jour', '%d jours', 0), '%d jour', 'français : 0 au singulier');
  assert.equal(none.ngettext('%d jour', '%d jours', 2), '%d jours');
  assert.equal(none.ngettext('%d jour', '%d jours', 'x'), '%d jour');
  const vides = i18n.createTranslator({
    messages: { A: '', B: ['', ''], C: ['c0', ''] },
    pluralForms: 'nplurals=2; plural=(n'
  });
  assert.equal(vides.gettext('A'), 'A');
  assert.equal(vides.gettext('B'), 'B');
  assert.equal(vides.ngettext('C', 'Cs', 2), 'Cs', 'forme vide -> repli');
  assert.equal(vides.ngettext('C', 'Cs', 1), 'c0');
  assert.equal(vides.pgettext('x', 'A'), 'A');
});

// --- Locales ------------------------------------------------------------------

test('parseLinguas : espaces, lignes, commentaires, doublons', () => {
  assert.deepEqual(i18n.parseLinguas('# commentaire\nfr en\nde  # suite\n\nen\r\npt_BR'), ['fr', 'en', 'de', 'pt_BR']);
  assert.deepEqual(i18n.parseLinguas(null), []);
});

test('lang/LINGUAS déclare les 29 locales de l\'issue #51, toutes livrées', () => {
  const locales = i18n.parseLinguas(fs.readFileSync(path.join(ROOT, 'lang/LINGUAS'), 'utf8'));
  assert.equal(locales.length, 29);
  assert.ok(locales.includes('fr'));
  for (const l of locales) {
    assert.ok(fs.existsSync(path.join(ROOT, 'lang', l + '.po')), l + '.po manquant');
    assert.ok(fs.existsSync(path.join(ROOT, 'lang', l, 'LC_MESSAGES', 'iao.mo')), l + ' : iao.mo manquant');
  }
  for (const f of fs.readdirSync(path.join(ROOT, 'lang')).filter((x) => x.endsWith('.po'))) {
    assert.ok(locales.includes(f.slice(0, -3)), f + ' absent de lang/LINGUAS');
  }
});

test('negotiateLocale : exacte, langue seule, encodage POSIX, repli', () => {
  const avail = ['fr', 'en', 'pt', 'zh_TW'];
  assert.equal(i18n.negotiateLocale(['zh-TW'], avail), 'zh_TW');
  assert.equal(i18n.negotiateLocale(['pt-BR', 'en'], avail), 'pt');
  assert.equal(i18n.negotiateLocale(['en_US.UTF-8'], avail), 'en');
  assert.equal(i18n.negotiateLocale(['de@euro'], avail), 'fr');
  assert.equal(i18n.negotiateLocale(['', null, 'de'], avail, 'en'), 'en');
  assert.equal(i18n.negotiateLocale(null, null), 'fr');
});

test('requestedLocales : --iao-lang=xx, --iao-lang xx, IAO_LANG (liste « : »)', () => {
  assert.deepEqual(i18n.requestedLocales(['electron', '.', '--iao-lang=de'], {}), ['de']);
  assert.deepEqual(i18n.requestedLocales(['--iao-lang', 'it', '--iao-lang'], { IAO_LANG: 'pt_BR:en' }), ['it', 'pt_BR', 'en']);
  assert.deepEqual(i18n.requestedLocales(['--iao-lang='], null), []);
  assert.deepEqual(i18n.requestedLocales(undefined, { IAO_LANG: '  ' }), []);
});

// --- Texte et HTML ------------------------------------------------------------

test('translateText conserve les espaces de bord et normalise les espaces internes', () => {
  const tr = i18n.createTranslator({ messages: { 'Ajouter un compte': 'Add an account' } });
  assert.equal(i18n.translateText('\n  Ajouter   un\ncompte  ', tr), '\n  Add an account  ');
  assert.equal(i18n.translateText('Inconnu', tr), 'Inconnu');
  assert.equal(i18n.translateText('   ', tr), '   ');
  assert.equal(i18n.translateText('', tr), '');
});

test('isTranslatable écarte nombres, symboles et libellés techniques', () => {
  assert.equal(i18n.isTranslatable('Annuler'), true);
  for (const t of ['0', '—', 'IAO', 'DEBUG', 'Ctrl+K', 'Email', 'x']) assert.equal(i18n.isTranslatable(t), false, t);
});

test('extractHtmlMessages : textes et attributs du <body>, hors commentaires/scripts/styles', () => {
  const html = [
    '<html><head><title>Titre ignoré</title></head>',
    '<body>',
    '<!-- Commentaire ignoré -->',
    '<script>var ignore = "Script ignoré";</script>',
    '<style>.x{content:"Style ignoré"}</style>',
    '<button title="Fermer la fenêtre" data-action="Action ignorée">Fermer</button>',
    '<input placeholder="Rechercher..." value="Valeur ignorée">',
    '<img alt="Logo &amp; nom" aria-label="Libellé">',
    '<span>Fermer</span><b>0</b>',
    '</body>Texte final'
  ].join('\n');
  const got = i18n.extractHtmlMessages(html);
  assert.deepEqual(got.map((e) => e.msgid),
    ['Fermer la fenêtre', 'Fermer', 'Rechercher...', 'Logo & nom', 'Libellé', 'Texte final']);
  assert.equal(got[0].line, 6);
  assert.deepEqual(i18n.extractHtmlMessages('Sans corps <i>Italique</i>').map((e) => e.msgid), ['Sans corps', 'Italique']);
});

test('extractHtmlMessages sur index.html : libellés réels, aucun commentaire de développement', () => {
  const msgs = i18n.extractHtmlMessages(fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8')).map((e) => e.msgid);
  assert.ok(msgs.includes('Ajouter un compte'));
  assert.ok(msgs.includes('Rechercher un compte ou une IA...'));
  assert.ok(!msgs.some((m) => /Issue #|invariant/.test(m)), 'un commentaire HTML a fuité dans le catalogue');
});

test('lang/messages.pot contient chaque chaîne extraite d\'index.html', () => {
  const pot = fs.readFileSync(path.join(ROOT, 'lang/messages.pot'), 'utf8');
  for (const { msgid } of i18n.extractHtmlMessages(fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8'))) {
    assert.ok(pot.includes('msgid "' + msgid.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'), 'absent du .pot : ' + msgid +
      ' — lancer scripts/i18n-update.sh');
  }
});

// --- loadCatalog --------------------------------------------------------------

function tempLang(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iao-i18n-'));
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
  return dir;
}

test('loadCatalog : langue demandée livrée -> catalogue sérialisable', () => {
  const dir = tempLang({ LINGUAS: 'en de', 'en/LC_MESSAGES/iao.mo': buildMo(SAMPLE, false) });
  try {
    const c = i18n.loadCatalog({ langDir: dir, preferred: ['en-US'], fs, join: path.join });
    assert.equal(c.locale, 'en');
    assert.deepEqual(c.available, ['fr', 'en'], 'fr ajoutée, de non livrée écartée');
    assert.equal(c.messages.Annuler, 'Cancel');
    assert.equal(c.error, null);
    assert.doesNotThrow(() => JSON.stringify(c));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('loadCatalog : aucune demande, LINGUAS absent ou .mo corrompu -> français', () => {
  const dir = tempLang({ LINGUAS: 'fr en', 'en/LC_MESSAGES/iao.mo': Buffer.from('corrompu') });
  try {
    const none = i18n.loadCatalog({ langDir: dir, preferred: [], fs, join: path.join });
    assert.equal(none.locale, 'fr');
    assert.deepEqual(none.messages, {});
    const bad = i18n.loadCatalog({ langDir: dir, preferred: ['en'], fs, join: path.join });
    assert.equal(bad.locale, 'fr');
    assert.match(bad.error, /^en : /);
    const missing = i18n.loadCatalog({ langDir: path.join(dir, 'absent'), preferred: ['en'], fs, join: path.join });
    assert.deepEqual(missing.available, ['fr']);
    assert.equal(missing.locale, 'fr');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('loadCatalog sur le dépôt : --iao-lang=en traduit, défaut en français', () => {
  const langDir = path.join(ROOT, 'lang');
  const en = i18n.loadCatalog({ langDir, preferred: i18n.requestedLocales(['--iao-lang=en'], {}), fs, join: path.join });
  assert.equal(en.locale, 'en');
  assert.equal(i18n.createTranslator(en).gettext('Ajouter un compte'), 'Add an account');
  assert.equal(i18n.loadCatalog({ langDir, preferred: i18n.requestedLocales([], {}), fs, join: path.join }).locale, 'fr');
});

// --- Export navigateur --------------------------------------------------------

test('lib/i18n.js s\'expose en window.IAO_I18N dans le renderer', () => {
  const file = require.resolve('../lib/i18n');
  const orig = global.window;
  global.window = {};
  try {
    delete require.cache[file];
    require(file);
    assert.equal(typeof global.window.IAO_I18N.createTranslator, 'function');
  } finally {
    if (orig === undefined) delete global.window; else global.window = orig;
    delete require.cache[file];
    require(file);
  }
});

test('formatMessage remplit les marqueurs nommés, même déplacés par la traduction', () => {
  assert.equal(i18n.formatMessage('{service} ouvert avec {account}', { service: 'Claude', account: 'Pro' }), 'Claude ouvert avec Pro');
  assert.equal(i18n.formatMessage('Opened {account} on {service}', { service: 'Claude', account: 'Pro' }), 'Opened Pro on Claude');
  assert.equal(i18n.formatMessage('{count} compte(s)', { count: 0 }), '0 compte(s)');
});

test('formatMessage sans paramètres ou marqueur inconnu : texte inchangé', () => {
  assert.equal(i18n.formatMessage('Compte ajouté'), 'Compte ajouté');
  assert.equal(i18n.formatMessage('{absent} et {x}', { x: 1 }), '{absent} et 1');
  assert.equal(i18n.formatMessage('{toString}', {}), '{toString}');
  assert.equal(i18n.formatMessage(42, null), '42');
});

test('app.js : aucun toast littéral non traduisible', () => {
  const src = fs.readFileSync(path.join(ROOT, 'assets', 'app.js'), 'utf8');
  // showToast('...') ou showToast(`...`) direct : le libellé échapperait à xgettext.
  assert.deepEqual(src.match(/showToast\(\s*['"`]/g) || [], []);
});

test('preferredLocales : demande explicite, puis réglage, puis langues du système', () => {
  const system = ['de-DE', 'en-US'];
  assert.deepEqual(i18n.preferredLocales({ argv: ['--iao-lang=it'], env: {}, setting: 'en', system }), ['it']);
  assert.deepEqual(i18n.preferredLocales({ argv: [], env: { IAO_LANG: 'ja' }, setting: 'en', system }), ['ja']);
  assert.deepEqual(i18n.preferredLocales({ argv: [], env: {}, setting: ' en ', system }), ['en']);
  assert.deepEqual(i18n.preferredLocales({ argv: [], env: {}, setting: 'auto', system }), system);
  assert.deepEqual(i18n.preferredLocales({ setting: 42, system: ['nl', '', null] }), ['nl', 'null']);
  assert.deepEqual(i18n.preferredLocales({ system: 'fr' }), []);
  assert.deepEqual(i18n.preferredLocales(), []);
});
