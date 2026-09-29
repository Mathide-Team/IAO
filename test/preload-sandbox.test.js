'use strict';

// Issue #52 : preload.js est SANDBOXÉ (défaut Electron >= 20 avec
// nodeIntegration:false). Un require('path') y levait « module not found:
// path » : le preload ne s'exécutait pas, window.iaoAPI n'existait pas et
// l'interface restait entièrement vide (0 compte, 0 IA, aucune icône), sans
// qu'aucun test bloquant ne le voie. Ce filet exécute preload.js comme le
// ferait Electron en sandbox : require() limité aux modules autorisés.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { SANDBOXED_PRELOAD_MODULES, findUnsandboxedRequires } = require('../lib/startup-diagnostics');

const PRELOAD = path.join(__dirname, '..', 'preload.js');
const code = fs.readFileSync(PRELOAD, 'utf8');

function runPreloadSandboxed(pageUrl) {
  const exposed = {};
  const invoked = [];
  const electronStub = {
    contextBridge: { exposeInMainWorld: (key, api) => { exposed[key] = api; } },
    ipcRenderer: { invoke: (...args) => { invoked.push(args); return Promise.resolve('ok'); } }
  };
  const sandboxRequire = (name) => {
    if (!SANDBOXED_PRELOAD_MODULES.includes(name)) throw new Error('module not found: ' + name);
    if (name === 'electron') return electronStub;
    return require(name);
  };
  const context = vm.createContext({ require: sandboxRequire, window: { location: { href: pageUrl } }, URL });
  new vm.Script(code, { filename: PRELOAD }).runInContext(context);
  return { exposed, invoked };
}

test('preload.js ne require() que des modules disponibles dans un preload sandboxé', () => {
  assert.deepEqual(findUnsandboxedRequires(code), [],
    'preload.js charge un module interdit en sandbox : window.iaoAPI ne serait jamais défini');
});

test('preload.js s\'exécute en sandbox et expose window.iaoAPI (ipcInvoke + resolveMonacoBase)', async () => {
  const { exposed, invoked } = runPreloadSandboxed('file:///home/u/IAO/index.html');
  assert.ok(exposed.iaoAPI, 'window.iaoAPI non exposé');
  assert.equal(typeof exposed.iaoAPI.ipcInvoke, 'function');
  assert.equal(typeof exposed.iaoAPI.resolveMonacoBase, 'function');
  assert.equal(await exposed.iaoAPI.ipcInvoke('settings:load', 1), 'ok');
  assert.deepEqual(invoked, [['settings:load', 1]]);
});

test('resolveMonacoBase renvoie une URL file:// absolue (Linux, Windows, app packagée)', () => {
  const cases = [
    ['file:///home/u/IAO/index.html', 'file:///home/u/IAO/node_modules/monaco-editor/min/vs'],
    ['file:///C:/Program%20Files/IAO/resources/app.asar/index.html',
      'file:///C:/Program%20Files/IAO/resources/app.asar/node_modules/monaco-editor/min/vs']
  ];
  for (const [page, expected] of cases) {
    const { exposed } = runPreloadSandboxed(page);
    assert.equal(exposed.iaoAPI.resolveMonacoBase(), expected);
  }
});

test('resolveMonacoBase renvoie null si l\'URL de la page est illisible', () => {
  const { exposed } = runPreloadSandboxed('pas une url');
  assert.equal(exposed.iaoAPI.resolveMonacoBase(), null);
});

test('main.js déclare bien preload.js et garde nodeIntegration:false / contextIsolation:true', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(main, /preload:\s*path\.join\(__dirname,\s*'preload\.js'\)/);
  assert.match(main, /nodeIntegration:\s*false/);
  assert.match(main, /contextIsolation:\s*true/);
});
