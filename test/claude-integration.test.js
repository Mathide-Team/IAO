'use strict';

// test/claude-integration.test.js — Tests d'integration des selecteurs Claude
// et des nouvelles fonctions (lot 18/09/2026).

const test = require('node:test');
const assert = require('node:assert');
const claude = require('../lib/claude-adapter');

// --- Mini DOM shim ---------------------------------------------------------
function createMockElement(tagName, attrs) {
  var children = [];
  var el = {
    tagName: tagName.toUpperCase(),
    attributes: {},
    textContent: '',
    innerText: '',
    dataset: {},
    _children: children,
    getAttribute: function(name) { return this.attributes[name] || null; },
    setAttribute: function(name, val) { this.attributes[name] = val; },
    hasAttribute: function(name) { return name in this.attributes; },
    appendChild: function(child) { children.push(child); child._parent = this; return child; },
    click: function() {},
    addEventListener: function() {},
    dispatchEvent: function() { return true; },
    focus: function() {}
  };
  if (attrs) {
    for (var k in attrs) {
      el.attributes[k] = attrs[k];
      if (k === 'data-testid') el.dataset.testid = attrs[k];
      if (k === 'data-is-streaming') el.dataset.isStreaming = attrs[k];
    }
  }
  return el;
}

function createMockDocument(tree) {
  function buildNode(spec) {
    var el = createMockElement(spec.tag, spec.attrs);
    el.textContent = spec.text || '';
    el.innerText = spec.text || '';
    if (spec.children) {
      for (var i = 0; i < spec.children.length; i++) {
        var child = buildNode(spec.children[i]);
        child._parent = el;
        el._children.push(child);
      }
    }
    return el;
  }
  var root = buildNode(tree);
  var body = createMockElement('body', {});
  body._children.push(root);
  root._parent = body;
  return {
    body: body,
    querySelector: function(sel) { return _querySelector(body, sel); },
    querySelectorAll: function(sel) { return _querySelectorAll(body, sel); }
  };
}

function _matchesAttribute(el, attrSel) {
  var eqIdx = attrSel.indexOf('=');
  if (eqIdx === -1) {
    return attrSel.trim() in el.attributes;
  }
  var attrName = attrSel.substring(0, eqIdx).trim();
  if (attrName.endsWith('*')) {
    var realName = attrName.slice(0, -1).trim();
    var val = el.attributes[realName] || '';
    var expected = attrSel.substring(eqIdx + 1).replace(/^"/, '').replace(/"$/, '').replace(/^'/, '').replace(/'$/, '');
    return val.indexOf(expected) !== -1;
  }
  var attrVal = attrSel.substring(eqIdx + 1).replace(/^"/, '').replace(/"$/, '').replace(/^'/, '').replace(/'$/, '');
  return el.attributes[attrName] === attrVal;
}

function _matchSingle(el, selector) {
  var remaining = selector.trim();
  if (!remaining) return true;

  // :has() pseudo-class
  var hasIdx = remaining.indexOf(':has(');
  if (hasIdx !== -1) {
    var hasEnd = remaining.indexOf(')', hasIdx);
    var innerSel = remaining.substring(hasIdx + 5, hasEnd);
    remaining = remaining.substring(0, hasIdx) + remaining.substring(hasEnd + 1);
    var hasChild = _querySelectorAll(el, innerSel);
    if (hasChild.length === 0) return false;
  }

  // Tag name
  var tagMatch = remaining.match(/^([a-z][a-z0-9-]*)/i);
  var tag = tagMatch ? tagMatch[1].toLowerCase() : null;
  if (tag && el.tagName.toLowerCase() !== tag) return false;
  if (tag) remaining = remaining.substring(tagMatch[0].length);

  // .class
  while (remaining.indexOf('.') !== -1) {
    var dotIdx = remaining.indexOf('.');
    var afterDot = remaining.substring(dotIdx + 1);
    var cm = afterDot.match(/^([a-zA-Z0-9_-]+)/);
    if (!cm) break;
    var classes = (el.attributes['class'] || '').split(/\s+/);
    if (classes.indexOf(cm[1]) === -1) return false;
    remaining = remaining.substring(0, dotIdx) + afterDot.substring(cm[1].length);
  }

  // #id
  while (remaining.indexOf('#') !== -1) {
    var hashIdx = remaining.indexOf('#');
    var afterHash = remaining.substring(hashIdx + 1);
    var im = afterHash.match(/^([a-zA-Z0-9_-]+)/);
    if (!im) break;
    if (el.attributes['id'] !== im[1]) return false;
    remaining = remaining.substring(0, hashIdx) + afterHash.substring(im[1].length);
  }

  // [attr], [attr="val"], [attr*="val"]
  while (remaining.indexOf('[') !== -1) {
    var openIdx = remaining.indexOf('[');
    var closeIdx = remaining.indexOf(']', openIdx);
    if (closeIdx === -1) break;
    var attrContent = remaining.substring(openIdx + 1, closeIdx);
    if (!_matchesAttribute(el, attrContent)) return false;
    remaining = remaining.substring(0, openIdx) + remaining.substring(closeIdx + 1);
  }

  return remaining.trim() === '';
}

