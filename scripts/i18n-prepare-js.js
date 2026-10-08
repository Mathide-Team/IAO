#!/usr/bin/env node
// scripts/i18n-prepare-js.js — copie des sources JavaScript pour xgettext
// (issue #51). Le texte des gabarits `...` y est remplacé par des espaces
// (lib/i18n.js, blankTemplateText) : xgettext < 0.20, celui d'Ubuntu 20.04
// sur les runners maison, perd sinon des libellés après une apostrophe de
// gabarit. Lignes et colonnes conservées : les références du .pot ne changent
// pas.
//   node scripts/i18n-prepare-js.js DOSSIER_SORTIE fichier.js...
'use strict';
const fs = require('fs');
const path = require('path');
const { blankTemplateText } = require('../lib/i18n');

const [outDir, ...files] = process.argv.slice(2);
for (const file of files) {
  const target = path.join(outDir, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, blankTemplateText(fs.readFileSync(file, 'utf8')));
}
