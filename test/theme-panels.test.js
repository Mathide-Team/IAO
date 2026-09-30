'use strict';

// Suite de l'issue #139 : en thème clair, la barre latérale (.dashboard),
// l'en-tête (.workspace-header) et la barre d'onglets (.tabs-bar) gardaient
// un fond sombre codé en dur (rgba(11, 8, 23, …)). Sur ce fond, la carte du
// compte actif (fond violet à 5 %) affichait un nom sombre illisible. Ces
// fonds passent par --bg-panel / --bg-panel-soft, définies pour chaque thème.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const css = fs.readFileSync(path.join(__dirname, '..', 'assets', 'app.css'), 'utf-8');

function block(selector) {
  const i = css.indexOf(selector + ' {');
  assert.ok(i >= 0, 'bloc introuvable : ' + selector);
  return css.slice(i, css.indexOf('}', i));
}

function rule(selector) {
  const m = new RegExp('\\n\\s*' + selector.replace('.', '\\.') + '\\s*\\{([^}]*)\\}').exec(css);
  assert.ok(m, 'règle introuvable : ' + selector);
  return m[1];
}

test('#139 : chaque thème définit --bg-panel et --bg-panel-soft', () => {
  for (const sel of [':root', '[data-theme="dark"]', '[data-theme="light"]']) {
    const b = block(sel);
    assert.match(b, /--bg-panel:\s*rgba\(/, sel + ' : --bg-panel manquant');
    assert.match(b, /--bg-panel-soft:\s*rgba\(/, sel + ' : --bg-panel-soft manquant');
  }
  assert.match(block('[data-theme="light"]'), /--bg-panel:\s*rgba\(255, 255, 255,/, 'thème clair : panneau clair');
});

test('#139 : barre latérale, en-tête et onglets suivent le thème', () => {
  assert.match(rule('.dashboard'), /background:\s*var\(--bg-panel\)/);
  assert.match(rule('.workspace-header'), /background:\s*var\(--bg-panel\)/);
  assert.match(rule('.tabs-bar'), /background:\s*var\(--bg-panel-soft\)/);
});

test('#139 : plus aucun fond sombre IAO codé en dur hors des variables', () => {
  const lines = css.split('\n').filter(l => /rgba\(11,\s*8,\s*23/.test(l));
  assert.ok(lines.length > 0);
  for (const l of lines) assert.match(l, /^\s*--bg-panel(-soft)?:/, 'fond codé en dur : ' + l.trim());
});