function _matchesSelector(el, selector) {
  if (!el || !el.tagName) return false;
  var parts = selector.split(',').map(function(s) { return s.trim(); });
  for (var p = 0; p < parts.length; p++) {
    if (_matchSingle(el, parts[p])) return true;
  }
  return false;
}

function _querySelectorAll(root, selector) {
  var results = [];
  function walk(el) {
    if (!el || !el.tagName) return;
    if (_matchesSelector(el, selector)) results.push(el);
    if (el._children) {
      for (var i = 0; i < el._children.length; i++) walk(el._children[i]);
    }
  }
  walk(root);
  return results;
}

function _querySelector(root, selector) {
  var all = _querySelectorAll(root, selector);
  return all.length > 0 ? all[0] : null;
}

// Helper: collect all innerText from a tree
function collectText(el) {
  var text = el.innerText || '';
  if (el._children) {
    for (var i = 0; i < el._children.length; i++) {
      text += collectText(el._children[i]);
    }
  }
  return text;
}

// === TESTS : randomDetectionDelayMs ========================================

test('randomDetectionDelayMs renvoie une valeur entre 30000 et 300000', () => {
  for (var i = 0; i < 1000; i++) {
    var delay = claude.randomDetectionDelayMs();
    assert.ok(delay >= 30000, 'delay >= 30000, got: ' + delay);
    assert.ok(delay <= 300000, 'delay <= 300000, got: ' + delay);
  }
});

test('randomDetectionDelayMs accepte un injecteur de randomness', () => {
  var minDelay = claude.randomDetectionDelayMs(function() { return 0; });
  assert.ok(minDelay >= 30000 && minDelay <= 30001);
  var maxDelay = claude.randomDetectionDelayMs(function() { return 0.999; });
  assert.ok(maxDelay >= 299000);
});

test('randomDetectionDelayMs utilise Math.random par defaut', () => {
  assert.ok(typeof claude.randomDetectionDelayMs() === 'number');
});

// === TESTS : computeQuotaWaitMs ============================================

test('computeQuotaWaitMs calcule attente pour heure future', () => {
  var now = new Date('2026-09-18T13:00:00');
  var wait = claude.computeQuotaWaitMs('13:40', now);
  assert.ok(wait > 0);
  assert.ok(Math.abs(wait - 2460000) < 2000, 'expected ~2460000, got: ' + wait);
});

test('computeQuotaWaitMs gere le format 12h AM/PM', () => {
  var now = new Date('2026-09-18T13:00:00');
  var wait = claude.computeQuotaWaitMs('10:10 PM', now);
  assert.ok(wait > 0);
  // 22:10 - 13:00 = 9h10 = 33000s + 60s marge = 33060s = 33060000ms
  assert.ok(Math.abs(wait - 33060000) < 2000, 'expected ~33060000, got: ' + wait);
});

test('computeQuotaWaitMs suppose jour suivant si heure passee', () => {
  var now = new Date('2026-09-18T14:00:00');
  var wait = claude.computeQuotaWaitMs('13:40', now);
  assert.ok(wait > 0);
  assert.ok(wait > 80000000, 'should be ~23h: ' + wait);
});

test('computeQuotaWaitMs renvoie 0 pour heure invalide', () => {
  assert.strictEqual(claude.computeQuotaWaitMs('invalid'), 0);
  assert.strictEqual(claude.computeQuotaWaitMs(''), 0);
  assert.strictEqual(claude.computeQuotaWaitMs(null), 0);
  assert.strictEqual(claude.computeQuotaWaitMs('25:99'), 0);
});

// === TESTS : buildPopupDismissScript ======================================

test('buildPopupDismissScript genere un script valide', () => {
  var script = claude.buildPopupDismissScript();
  assert.ok(typeof script === 'string');
  assert.ok(script.startsWith('(function'));
  assert.ok(script.indexOf('dialog') !== -1);
  assert.ok(script.indexOf('dismissed') !== -1);
});

test('buildPopupDismissScript inclut boutons FR et EN', () => {
  var script = claude.buildPopupDismissScript();
  assert.ok(script.indexOf('close') !== -1);
  assert.ok(script.indexOf('Fermer') !== -1);
  assert.ok(script.indexOf('dismiss') !== -1);
});

// === TESTS : buildContinueActionScript ====================================

test('buildContinueActionScript genere un script valide', () => {
  var script = claude.buildContinueActionScript();
  assert.ok(typeof script === 'string');
  assert.ok(script.startsWith('(function'));
  assert.ok(script.indexOf('continueButton') !== -1);
  assert.ok(script.indexOf('continue_button') !== -1);
});

// === TESTS : buildDownloadActionScript ====================================

