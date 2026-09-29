'use strict';
// ---------------------------------------------------------------------------
// test-electron/v8-coverage.js — mesure de la couverture V8 d'un script du
// renderer (issue #100), via le protocole CDP `Profiler.startPreciseCoverage`.
//
// Utilisé par ui-flows.js quand IAO_COVERAGE=1 (option de mesure, JAMAIS
// bloquante : voir CLAUDE.md, « Couverture de assets/app.js »).
//
// Le module n'importe pas `electron` : il reçoit un `webContents` (ou un
// double de test), ce qui permet de tester la partie calcul avec `node --test`
// (test/v8-coverage.test.js).
// ---------------------------------------------------------------------------

// Démarre la couverture précise. À appeler AVANT le chargement de la page
// mesurée (sinon le code exécuté au démarrage n'est pas compté).
async function startCoverage(webContents) {
  const dbg = webContents.debugger;
  if (!dbg.isAttached()) dbg.attach('1.3');
  await dbg.sendCommand('Profiler.enable');
  await dbg.sendCommand('Profiler.startPreciseCoverage', { callCount: true, detailed: true });
}

// Lignes « de code » : ni vides, ni commentaire seul, ni accolade fermante
// seule. Heuristique volontairement simple (pas de vrai parseur JS).
function codeLineFlags(text) {
  const flags = [];
  let inBlock = false;
  for (const raw of text.split('\n')) {
    let s = raw;
    let rest = '';
    while (s.length > 0) {
      if (inBlock) {
        const end = s.indexOf('*/');
        if (end === -1) { s = ''; } else { inBlock = false; s = s.slice(end + 2); }
      } else {
        const start = s.indexOf('/*');
        if (start === -1) { rest += s; s = ''; } else { rest += s.slice(0, start); inBlock = true; s = s.slice(start + 2); }
      }
    }
    const t = rest.trim();
    flags.push(t !== '' && !t.startsWith('//') && !/^[})\];,]+$/.test(t));
  }
  return flags;
}

// Calcule la couverture d'un script à partir de son entrée CDP
// (`{ url, functions: [{ ranges: [{ startOffset, endOffset, count }] }] }`).
// Une ligne est « exécutée » si au moins un de ses caractères non blancs est
// dans une plage dont le compteur est > 0 (la plage la plus interne gagne).
function summarizeScriptCoverage(text, entry) {
  const counts = new Int32Array(text.length).fill(-1);
  const ranges = [];
  let fnTotal = 0;
  let fnCalled = 0;
  for (const fn of entry.functions) {
    fnTotal += 1;
    if (fn.ranges[0].count > 0) fnCalled += 1;
    for (const r of fn.ranges) ranges.push(r);
  }
  ranges.sort((a, b) => (a.startOffset - b.startOffset) || (b.endOffset - a.endOffset));
  for (const r of ranges) counts.fill(r.count, r.startOffset, Math.min(r.endOffset, text.length));

  const flags = codeLineFlags(text);
  const lines = text.split('\n');
  const missed = [];
  let total = 0;
  let covered = 0;
  let offset = 0;
  lines.forEach((line, i) => {
    const start = offset;
    offset += line.length + 1;
    if (!flags[i]) return;
    total += 1;
    let executed = false;
    for (let k = 0; k < line.length && !executed; k++) {
      if (line[k] !== ' ' && line[k] !== '\t' && counts[start + k] > 0) executed = true;
    }
    if (executed) covered += 1; else missed.push(i + 1);
  });
  return {
    lines: { total, covered, pct: total === 0 ? 100 : (100 * covered) / total, missed },
    functions: { total: fnTotal, called: fnCalled, pct: fnTotal === 0 ? 100 : (100 * fnCalled) / fnTotal }
  };
}

// Récupère la couverture courante et résume le script dont l'URL se termine
// par `urlSuffix`. Renvoie null si le script n'a pas été chargé.
async function takeCoverage(webContents, urlSuffix, text) {
  const cov = await webContents.debugger.sendCommand('Profiler.takePreciseCoverage');
  const entry = cov.result.find(r => typeof r.url === 'string' && r.url.endsWith(urlSuffix));
  return entry ? summarizeScriptCoverage(text, entry) : null;
}

module.exports = { startCoverage, takeCoverage, summarizeScriptCoverage, codeLineFlags };
