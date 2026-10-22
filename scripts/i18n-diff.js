#!/usr/bin/env node
// scripts/i18n-diff.js — chaînes ajoutées / supprimées entre deux .pot
// (issue #51). Sortie Markdown, pour le résumé du job i18n des PR.
//   node scripts/i18n-diff.js ANCIEN.pot NOUVEAU.pot
// Un ancien .pot absent (première PR) est traité comme vide.
'use strict';
const fs = require('fs');
const { comparer, resumeMarkdown } = require('../lib/i18n-pot-diff');

const [ancien, nouveau] = process.argv.slice(2);
const lire = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch (_) { return ''; } };
process.stdout.write(resumeMarkdown(comparer(lire(ancien), lire(nouveau))) + '\n');