test('buildDownloadActionScript genere un script valide', () => {
  var script = claude.buildDownloadActionScript();
  assert.ok(typeof script === 'string');
  assert.ok(script.startsWith('(function'));
  assert.ok(script.indexOf('downloadButton') !== -1);
  assert.ok(script.indexOf('download_button') !== -1);
});

// === TESTS : buildNewChatActionScript =====================================

test('buildNewChatActionScript genere un script valide', () => {
  var script = claude.buildNewChatActionScript();
  assert.ok(typeof script === 'string');
  assert.ok(script.startsWith('(function'));
  assert.ok(script.indexOf('newChatButton') !== -1);
  assert.ok(script.indexOf('new_chat_button') !== -1);
});

// === TESTS : selecteurs combines assistantMessages =========================

test('assistantMessages inclut le selecteur combine', () => {
  var selectors = claude.CLAUDE_SELECTORS.assistantMessages;
  assert.ok(selectors.some(function(s) { return s.indexOf('data-testid') !== -1 && s.indexOf('data-is-streaming') !== -1; }));
});

test('assistantMessages priorise le selecteur combine', () => {
  var selectors = claude.CLAUDE_SELECTORS.assistantMessages;
  assert.ok(selectors[0].indexOf('data-testid') !== -1 && selectors[0].indexOf('data-is-streaming') !== -1);
});

// === TESTS INTEGRATION : selecteurs contre DOM simule =====================

test('Integration : detection chatInput ProseMirror', () => {
  var doc = createMockDocument({
    tag: 'div',
    attrs: { 'contenteditable': 'true', 'class': 'ProseMirror', 'role': 'textbox' },
    text: 'Zone de chat'
  });
  var found = _querySelector(doc.body, 'div[contenteditable="true"].ProseMirror');
  assert.ok(found);
  assert.strictEqual(found.tagName, 'DIV');
});

test('Integration : detection bouton Send data-testid', () => {
  var doc = createMockDocument({
    tag: 'div', attrs: {},
    children: [{ tag: 'button', attrs: { 'data-testid': 'send-button' }, text: 'Send' }]
  });
  var found = _querySelector(doc.body, 'button[data-testid="send-button"]');
  assert.ok(found);
  assert.strictEqual(found.tagName, 'BUTTON');
});

test('Integration : detection bouton Send aria-label', () => {
  var doc = createMockDocument({
    tag: 'div', attrs: {},
    children: [{ tag: 'button', attrs: { 'aria-label': 'Send Message' }, text: 'Send' }]
  });
  var found = _querySelector(doc.body, 'button[aria-label="Send Message"]');
  assert.ok(found);
});

test('Integration : detection messages assistant combines', () => {
  var doc = createMockDocument({
    tag: 'div', attrs: {},
    children: [{ tag: 'div', attrs: { 'data-testid': 'assistant-message', 'data-is-streaming': 'false' }, text: 'Reponse de Claude' }]
  });
  var found = _querySelectorAll(doc.body, 'div[data-testid="assistant-message"][data-is-streaming]');
  assert.strictEqual(found.length, 1);
  assert.ok(found[0].textContent.indexOf('Reponse') !== -1);
});

test('Integration : detection nouveau chat a[href="/new"]', () => {
  var doc = createMockDocument({
    tag: 'div', attrs: {},
    children: [{ tag: 'a', attrs: { 'href': '/new' }, text: 'Nouvelle conversation' }]
  });
  var found = _querySelector(doc.body, 'a[href="/new"]');
  assert.ok(found);
});

test('Integration : detection bouton Telecharger', () => {
  var doc = createMockDocument({
    tag: 'div', attrs: {},
    children: [{ tag: 'button', attrs: { 'aria-label': 'T\u00e9l\u00e9charger' }, text: 'Download' }]
  });
  var found = _querySelector(doc.body, 'button[aria-label="T\u00e9l\u00e9charger"]');
  assert.ok(found);
});

test('Integration : detection bouton Continuer', () => {
  var doc = createMockDocument({
    tag: 'div', attrs: {},
    children: [{ tag: 'button', attrs: { 'aria-label': 'Continuer' }, text: 'Continue' }]
  });
  var found = _querySelector(doc.body, 'button[aria-label="Continuer"]');
  assert.ok(found);
});

test('Integration : detection input file', () => {
  var doc = createMockDocument({
    tag: 'div', attrs: {},
    children: [{ tag: 'input', attrs: { 'type': 'file' }, text: '' }]
  });
  var found = _querySelector(doc.body, 'input[type="file"]');
  assert.ok(found);
});

test('Integration : detection message quota dans body', () => {
  var doc = createMockDocument({
    tag: 'div', attrs: {},
    children: [{ tag: 'p', attrs: {}, text: 'Vous n\u2019avez plus de messages gratuits jusqu\u2019\u00e0 13:40. Revenez plus tard.' }]
  });
  var bodyText = collectText(doc.body);
  var result = claude.detectQuotaMessage(bodyText);
  assert.ok(result.detected, 'quota message should be detected');
  assert.strictEqual(result.time, '13:40');
});

