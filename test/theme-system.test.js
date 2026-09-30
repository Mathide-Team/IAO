'use strict';

// Issue #139 : les couleurs de l'application suivent le thème du bureau.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const settings = require('../lib/settings.js');

const ROOT = path.join(__dirname, '..');

test('#139 : « system » est le thème par défaut et un thème valide', () => {
  assert.equal(settings.DEFAULT_SETTINGS.theme, 'system');
  assert.ok(settings.VALID_THEMES.includes('system'));
  assert.equal(settings.normalizeTheme('system'), 'system');
  assert.equal(settings.normalizeTheme('neon'), 'system');
});

test('#139 : resolveTheme — system suit la préférence du bureau', () => {
  assert.equal(settings.resolveTheme('system', true), 'dark');
  assert.equal(settings.resolveTheme('system', false), 'light');
  assert.equal(settings.resolveTheme('system', undefined), 'iao', 'préférence inconnue -> thème maison');
  assert.equal(settings.resolveTheme(undefined, false), 'light', 'thème absent -> défaut system');
});

test('#139 : resolveTheme — les thèmes explicites ignorent le bureau', () => {
  for (const t of ['iao', 'light', 'dark']) {
    assert.equal(settings.resolveTheme(t, true), t);
    assert.equal(settings.resolveTheme(t, false), t);
  }
});

test('#139 : buildApplySettingsPlan résout system et signale followsSystem', () => {
  assert.equal(settings.buildApplySettingsPlan({}, { prefersDark: false }).themeAttr, 'light');
  assert.equal(settings.buildApplySettingsPlan({}, { prefersDark: true }).themeAttr, 'dark');
  assert.equal(settings.buildApplySettingsPlan({}).themeAttr, 'iao');
  assert.equal(settings.buildApplySettingsPlan({}).followsSystem, true);
  const fixed = settings.buildApplySettingsPlan({ theme: 'light' }, { prefersDark: true });
  assert.equal(fixed.themeAttr, 'light');
  assert.equal(fixed.followsSystem, false);
});

test('#139 : câblage — option « Thème du bureau », matchMedia et écouteur change', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf-8');
  const app = fs.readFileSync(path.join(ROOT, 'assets', 'app.js'), 'utf-8');
  assert.match(html, /<option value="system">Thème du bureau \(défaut\)<\/option>/);
  assert.ok(app.includes("matchMedia('(prefers-color-scheme: dark)')"));
  assert.match(app, /systemThemeQuery\.addEventListener\('change'/);
  assert.match(app, /buildApplySettingsPlan\(settings, \{ prefersDark: systemPrefersDark\(\) \}\)/);
});
