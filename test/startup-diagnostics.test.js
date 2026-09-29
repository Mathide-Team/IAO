'use strict';

// Issue #52 : fonctions pures de diagnostic du démarrage (lib/startup-diagnostics.js),
// plus garde-fous statiques sur leur branchement (index.html, main.js, app.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const d = require('../lib/startup-diagnostics');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

test('findUnsandboxedRequires repère les modules interdits en preload sandboxé', () => {
  const code = "const { a } = require('electron');\nconst p = require(\"path\");\nrequire('node:fs'); require('url'); require('path');";
  assert.deepEqual(d.findUnsandboxedRequires(code), ['path', 'fs']);
  assert.deepEqual(d.findUnsandboxedRequires("require('events'); require('timers')"), []);
  assert.deepEqual(d.findUnsandboxedRequires(null), []);
  // Un commentaire qui cite require('path') n'est pas un appel.
  assert.deepEqual(d.findUnsandboxedRequires("// require('path')\n/* require('fs') */\nrequire('electron'); // ok"), []);
  // Une URL dans une chaîne ne doit pas être prise pour un commentaire.
  assert.deepEqual(d.findUnsandboxedRequires("const u = 'http://x'; require('os');"), ['os']);
});

test('errorText gère Error, chaîne, objet, null et borne la longueur', () => {
  assert.equal(d.errorText(new TypeError('boum')), 'TypeError: boum');
  assert.equal(d.errorText(new Error('simple')), 'simple');
  assert.equal(d.errorText('texte'), 'texte');
  assert.equal(d.errorText({ code: 1 }), '{"code":1}');
  assert.equal(d.errorText(null), 'erreur inconnue');
  assert.equal(d.errorText('   '), 'erreur inconnue');
  const long = d.errorText('x'.repeat(900));
  assert.equal(long.length, 500);
  assert.ok(long.endsWith('…'));
  const circ = {}; circ.self = circ;
  assert.equal(typeof d.errorText(circ), 'string');
});

test('describeStartupProblem donne titre, détail et piste selon le type', () => {
  const p = d.describeStartupProblem('preload', 'absent');
  assert.match(p.title, /preload/);
  assert.equal(p.detail, 'absent');
  assert.match(p.hint, /npm start/);
  assert.match(p.hint, /pas perdus/);
  const e = d.describeStartupProblem('error', new Error('x'), 'assets/app.js:82');
  assert.equal(e.detail, 'x (assets/app.js:82)');
  assert.match(e.hint, /logs\/iao\.log/);
  assert.match(d.describeStartupProblem('rejection', 'r').title, /asynchrone/);
});

test('consoleLevelName accepte les niveaux Electron (chaîne) et historiques (entier)', () => {
  assert.equal(d.consoleLevelName('error'), 'error');
  assert.equal(d.consoleLevelName('warn'), 'warning');
  assert.equal(d.consoleLevelName(0), 'debug');
  assert.equal(d.consoleLevelName(2), 'warning');
  assert.equal(d.consoleLevelName(3), 'error');
  assert.equal(d.consoleLevelName(99), 'info');
});

test('shouldForwardConsole : warnings/erreurs toujours, le reste en mode debug', () => {
  assert.equal(d.shouldForwardConsole('error', false), true);
  assert.equal(d.shouldForwardConsole('warning', false), true);
  assert.equal(d.shouldForwardConsole('info', false), false);
  assert.equal(d.shouldForwardConsole('info', true), true);
  assert.equal(d.shouldForwardConsole(1, false), false);
});

test('shortSource et formatLogLine produisent des lignes lisibles', () => {
  assert.equal(d.shortSource('file:///home/u/IAO/assets/app.js'), 'assets/app.js');
  assert.equal(d.shortSource('C:\\IAO\\lib\\x.js'), 'lib/x.js');
  assert.equal(d.shortSource(''), '');
  const date = new Date('2026-09-29T15:00:00.000Z');
  assert.equal(d.formatLogLine(date, 'renderer', 3, 'boum \n', 'file:///a/assets/app.js', 82),
    '2026-09-29T15:00:00.000Z [renderer] error boum (assets/app.js:82)');
  assert.equal(d.formatLogLine(date.getTime(), 'demarrage', 'info', 'ok'),
    '2026-09-29T15:00:00.000Z [demarrage] info ok');
  assert.equal(d.formatLogLine(date, 'x', 'info', null, 'a.js'), '2026-09-29T15:00:00.000Z [x] info  (a.js)');
});

test('isDebugEnabled : --debug ou IAO_DEBUG', () => {
  assert.equal(d.isDebugEnabled(['electron', '.', '--debug'], {}), true);
  assert.equal(d.isDebugEnabled([], { IAO_DEBUG: '1' }), true);
  assert.equal(d.isDebugEnabled([], { IAO_DEBUG: 'oui' }), true);
  assert.equal(d.isDebugEnabled([], { IAO_DEBUG: '0' }), false);
  assert.equal(d.isDebugEnabled(undefined, undefined), false);
});

test('index.html charge la garde de démarrage avant tout script applicatif', () => {
  const html = read('index.html');
  const srcs = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map(m => m[1]);
  const guard = srcs.indexOf('assets/boot-guard.js');
  const diagIdx = srcs.indexOf('lib/startup-diagnostics.js');
  assert.ok(guard > 0 && diagIdx >= 0, 'boot-guard.js ou startup-diagnostics.js absent : ' + srcs.join(', '));
  assert.ok(diagIdx < guard, 'startup-diagnostics.js doit précéder boot-guard.js');
  assert.equal(srcs[0], 'assets/icons.js', 'icons.js doit rester en tête (icône du bandeau)');
  assert.ok(guard < srcs.indexOf('assets/app.js'), 'boot-guard.js doit précéder app.js');
  assert.ok(guard < srcs.indexOf('lib/escape-html.js'), 'boot-guard.js doit précéder les autres lib/');
});

test('boot-guard.js n\'injecte aucun HTML (textContent uniquement) et capte erreurs + rejets', () => {
  const js = read('assets/boot-guard.js');
  assert.ok(!/innerHTML/.test(js), 'boot-guard.js ne doit pas utiliser innerHTML');
  assert.match(js, /addEventListener\('error'/);
  assert.match(js, /addEventListener\('unhandledrejection'/);
  assert.match(js, /window\.__iaoReportStartupProblem\s*=/);
  assert.match(js, /data-icon', 'triangle-exclamation'/);
});

test('app.js signale un preload absent au lieu de planter sur window.iaoAPI.ipcInvoke', () => {
  const js = read('assets/app.js');
  const guard = js.indexOf("__iaoReportStartupProblem('preload'");
  const use = js.indexOf('const ipcRenderer = { invoke: window.iaoAPI.ipcInvoke }');
  assert.ok(guard > 0 && use > guard, 'garde preload absente ou placée après le premier usage de window.iaoAPI');
});

test('main.js : instance unique + journalisation preload/renderer', () => {
  const main = read('main.js');
  assert.match(main, /requestSingleInstanceLock\(\)/);
  assert.match(main, /'second-instance'/);
  for (const ev of ['preload-error', 'render-process-gone', 'did-fail-load', 'console-message']) {
    assert.ok(main.includes("wc.on('" + ev + "'"), 'événement non journalisé : ' + ev);
  }
  assert.ok(!/console-message', \(event, /.test(main), 'handler console-message positionnel (déprécié)');
});