test('Integration : detection popups dialog', () => {
  var doc = createMockDocument({
    tag: 'div', attrs: {},
    children: [{ tag: 'div', attrs: { 'role': 'dialog' }, text: 'Popup' }]
  });
  var popups = _querySelectorAll(doc.body, 'div[role="dialog"]');
  assert.strictEqual(popups.length, 1);
});

test('Integration : priorite selecteur combine', () => {
  var doc = createMockDocument({
    tag: 'div', attrs: {},
    children: [
      { tag: 'div', attrs: { 'data-is-streaming': 'true' }, text: 'Streaming seul' },
      { tag: 'div', attrs: { 'data-testid': 'assistant-message', 'data-is-streaming': 'false' }, text: 'Assistant complet' }
    ]
  });
  var combined = _querySelectorAll(doc.body, 'div[data-testid="assistant-message"][data-is-streaming]');
  assert.strictEqual(combined.length, 1);
  assert.ok(combined[0].textContent.indexOf('Assistant complet') !== -1);
});

test('Integration : buildClaudeDetectionScript embarque tous selecteurs', () => {
  var script = claude.buildClaudeDetectionScript();
  assert.ok(script.indexOf('continueButton') !== -1);
  assert.ok(script.indexOf('downloadButton') !== -1);
  assert.ok(script.indexOf('newChatButton') !== -1);
  assert.ok(script.indexOf('chatInput') !== -1);
  assert.ok(script.indexOf('fileUpload') !== -1);
  assert.ok(script.indexOf('sendButton') !== -1);
  assert.ok(script.indexOf('assistantMessages') !== -1);
});

test('Integration : script detection gere selecteurs invalides', () => {
  var script = claude.buildClaudeDetectionScript();
  assert.ok(script.indexOf('catch') !== -1);
});

// === TESTS : fixture realiste Claude.ai ====================================

test('Integration : fixture realiste Claude.ai detecte tous elements', () => {
  var doc = createMockDocument({
    tag: 'div', attrs: { 'id': 'root' },
    children: [
      { tag: 'nav', attrs: {}, children: [
        { tag: 'a', attrs: { 'href': '/new' }, text: 'Nouvelle conversation' }
      ]},
      { tag: 'main', attrs: {}, children: [
        { tag: 'div', attrs: { 'data-testid': 'assistant-message', 'data-is-streaming': 'false' }, children: [
          { tag: 'div', attrs: { 'class': 'font-claude-response' }, text: 'Voici ma reponse.' }
        ]},
        { tag: 'div', attrs: { 'contenteditable': 'true', 'class': 'ProseMirror', 'role': 'textbox' }, text: '' },
        { tag: 'button', attrs: { 'data-testid': 'send-button', 'aria-label': 'Send Message' }, text: '' },
        { tag: 'input', attrs: { 'type': 'file', 'accept': '.txt,.pdf,.docx' }, text: '' }
      ]}
    ]
  });

  assert.ok(_querySelector(doc.body, 'div[contenteditable="true"].ProseMirror'), 'chatInput');
  assert.ok(_querySelector(doc.body, 'button[data-testid="send-button"]'), 'sendButton');
  assert.ok(_querySelector(doc.body, 'a[href="/new"]'), 'newChat');
  var assistantMsg = _querySelectorAll(doc.body, 'div[data-testid="assistant-message"][data-is-streaming]');
  assert.strictEqual(assistantMsg.length, 1, 'assistantMessage');
  assert.ok(_querySelector(doc.body, 'input[type="file"]'), 'fileInput');
  assert.ok(_querySelector(doc.body, '.font-claude-response'), 'fontClaude');
});

// === TESTS : exports du module =============================================

test('Module exporte toutes les nouvelles fonctions', () => {
  assert.strictEqual(typeof claude.randomDetectionDelayMs, 'function');
  assert.strictEqual(typeof claude.computeQuotaWaitMs, 'function');
  assert.strictEqual(typeof claude.buildPopupDismissScript, 'function');
  assert.strictEqual(typeof claude.buildContinueActionScript, 'function');
  assert.strictEqual(typeof claude.buildDownloadActionScript, 'function');
  assert.strictEqual(typeof claude.buildNewChatActionScript, 'function');
});

// === TESTS : execution du script de detection dans un mock VM =================

// Test critique : execute le script genere par buildClaudeDetectionScript()
// dans un contexte mocke avec un faux document.body.innerText contenant le
// message de quota exact, puis verifie que quotaMessage.detected === true.
// Ce test aurait attrape la regex divergente entre detectQuotaMessage() et
// buildClaudeDetectionScript().

