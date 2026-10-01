'use strict';

// Issue #162 : l'ordonnanceur écrit dans le journal commun de main.js
// (setLogger) et émet des traces détaillées en mode debug (_debug).

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const EventEmitter = require('events');

const { Scheduler } = require('../scheduler/index');

function create() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iao-sched-debug-'));
  const app = { getPath: () => tmpDir };
  const session = { fromPartition: () => ({ on() {} }) };
  const scheduler = new Scheduler(app, session);
  const lines = [];
  return { scheduler, lines, logFn: (...a) => lines.push(a), cleanup: () => fs.rmSync(tmpDir, { recursive: true, force: true }) };
}

function withConsole(fn) {
  const original = { log: console.log, error: console.error };
  const out = { log: [], error: [] };
  console.log = (...a) => out.log.push(a);
  console.error = (...a) => out.error.push(a);
  try { fn(); } finally { Object.assign(console, original); }
  return out;
}

function fakeDownload(filename) {
  const item = new EventEmitter();
  item.getFilename = () => filename;
  item.getURL = () => 'https://claude.ai/file';
  return item;
}

test('sans setLogger : journal d\'activité et erreurs sur la console, aucune trace debug', () => {
  const ctx = create();
  try {
    const out = withConsole(() => {
      ctx.scheduler._logActivity('message A');
      ctx.scheduler._error('échec écriture jobs :', new Error('EACCES'));
      ctx.scheduler._debug('invisible');
    });
    assert.deepStrictEqual(out.log, [['[scheduler]', 'message A']]);
    assert.strictEqual(out.error.length, 1);
    assert.strictEqual(out.error[0][0], '[scheduler] échec écriture jobs :');
    assert.strictEqual(out.error[0][1].message, 'EACCES');
  } finally { ctx.cleanup(); }
});

test('setLogger : activité (info) et erreurs (error) passent par le journal, plus par la console', () => {
  const ctx = create();
  try {
    ctx.scheduler.setLogger(ctx.logFn, false);
    const out = withConsole(() => {
      ctx.scheduler._logActivity('message B');
      ctx.scheduler._error('échec de la surveillance du profil', 'p1', new Error('boom'));
      ctx.scheduler._error('sans détail');
    });
    assert.deepStrictEqual(out, { log: [], error: [] });
    assert.deepStrictEqual(ctx.lines, [
      ['scheduler', 'info', 'message B'],
      ['scheduler', 'error', 'échec de la surveillance du profil p1 boom'],
      ['scheduler', 'error', 'sans détail']
    ]);
  } finally { ctx.cleanup(); }
});

test('_debug : actif seulement avec setLogger(..., true)', () => {
  const ctx = create();
  try {
    ctx.scheduler.setLogger(ctx.logFn, false);
    ctx.scheduler._debug('caché');
    ctx.scheduler.setLogger(ctx.logFn, true);
    ctx.scheduler._debug('visible');
    assert.deepStrictEqual(ctx.lines, [['scheduler', 'debug', 'visible']]);
    // Logger invalide : retour au repli console, debug coupé.
    ctx.scheduler.setLogger('pas une fonction', true);
    const out = withConsole(() => ctx.scheduler._debug('rien'));
    assert.deepStrictEqual(out, { log: [], error: [] });
  } finally { ctx.cleanup(); }
});

test('mode debug : téléchargements ignorés, aucun job éligible, lancement refusé', () => {
  const ctx = create();
  try {
    ctx.scheduler.setLogger(ctx.logFn, true);
    ctx.scheduler.config.enabled = false;
    ctx.scheduler._onWillDownload('p1', fakeDownload('a.zip'), {});
    ctx.scheduler.config.enabled = true;
    ctx.scheduler._onWillDownload('p1', fakeDownload('notes.pdf'), {});
    assert.strictEqual(ctx.scheduler.tryAutoLaunch(), null);
    const debugLines = ctx.lines.filter(l => l[1] === 'debug').map(l => l[2]);
    assert.deepStrictEqual(debugLines, [
      'téléchargement ignoré (ordonnanceur désactivé), profil p1',
      'téléchargement ignoré (pas un .zip) : notes.pdf',
      'auto-lancement : aucun job éligible'
    ]);
  } finally { ctx.cleanup(); }
});

test('mode debug : lancement manuel refusé tracé avec sa raison', () => {
  const ctx = create();
  try {
    ctx.scheduler.setLogger(ctx.logFn, true);
    ctx.scheduler.jobs.push({ id: 'J1', status: 'COMPLETED', profile: 'p1' });
    const res = ctx.scheduler.launchJob('J1');
    assert.strictEqual(res.ok, false);
    const last = ctx.lines[ctx.lines.length - 1];
    assert.strictEqual(last[1], 'debug');
    assert.strictEqual(last[2], 'lancement manuel refusé pour J1 : ' + res.reason);
  } finally { ctx.cleanup(); }
});
