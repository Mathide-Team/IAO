'use strict';

// Issue #136 : le bouton « Épuiser (24h) » est retiré des cartes de compte.
// Garde statique : ni le libellé, ni l'action, ni le CSS ne doivent revenir,
// et le tick d'expiration des cooldowns existants reste en place.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf-8');

test('#136 : plus de bouton « Épuiser (24h) » ni d\'action toggle-cooldown', () => {
  const app = read('assets/app.js');
  const html = read('index.html');
  for (const src of [app, html]) {
    assert.ok(!src.includes('Épuiser'), 'libellé « Épuiser » encore présent');
    assert.ok(!src.includes('toggle-cooldown'), 'action toggle-cooldown encore présente');
    assert.ok(!src.includes('cooldown-btn'), 'classe cooldown-btn encore présente');
  }
  assert.ok(!/toggleCooldown|formatCooldown|refreshCooldownLabels/.test(app));
});

test('#136 : CSS .cooldown-btn supprimé, estompage du service conservé', () => {
  const css = read('assets/app.css');
  assert.ok(!css.includes('.cooldown-btn'));
  assert.ok(css.includes('.svc-btn.cooldown-active'));
});

test('#136 : les cooldowns déjà enregistrés expirent toujours (tick conservé)', () => {
  const app = read('assets/app.js');
  assert.match(app, /if \(cd <= now\) \{ acc\.cooldowns\[svc\.id\] = 0; needsRender = true; \}/);
  assert.match(app, /cooldown-active/);
});