test('Script de detection detecte le quota avec \u00e0 avant l\'heure', () => {
  var vm = require('vm');
  var script = claude.buildClaudeDetectionScript();

  // Mock document avec body.innerText contenant le message exact
  var mockBodyText = 'Vous n\u2019avez plus de messages gratuits jusqu\u2019\u00e0 13:40. Revenez plus tard.';
  var mockDoc = {
    querySelectorAll: function() { return []; },
    body: { innerText: mockBodyText }
  };
  var sandbox = { document: mockDoc, JSON: JSON };
  sandbox.window = sandbox;
  var context = vm.createContext(sandbox);
  var result = vm.runInContext(script, context);
  var parsed = JSON.parse(result);

  assert.ok(parsed.quotaMessage, 'quotaMessage doit etre present');
  assert.ok(parsed.quotaMessage.detected, 'Le quota doit etre detecte avec \u00e0 avant l\'heure');
  assert.strictEqual(parsed.quotaMessage.time, '13:40', 'L\'heure doit etre 13:40');
});

test('Script de detection detecte le quota sans \u00e0', () => {
  var vm = require('vm');
  var script = claude.buildClaudeDetectionScript();

  var mockBodyText = 'Vous n\u2019avez plus de messages gratuits jusqu\u2019 22:10. Revenez plus tard.';
  var mockDoc = {
    querySelectorAll: function() { return []; },
    body: { innerText: mockBodyText }
  };
  var sandbox = { document: mockDoc, JSON: JSON };
  sandbox.window = sandbox;
  var context = vm.createContext(sandbox);
  var result = vm.runInContext(script, context);
  var parsed = JSON.parse(result);

  assert.ok(parsed.quotaMessage.detected, 'Le quota doit etre detecte sans \u00e0');
  assert.ok(parsed.quotaMessage.time.indexOf('22:10') !== -1, 'L\'heure doit etre 22:10');
});

test('Script de detection detecte le quota en anglais', () => {
  var vm = require('vm');
  var script = claude.buildClaudeDetectionScript();

  var mockBodyText = "You've run out of free messages until 10:10 PM. Try again later.";
  var mockDoc = {
    querySelectorAll: function() { return []; },
    body: { innerText: mockBodyText }
  };
  var sandbox = { document: mockDoc, JSON: JSON };
  sandbox.window = sandbox;
  var context = vm.createContext(sandbox);
  var result = vm.runInContext(script, context);
  var parsed = JSON.parse(result);

  assert.ok(parsed.quotaMessage.detected, 'Le quota EN doit etre detecte');
});

test('Script de detection ne detecte pas faux quota', () => {
  var vm = require('vm');
  var script = claude.buildClaudeDetectionScript();

  var mockDoc = {
    querySelectorAll: function() { return []; },
    body: { innerText: 'Bonjour, comment ca va ?' }
  };
  var sandbox = { document: mockDoc, JSON: JSON };
  sandbox.window = sandbox;
  var context = vm.createContext(sandbox);
  var result = vm.runInContext(script, context);
  var parsed = JSON.parse(result);

  assert.ok(!parsed.quotaMessage.detected, 'Pas de quota pour un texte normal');
});

test('Script de detection compte les popups', () => {
  var vm = require('vm');
  var script = claude.buildClaudeDetectionScript();

  var mockDoc = {
    querySelectorAll: function(sel) {
      if (sel.indexOf('dialog') !== -1) return [{}, {}]; // 2 popups
      return [];
    },
    body: { innerText: '' }
  };
  var sandbox = { document: mockDoc, JSON: JSON };
  sandbox.window = sandbox;
  var context = vm.createContext(sandbox);
  var result = vm.runInContext(script, context);
  var parsed = JSON.parse(result);

  assert.strictEqual(parsed.popups.count, 2, '2 popups doivent etre detectees');
});

// Test de la fonction d'orchestration : planClaudeAutomationStep
// Exécute les scripts générés dans un contexte vm réel (pas juste un .includes())
// et vérifie que le clic est bien déclenché sur l'élément attendu.

test('planClaudeAutomationStep : refuse une détection non-objet ni JSON', () => {
  var result = claude.planClaudeAutomationStep(null, {});
  assert.strictEqual(result.action, 'blocked');
  assert.strictEqual(result.reason, 'invalid_detection_input');

  var result2 = claude.planClaudeAutomationStep(42, {});
  assert.strictEqual(result2.action, 'blocked');
});

test('planClaudeAutomationStep : refuse un JSON invalide', () => {
  var result = claude.planClaudeAutomationStep('not json', {});
  assert.strictEqual(result.action, 'blocked');
  assert.strictEqual(result.reason, 'invalid_detection_json');
});

test('planClaudeAutomationStep : priorité quota avant toute action', () => {
  var detection = {
    quotaMessage: { detected: true, time: '13:40' },
    popups: { count: 0 },
    continueButton: { found: true, count: 1 },
    downloadButton: { found: true, count: 1 },
    newChatButton: { found: true, count: 1 },
    fileUpload: { found: true, count: 1 },
    chatInput: { found: true, count: 1 }
  };
  var result = claude.planClaudeAutomationStep(detection, { requestedAction: 'continue' });
  assert.strictEqual(result.action, 'wait_quota');
  assert.strictEqual(result.reason, 'quota_detected');
  assert.ok(result.waitMs > 0, 'doit calculer un temps d attente > 0');
});

