'use strict';

// test/v8-coverage.test.js — calcul de couverture V8 (issue #100) :
// test-electron/v8-coverage.js, avec un `webContents.debugger` simulé.

const test = require('node:test');
const assert = require('node:assert');

const { startCoverage, takeCoverage, summarizeScriptCoverage, codeLineFlags } =
  require('../test-electron/v8-coverage');

// --- codeLineFlags -----------------------------------------------------------

test('codeLineFlags ignore lignes vides, commentaires et fermetures seules', () => {
  const src = [
    'const a = 1;',       // code
    '',                   // vide
    '// commentaire',     // commentaire
    '/* bloc',            // commentaire de bloc
    ' suite du bloc',     // commentaire de bloc
    ' */',                // fin de bloc
    'f(); /* fin */',     // code + commentaire
    '/* avant */ g();',   // commentaire + code
    '});',                // fermeture seule
    '}'                   // fermeture seule
  ].join('\n');
  assert.deepStrictEqual(codeLineFlags(src),
    [true, false, false, false, false, false, true, true, false, false]);
});

// --- summarizeScriptCoverage ---------------------------------------------------

test('summarizeScriptCoverage : lignes et fonctions exécutées / non exécutées', () => {
  const src = 'function used() {\n  return 1;\n}\nfunction unused() {\n  return 2;\n}\nused();\n';
  const at = (s) => src.indexOf(s);
  const entry = {
    url: 'file:///x/assets/app.js',
    functions: [
      { functionName: '', ranges: [{ startOffset: 0, endOffset: src.length, count: 1 }] },
      { functionName: 'used', ranges: [{ startOffset: at('function used'), endOffset: at('function unused'), count: 1 }] },
      // La plage interne (count 0) est déclarée AVANT la plage englobante : le tri la fait gagner.
      { functionName: 'unused', ranges: [
        { startOffset: at('function unused'), endOffset: at('used();'), count: 0 }
      ] }
    ]
  };
  const r = summarizeScriptCoverage(src, entry);
  assert.deepStrictEqual(r.lines.missed, [4, 5]);
  assert.strictEqual(r.lines.total, 5);
  assert.strictEqual(r.lines.covered, 3);
  assert.strictEqual(Math.round(r.lines.pct), 60);
  assert.deepStrictEqual(r.functions, { total: 3, called: 2, pct: (100 * 2) / 3 });
});

test('summarizeScriptCoverage : plage débordant du texte et texte sans code', () => {
  const r = summarizeScriptCoverage('// rien\n', {
    functions: [{ ranges: [{ startOffset: 0, endOffset: 9999, count: 1 }] }]
  });
  assert.strictEqual(r.lines.total, 0);
  assert.strictEqual(r.lines.pct, 100);
  const empty = summarizeScriptCoverage('', { functions: [] });
  assert.strictEqual(empty.functions.pct, 100);
});

test('summarizeScriptCoverage : les tabulations ne comptent pas comme code exécuté', () => {
  const src = 'a();\n\tb();\n';
  const r = summarizeScriptCoverage(src, {
    functions: [{ ranges: [
      { startOffset: 0, endOffset: src.length, count: 0 },
      { startOffset: 0, endOffset: 5, count: 1 }
    ] }]
  });
  assert.deepStrictEqual(r.lines.missed, [2]);
});

// --- startCoverage / takeCoverage ----------------------------------------------

function fakeWebContents(result, attached) {
  const calls = [];
  let isAttached = !!attached;
  return {
    calls,
    debugger: {
      isAttached: () => isAttached,
      attach: (v) => { isAttached = true; calls.push(['attach', v]); },
      sendCommand: async (method, params) => { calls.push([method, params]); return method === 'Profiler.takePreciseCoverage' ? { result } : {}; }
    }
  };
}

test('startCoverage attache le débogueur puis démarre la couverture précise', async () => {
  const wc = fakeWebContents([]);
  await startCoverage(wc);
  assert.deepStrictEqual(wc.calls, [
    ['attach', '1.3'],
    ['Profiler.enable', undefined],
    ['Profiler.startPreciseCoverage', { callCount: true, detailed: true }]
  ]);
});

test('startCoverage ne rattache pas un débogueur déjà attaché', async () => {
  const wc = fakeWebContents([], true);
  await startCoverage(wc);
  assert.ok(!wc.calls.some(c => c[0] === 'attach'));
});

test('takeCoverage résume le script ciblé, ou renvoie null s\'il est absent', async () => {
  const src = 'x();\n';
  const result = [
    { url: 'file:///autre.js', functions: [] },
    { functions: [] },
    { url: 'file:///app/assets/app.js', functions: [{ ranges: [{ startOffset: 0, endOffset: 5, count: 1 }] }] }
  ];
  const r = await takeCoverage(fakeWebContents(result), 'assets/app.js', src);
  assert.strictEqual(r.lines.covered, 1);
  assert.strictEqual(await takeCoverage(fakeWebContents([]), 'assets/app.js', src), null);
});
