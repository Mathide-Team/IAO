'use strict';

// test/claude-adapter-window.test.js — Couvre le garde d'export de
// lib/claude-adapter.js : chargement navigateur (window), Node (module.exports)
// et environnement sans window ni module. Issue #77 (tâche 55.8).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const filePath = path.join(__dirname, '..', 'lib', 'claude-adapter.js');
const code = fs.readFileSync(filePath, 'utf8');

const EXPORTED = [
  'CLAUDE_SELECTORS', 'detectQuotaMessage', 'buildClaudeDetectionScript',
  'buildPromptInjectionScript', 'buildFileUploadScript', 'parseClaudeResponse',
  'buildResponseCollectionScript', 'randomDetectionDelayMs', 'computeQuotaWaitMs',
  'buildPopupDismissScript', 'buildContinueActionScript',
  'buildDownloadActionScript', 'buildNewChatActionScript', 'planClaudeAutomationStep'
];

function run(sandbox) {
  vm.createContext(sandbox);
  new vm.Script(code, { filename: filePath }).runInContext(sandbox);
  return sandbox;
}

test('chargement navigateur : tout est exposé sur window', () => {
  const { window } = run({ window: {} });
  for (const name of EXPORTED) {
    assert.ok(window[name] !== undefined, 'window.' + name + ' manquant');
  }
  assert.strictEqual(typeof window.detectQuotaMessage, 'function');
  assert.ok(Array.isArray(window.CLAUDE_SELECTORS.chatInput));
});

test('window prioritaire sur module quand les deux existent', () => {
  const module = { exports: {} };
  const { window } = run({ window: {}, module });
  assert.ok(window.parseClaudeResponse);
  assert.deepStrictEqual(Object.keys(module.exports), []);
});

test('chargement CommonJS sans window : exporte via module.exports', () => {
  const module = { exports: {} };
  run({ module });
  for (const name of EXPORTED) {
    assert.ok(module.exports[name] !== undefined, 'module.exports.' + name + ' manquant');
  }
});

test('ni window ni module : le chargement ne lève pas', () => {
  assert.doesNotThrow(() => run({}));
});

// --- Branches résiduelles de lib/claude-adapter.js ---------------------------

const claude = require('../lib/claude-adapter');

test('computeQuotaWaitMs : date « now » invalide -> 0 (waitMs NaN)', () => {
  assert.strictEqual(claude.computeQuotaWaitMs('13:40', new Date(NaN)), 0);
});

test('parseClaudeResponse : HTML sans texte exploitable -> null', () => {
  assert.strictEqual(claude.parseClaudeResponse('<p></p>'), null);
  assert.strictEqual(claude.parseClaudeResponse('<div> <br> </div>'), null);
});

test('planClaudeAutomationStep : appel sans options -> none', () => {
  const detection = {
    quotaMessage: { detected: false, time: null },
    popups: { count: 0 }
  };
  const result = claude.planClaudeAutomationStep(detection);
  assert.strictEqual(result.action, 'none');
  assert.strictEqual(result.reason, 'no_action_requested');
});