test('planClaudeAutomationStep : détection popup avant action', () => {
  var detection = {
    quotaMessage: { detected: false, time: null },
    popups: { count: 2 },
    continueButton: { found: true, count: 1 }
  };
  var result = claude.planClaudeAutomationStep(detection, { requestedAction: 'continue' });
  assert.strictEqual(result.action, 'dismiss_popups');
  assert.strictEqual(result.popupCount, 2);
  assert.ok(result.script, 'doit fournir un script de fermeture');
});

test('planClaudeAutomationStep : aucune action demandée -> none', () => {
  var detection = {
    quotaMessage: { detected: false, time: null },
    popups: { count: 0 }
  };
  var result = claude.planClaudeAutomationStep(detection, {});
  assert.strictEqual(result.action, 'none');
  assert.strictEqual(result.reason, 'no_action_requested');
});

test('planClaudeAutomationStep : blocked quand action demandée non disponible', () => {
  var detection = {
    quotaMessage: { detected: false, time: null },
    popups: { count: 0 },
    continueButton: { found: false, count: 0 }
  };
  var result = claude.planClaudeAutomationStep(detection, { requestedAction: 'continue' });
  assert.strictEqual(result.action, 'blocked');
  assert.strictEqual(result.reason, 'element_not_found');
});

test('planClaudeAutomationStep : continue disponible retourne script avec délai', () => {
  var detection = {
    quotaMessage: { detected: false, time: null },
    popups: { count: 0 },
    continueButton: { found: true, count: 1 }
  };
  var result = claude.planClaudeAutomationStep(detection, { requestedAction: 'continue' });
  assert.strictEqual(result.action, 'continue');
  assert.strictEqual(result.reason, 'action_available');
  assert.ok(result.delayMs >= 30000 && result.delayMs <= 300000, 'délai dans [30s, 300s]');
  assert.ok(result.script, 'doit fournir un script');
});

test('planClaudeAutomationStep : download disponible retourne script avec délai', () => {
  var detection = {
    quotaMessage: { detected: false, time: null },
    popups: { count: 0 },
    downloadButton: { found: true, count: 1 }
  };
  var result = claude.planClaudeAutomationStep(detection, { requestedAction: 'download' });
  assert.strictEqual(result.action, 'download');
  assert.ok(result.delayMs >= 30000, 'délai >= 30s');
  assert.ok(result.script);
});

test('planClaudeAutomationStep : new_chat disponible retourne script', () => {
  var detection = {
    quotaMessage: { detected: false, time: null },
    popups: { count: 0 },
    newChatButton: { found: true, count: 1 }
  };
  var result = claude.planClaudeAutomationStep(detection, { requestedAction: 'new_chat' });
  assert.strictEqual(result.action, 'new_chat');
  assert.ok(result.delayMs >= 30000);
  assert.ok(result.script);
});

test('planClaudeAutomationStep : upload_file disponible localise l input', () => {
  var detection = {
    quotaMessage: { detected: false, time: null },
    popups: { count: 0 },
    fileUpload: { found: true, count: 1 }
  };
  var result = claude.planClaudeAutomationStep(detection, { requestedAction: 'upload_file' });
  assert.strictEqual(result.action, 'upload_file');
  assert.ok(result.delayMs >= 30000);
  assert.ok(result.script);
});

test('planClaudeAutomationStep : send_prompt exige un prompt non vide', () => {
  var detection = {
    quotaMessage: { detected: false, time: null },
    popups: { count: 0 },
    chatInput: { found: true, count: 1 }
  };
  var result = claude.planClaudeAutomationStep(detection, { requestedAction: 'send_prompt' });
  assert.strictEqual(result.action, 'blocked');
  assert.strictEqual(result.reason, 'missing_prompt');

  var result2 = claude.planClaudeAutomationStep(detection, {
    requestedAction: 'send_prompt',
    prompt: 'genere un code'
  });
  assert.strictEqual(result2.action, 'send_prompt');
  assert.ok(result2.script);
});

test('planClaudeAutomationStep : action inconnue -> blocked', () => {
  var detection = {
    quotaMessage: { detected: false, time: null },
    popups: { count: 0 }
  };
  var result = claude.planClaudeAutomationStep(detection, { requestedAction: 'no_such_thing' });
  assert.strictEqual(result.action, 'blocked');
  assert.strictEqual(result.reason, 'unknown_requested_action');
});

// === TESTS vm : exécution réelle des scripts via le planificateur ========

