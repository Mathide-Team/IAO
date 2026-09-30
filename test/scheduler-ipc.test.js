'use strict';

// test/scheduler-ipc.test.js — Tests de registerSchedulerIPC (scheduler/index.js).
// ipcMain et Scheduler sont simulés : aucun Electron réel, aucun réseau.
// Issue #92 (tâche 55.23).

const test = require('node:test');
const assert = require('node:assert');

const { registerSchedulerIPC } = require('../scheduler/index');

// canal -> [méthode du scheduler appelée, arguments passés par le renderer]
const CHANNELS = {
  'scheduler:get-state': ['getState', []],
  'scheduler:sync-accounts': ['syncAccounts', [[{ id: 'a1' }]]],
  'scheduler:set-enabled': ['setEnabled', [true]],
  'scheduler:set-config': ['setConfig', [{ maxParallel: 2 }]],
  'scheduler:pick-downloads-dir': ['pickDownloadsDir', []],
  'scheduler:pick-delivery-dir': ['pickDeliveryDir', []],
  'scheduler:continue-project': ['continueProject', ['job1']],
  'scheduler:mark-delivered': ['markDelivered', ['job1']],
  'scheduler:pause-job': ['pauseJob', ['job1']],
  'scheduler:resume-job': ['resumeJob', ['job1']],
  'scheduler:retry-job': ['retryJob', ['job1']],
  'scheduler:open-zip': ['openZip', ['job1']],
  'scheduler:analyze-completeness': ['analyzeCompleteness', ['job1']],
  'scheduler:launch-job': ['launchJob', ['job1']],
  'scheduler:try-auto-launch': ['tryAutoLaunch', []],
  'scheduler:create-project': ['createProject', ['Projet', ['a1']]],
  'scheduler:update-project': ['updateProject', ['p1', { name: 'X' }]],
  'scheduler:delete-project': ['deleteProject', ['p1']],
  'scheduler:create-task': ['createTask', ['p1', 'prompt', '/tmp/src.zip']],
  'scheduler:assign-task': ['assignTask', ['p1', 't1', 'a1', ['a1', 'a2']]],
  'scheduler:get-assignable-accounts': ['getAssignableAccountsForProject', ['p1', ['a1']]],
  'scheduler:diagnose-claude': ['diagnoseClaudePage', ['profil_1']],
  'scheduler:run-claude-job': ['runClaudeJob', ['profil_1', 'prompt', '/tmp/src.zip']],
  'scheduler:collect-claude-response': ['collectClaudeResponse', ['profil_1']],
  'scheduler:execute-task': ['executeTask', ['p1', 't1']]
};

// Méthodes du scheduler qui ne sont pas de simples délégations à valeur brute.
const METHODS = [...new Set(Object.values(CHANNELS).map((c) => c[0]))];

function setup(behavior) {
  const handlers = new Map();
  const ipcMain = { handle: (channel, fn) => handlers.set(channel, fn) };
  const calls = [];
  const scheduler = {};
  for (const m of METHODS) {
    scheduler[m] = (...args) => {
      calls.push({ method: m, args });
      return behavior ? behavior(m, args) : 'res:' + m;
    };
  }
  const win = { fake: 'BrowserWindow' };
  registerSchedulerIPC(ipcMain, scheduler, () => win);
  return { handlers, calls, scheduler, win };
}

const EVENT = { sender: 'fake-event' };

test('enregistre tous les canaux scheduler:* (et le placeholder register-webview)', () => {
  const { handlers } = setup();
  const expected = Object.keys(CHANNELS).concat('scheduler:register-webview').sort();
  assert.deepStrictEqual([...handlers.keys()].sort(), expected);
});

for (const [channel, [method, args]] of Object.entries(CHANNELS)) {
  test(channel + ' -> scheduler.' + method + '()', async () => {
    const { handlers, calls, win } = setup();
    const result = await handlers.get(channel)(EVENT, ...args);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].method, method);
    if (method === 'pickDownloadsDir' || method === 'pickDeliveryDir') {
      assert.deepStrictEqual(calls[0].args, [win], 'la fenêtre courante doit être transmise');
    } else {
      assert.deepStrictEqual(calls[0].args, args, "l'événement IPC ne doit pas être transmis");
    }
    // sync-accounts renvoie true, les autres renvoient la valeur du scheduler
    assert.strictEqual(result, method === 'syncAccounts' ? true : 'res:' + method);
  });

  test(channel + ' : une erreur du scheduler devient { error }', async () => {
    const { handlers } = setup(() => { throw new Error('boom ' + method); });
    const result = await handlers.get(channel)(EVENT, ...args);
    assert.deepStrictEqual(result, { error: 'boom ' + method });
  });
}

test('erreur asynchrone (promesse rejetée) -> { error }', async () => {
  const { handlers } = setup(() => Promise.reject(new Error('rejet async')));
  assert.deepStrictEqual(await handlers.get('scheduler:get-state')(EVENT), { error: 'rejet async' });
});

test('erreur sans message -> String(e) ; valeur levée non-Error -> String(valeur)', async () => {
  const noMsg = setup(() => { throw new Error(''); });
  assert.deepStrictEqual(await noMsg.handlers.get('scheduler:get-state')(EVENT), { error: 'Error' });

  const str = setup(() => { throw 'chaine brute'; }); // eslint-disable-line no-throw-literal
  assert.deepStrictEqual(await str.handlers.get('scheduler:get-state')(EVENT), { error: 'chaine brute' });
});

test('scheduler:register-webview : placeholder qui renvoie true sans appeler le scheduler', async () => {
  const { handlers, calls } = setup();
  assert.strictEqual(await handlers.get('scheduler:register-webview')(EVENT, 'profil_1', 42), true);
  assert.strictEqual(calls.length, 0);
});

test('getWin est évalué à chaque appel (fenêtre courante)', async () => {
  const handlers = new Map();
  const seen = [];
  const scheduler = { pickDownloadsDir: (w) => { seen.push(w); return 'ok'; }, pickDeliveryDir: () => 'ok' };
  let current = { id: 1 };
  registerSchedulerIPC({ handle: (c, f) => handlers.set(c, f) }, scheduler, () => current);
  await handlers.get('scheduler:pick-downloads-dir')(EVENT);
  current = { id: 2 };
  await handlers.get('scheduler:pick-downloads-dir')(EVENT);
  assert.deepStrictEqual(seen, [{ id: 1 }, { id: 2 }]);
});
