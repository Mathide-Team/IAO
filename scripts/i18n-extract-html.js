#!/usr/bin/env node
// scripts/i18n-extract-html.js — extraction des chaînes visibles d'index.html
// vers un fragment POT (issue #51). Appelé par scripts/i18n-update.sh, qui le
// fusionne avec l'extraction xgettext des fichiers JavaScript.
//   node scripts/i18n-extract-html.js index.html > sortie.pot
'use strict';
const fs = require('fs');
const path = require('path');
const { extractHtmlMessages } = require('../lib/i18n');

function poQuote(s) {
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n') + '"';
}

const file = process.argv[2] || 'index.html';
const rel = path.relative(process.cwd(), path.resolve(file)).split(path.sep).join('/');
const entries = extractHtmlMessages(fs.readFileSync(file, 'utf8'));
const out = [
  'msgid ""',
  'msgstr ""',
  '"Content-Type: text/plain; charset=UTF-8\\n"',
  ''
];
for (const { msgid, line } of entries) {
  out.push('#: ' + rel + ':' + line, 'msgid ' + poQuote(msgid), 'msgstr ""', '');
}
process.stdout.write(out.join('\n'));