test('planClaudeAutomationStep : continue déclenche bien un clic sur le bouton Continuer', () => {
  var vm = require('vm');
  var detection = {
    quotaMessage: { detected: false, time: null },
    popups: { count: 0 },
    continueButton: { found: true, count: 1, selector: 'button[aria-label="Continue"]' }
  };
  var plan = claude.planClaudeAutomationStep(detection, {
    requestedAction: 'continue',
    rng: function() { return 0; }
  });
  assert.strictEqual(plan.delayMs, 30000, 'délai fixe à 30s avec rng=0');

  var clicked = false;
  var sandbox = {
    document: {
      querySelector: function() { return { click: function() { clicked = true; } }; }
    },
    JSON: JSON
  };
  sandbox.window = sandbox;
  var context = vm.createContext(sandbox);
  vm.runInContext(plan.script, context);
  assert.ok(clicked, 'le bouton Continuer doit avoir été cliqué');
});

test('planClaudeAutomationStep : download déclenche bien un clic sur le bouton Télécharger', () => {
  var vm = require('vm');
  var detection = {
    quotaMessage: { detected: false, time: null },
    popups: { count: 0 },
    downloadButton: { found: true, count: 1 }
  };
  var plan = claude.planClaudeAutomationStep(detection, {
    requestedAction: 'download',
    rng: function() { return 0; }
  });

  var clicked = false;
  var sandbox = {
    document: {
      querySelector: function() { return { click: function() { clicked = true; } }; }
    },
    JSON: JSON
  };
  sandbox.window = sandbox;
  var context = vm.createContext(sandbox);
  vm.runInContext(plan.script, context);
  assert.ok(clicked, 'le bouton Télécharger doit avoir été cliqué');
});

test('planClaudeAutomationStep : new_chat déclenche bien un clic sur le lien /new', () => {
  var vm = require('vm');
  var detection = {
    quotaMessage: { detected: false, time: null },
    popups: { count: 0 },
    newChatButton: { found: true, count: 1 }
  };
  var plan = claude.planClaudeAutomationStep(detection, {
    requestedAction: 'new_chat',
    rng: function() { return 0; }
  });

  var clicked = false;
  var sandbox = {
    document: {
      querySelector: function() { return { click: function() { clicked = true; } }; }
    },
    JSON: JSON
  };
  sandbox.window = sandbox;
  var context = vm.createContext(sandbox);
  vm.runInContext(plan.script, context);
  assert.ok(clicked, 'le bouton Nouveau chat doit avoir été cliqué');
});

test('planClaudeAutomationStep : upload_file pose bien l attribut data-iao-upload-target', () => {
  var vm = require('vm');
  var detection = {
    quotaMessage: { detected: false, time: null },
    popups: { count: 0 },
    fileUpload: { found: true, count: 1 }
  };
  var plan = claude.planClaudeAutomationStep(detection, {
    requestedAction: 'upload_file',
    rng: function() { return 0; }
  });

  var setAttrCalled = false;
  var setAttrValue = '';
  var mockInput = {
    tagName: 'INPUT',
    type: 'file',
    accept: '.txt,.pdf',
    setAttribute: function(name, value) { setAttrCalled = true; setAttrValue = value; },
    getAttribute: function() { return null; }
  };
  var sandbox = {
    document: {
      querySelector: function() { return mockInput; }
    },
    JSON: JSON
  };
  sandbox.window = sandbox;
  var context = vm.createContext(sandbox);
  var resultStr = vm.runInContext(plan.script, context);
  var parsed = JSON.parse(resultStr);
  assert.ok(parsed.ok, 'le script doit réussir');
  assert.ok(setAttrCalled, 'setAttribute doit avoir été appelé');
  assert.strictEqual(setAttrValue, 'true', 'la valeur doit être "true"');
});

test('planClaudeAutomationStep : send_prompt injecte le texte et déclenche l envoi', () => {
  var vm = require('vm');
  var detection = {
    quotaMessage: { detected: false, time: null },
    popups: { count: 0 },
    chatInput: { found: true, count: 1 }
  };
  var plan = claude.planClaudeAutomationStep(detection, {
    requestedAction: 'send_prompt',
    prompt: 'genere un script python',
    rng: function() { return 0; }
  });

  var injectedText = '';
  var sendClicked = false;
  var mockChatInput = {
    tagName: 'DIV',
    focus: function() {},
    set textContent(v) { injectedText = v; },
    get textContent() { return injectedText; },
    dispatchEvent: function() {}
  };
  var mockSendBtn = { click: function() { sendClicked = true; } };
  var sandbox = {
    document: {
      querySelector: function(sel) {
        if (sel.indexOf('contenteditable') !== -1) return mockChatInput;
        if (sel.indexOf('send-button') !== -1 || sel.indexOf('Send') !== -1) return mockSendBtn;
        return null;
      }
    },
    JSON: JSON,
    InputEvent: function() {},
    Event: function() {},
    KeyboardEvent: function() {}
  };
  sandbox.window = sandbox;
  var context = vm.createContext(sandbox);
  var resultStr = vm.runInContext(plan.script, context);
  var parsed = JSON.parse(resultStr);
  assert.ok(parsed.ok, 'le script doit réussir');
  assert.strictEqual(injectedText, 'genere un script python', 'le prompt doit être injecté');
  assert.ok(sendClicked, 'le bouton d envoi doit avoir été cliqué');
});

