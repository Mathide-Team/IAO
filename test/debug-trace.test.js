'use strict';

// Issue #162 : lib/debug-trace.js (logique pure du mode debug).

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  traceIpcMain,
  describeRuntime,
  shouldForwardGuestConsole,
  isErrorResult
} = require('../lib/debug-trace');

function fakeIpcMain() {
  const handlers = new Map();
  return {
    handlers,
    handle(channel, fn) { handlers.set(channel, fn); return 'handle:' + channel; },
    on(channel) { return 'on:' + channel; }
  };
}

function clock(...ticks) {
  let i = 0;
  return () => ticks[Math.min(i++, ticks.length - 1)];
}

test('traceIpcMain : hors mode debug, renvoie ipcMain tel quel', () => {
  const ipc = fakeIpcMain();
  assert.equal(traceIpcMain(ipc, { enabled: false, log() {} }), ipc);
  assert.equal(traceIpcMain(ipc), ipc);
});

test('traceIpcMain : appel réussi tracé avec durée et nombre d\'arguments, jamais leur valeur', async () => {
  const ipc = fakeIpcMain();
  const lines = [];
  const traced = traceIpcMain(ipc, { enabled: true, log: (...a) => lines.push(a), now: clock(100, 112) });
  assert.equal(traced.handle('read-file', async (_e, p) => 'contenu de ' + p), 'handle:read-file');
  const result = await ipc.handlers.get('read-file')({}, '/home/secret.txt');
  assert.equal(result, 'contenu de /home/secret.txt');
  assert.deepEqual(lines, [['ipc', 'debug', 'read-file → ok (12 ms, 1 argument(s))']]);
});

test('traceIpcMain : réponse { error } (convention de l\'ordonnanceur) tracée comme erreur', async () => {
  const ipc = fakeIpcMain();
  const lines = [];
  traceIpcMain(ipc, { enabled: true, log: (...a) => lines.push(a), now: clock(0, 3) })
    .handle('scheduler:launch-job', () => ({ error: 'job introuvable' }));
  assert.deepEqual(await ipc.handlers.get('scheduler:launch-job')({}, 'J1', 'x'), { error: 'job introuvable' });
  assert.deepEqual(lines, [['ipc', 'debug', 'scheduler:launch-job → erreur : job introuvable (3 ms, 2 argument(s))']]);
});

test('traceIpcMain : exception tracée puis relancée (comportement IPC inchangé)', async () => {
  const ipc = fakeIpcMain();
  const lines = [];
  traceIpcMain(ipc, { enabled: true, log: (...a) => lines.push(a), now: clock(5, 5) })
    .handle('save-file', () => { throw new Error('disque plein'); });
  await assert.rejects(ipc.handlers.get('save-file')({}), /disque plein/);
  assert.deepEqual(lines, [['ipc', 'debug', 'save-file → exception : disque plein (0 ms, 0 argument(s))']]);
});

test('traceIpcMain : exception sans message (valeur levée brute)', async () => {
  const ipc = fakeIpcMain();
  const lines = [];
  traceIpcMain(ipc, { enabled: true, log: (...a) => lines.push(a), now: clock(0, 0) })
    .handle('a', () => { throw 'brut'; }); // eslint-disable-line no-throw-literal
  traceIpcMain(ipc, { enabled: true, log: (...a) => lines.push(a), now: clock(0, 0) })
    .handle('b', () => { throw new Error(''); });
  await assert.rejects(ipc.handlers.get('a')({}));
  await assert.rejects(ipc.handlers.get('b')({}));
  assert.equal(lines[0][2], 'a → exception : brut (0 ms, 0 argument(s))');
  assert.equal(lines[1][2], 'b → exception : Error (0 ms, 0 argument(s))');
});

test('traceIpcMain : horloge par défaut (Date.now) et autres méthodes d\'ipcMain conservées', async () => {
  const ipc = fakeIpcMain();
  const lines = [];
  const traced = traceIpcMain(ipc, { enabled: true, log: (...a) => lines.push(a) });
  assert.equal(traced.on('x'), 'on:x');
  traced.handle('ping', () => 'pong');
  assert.equal(await ipc.handlers.get('ping')({}), 'pong');
  assert.match(lines[0][2], /^ping → ok \(\d+ ms, 0 argument\(s\)\)$/);
});

test('isErrorResult : seul un objet avec un champ error non vide est une erreur', () => {
  assert.equal(isErrorResult({ error: 'x' }), true);
  assert.equal(isErrorResult({ error: '' }), false);
  assert.equal(isErrorResult({ ok: true }), false);
  assert.equal(isErrorResult('error'), false);
  assert.equal(isErrorResult(null), false);
  assert.equal(isErrorResult(undefined), false);
});

test('describeRuntime : versions et options de lancement (sans le chemin de l\'exécutable)', () => {
  const text = describeRuntime({
    versions: { electron: '43.1.1', chrome: '140.0', node: '22.1.0', v8: '14.0' },
    argv: ['/opt/IAO/iao', '--iao-debug', '--no-sandbox']
  });
  assert.equal(text, 'mode debug actif — Electron 43.1.1, Chrome 140.0, Node 22.1.0, V8 14.0 ; options : --iao-debug --no-sandbox');
});

test('describeRuntime : valeurs absentes remplacées par « ? » et « (aucune) »', () => {
  assert.equal(describeRuntime({ argv: ['/opt/IAO/iao'] }),
    'mode debug actif — Electron ?, Chrome ?, Node ?, V8 ? ; options : (aucune)');
  assert.equal(describeRuntime(), 'mode debug actif — Electron ?, Chrome ?, Node ?, V8 ? ; options : (aucune)');
});

test('shouldForwardGuestConsole : avertissements et erreurs seulement (numérique ou texte)', () => {
  for (const level of [2, 3, 'warning', 'warn', 'error']) assert.equal(shouldForwardGuestConsole(level), true, String(level));
  for (const level of [0, 1, 'debug', 'info', 'log', undefined]) assert.equal(shouldForwardGuestConsole(level), false, String(level));
});