// === TESTS vm : vérifications avancées sur les scripts générés ============

test('planClaudeAutomationStep : dismiss_popups ne clique QUE sur boutons close explicites', () => {
  var vm = require('vm');
  var detection = {
    quotaMessage: { detected: false, time: null },
    popups: { count: 1 }
  };
  var plan = claude.planClaudeAutomationStep(detection, {});

  var clickedLabels = [];
  function makeBtn(label) {
    return {
      click: function() { clickedLabels.push(label); },
      getAttribute: function() { return label; }
    };
  }
  var sandbox = {
    document: {
      querySelectorAll: function(sel) {
        if (sel.indexOf('dialog') !== -1 || sel.indexOf('modal') !== -1 || sel.indexOf('popup') !== -1) {
          return [{
            querySelectorAll: function(innerSel) {
              // Retourne un faux bouton close ET un faux bouton "Confirmer" (qui ne doit PAS être cliqué)
              if (innerSel.indexOf('close') !== -1 || innerSel.indexOf('dismiss') !== -1 || innerSel.indexOf('Fermer') !== -1) {
                return [makeBtn('close')];
              }
              return [];
            }
          }];
        }
        return [];
      }
    },
    JSON: JSON
  };
  sandbox.window = sandbox;
  var context = vm.createContext(sandbox);
  var resultStr = vm.runInContext(plan.script, context);
  var parsed = JSON.parse(resultStr);
  assert.ok(parsed.ok);
  assert.strictEqual(parsed.dismissed, 1, 'un seul bouton close doit être cliqué');
});

test('planClaudeAutomationStep : continue renvoie une erreur propre si le bouton est absent', () => {
  var vm = require('vm');
  var detection = {
    quotaMessage: { detected: false, time: null },
    popups: { count: 0 },
    continueButton: { found: true, count: 1 }
  };
  var plan = claude.planClaudeAutomationStep(detection, {
    requestedAction: 'continue',
    rng: function() { return 0; }
  });

  var sandbox = {
    document: {
      querySelector: function() { return null; }
    },
    JSON: JSON
  };
  sandbox.window = sandbox;
  var context = vm.createContext(sandbox);
  var resultStr = vm.runInContext(plan.script, context);
  var parsed = JSON.parse(resultStr);
  assert.ok(!parsed.ok, 'doit échouer proprement');
  assert.strictEqual(parsed.error, 'continue_button_not_found');
});

// === TESTS : planification avec horodatage contrôlé pour quota ============

test('planClaudeAutomationStep : quota avec now contrôlé calcule le bon waitMs', () => {
  var detection = {
    quotaMessage: { detected: true, time: '14:00' },
    popups: { count: 0 }
  };
  // now = 13:00, cible = 14:00 + 60s marge = 14:01, soit 61 minutes = 3660000 ms
  var now = new Date('2026-09-18T13:00:00');
  var result = claude.planClaudeAutomationStep(detection, { now: now });
  assert.strictEqual(result.action, 'wait_quota');
  assert.strictEqual(result.waitMs, 3660000);
});

test('planClaudeAutomationStep : priorité quota même si popup aussi présente', () => {
  var detection = {
    quotaMessage: { detected: true, time: '15:30' },
    popups: { count: 3 }
  };
  var result = claude.planClaudeAutomationStep(detection, { requestedAction: 'download' });
  assert.strictEqual(result.action, 'wait_quota', 'le quota doit primer sur les popups et l action demandée');
});


// === TESTS : restauration onglets (Electron) ===============================

test('Structure : tab-actions.js fournit la gestion des onglets', () => {
  var fs = require('fs');
  var path = require('path');
  var libDir = path.join(__dirname, '..', 'lib');
  assert.ok(fs.existsSync(libDir));
  assert.ok(fs.existsSync(path.join(libDir, 'tab-actions.js')));
  var tabActions = require('../lib/tab-actions');
  assert.strictEqual(typeof tabActions.tabsForAccount, 'function');
  assert.strictEqual(typeof tabActions.buildDisconnectWarning, 'function');
});

test('Structure : popup-guard fournit la politique decidePopup', () => {
  var popupGuard = require('../lib/popup-guard');
  assert.strictEqual(typeof popupGuard.decidePopup, 'function');
  // Issue #277 : toute popup web https est acceptée (y compris origines
  // inconnues comme context7) ; les schémas non web sont refusés.
  assert.ok(popupGuard.decidePopup('https://claude.ai/chat') === 'allow');
  assert.ok(popupGuard.decidePopup('https://context7.com/login') === 'allow');
  assert.ok(popupGuard.decidePopup('data:text/html,x') === 'deny');
  assert.ok(popupGuard.decidePopup('javascript:alert(1)') === 'deny');
});
