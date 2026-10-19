'use strict';

// Minuterie des tâches programmables côté renderer (issue #199, lot 3).

const test = require('node:test');
const assert = require('node:assert/strict');

const r = require('../lib/taches-runner.js');

const PLAN = {
  tache: 'tache-1', fournisseur: 'claude', url: 'https://claude.ai/new', prompt: 'p',
  etapes: [{ profil: 'a', delaiMs: 0 }, { profil: 'b', delaiMs: 30000 }, { profil: 'c', delaiMs: 30000 }]
};

function deps(reponses, options) {
  const o = options || {};
  const appels = [];
  const attentes = [];
  const file = reponses.slice();
  return {
    appels, attentes,
    comptes: () => [{ profile: 'a', services: ['claude'] }],
    ouvrirOnglet: (profil, f, url) => { appels.push(['ouvrir', profil, f, url]); return o.ouvrir !== false; },
    attendre: async (ms) => { attentes.push(ms); },
    invoke: async (canal, ...args) => {
      appels.push([canal, ...args]);
      if (canal === 'scheduler:run-claude-job') {
        const x = file.length ? file.shift() : { ok: true };
        if (x instanceof Error || typeof x === 'string') throw x;
        return x;
      }
      if (canal === 'taches:dues') return o.dues;
      return true;
    }
  };
}

test('executerPlan : ordre, délais relatifs, ouverture puis envoi puis compte rendu', async () => {
  const d = deps([]);
  await r.executerPlan(PLAN, d);
  assert.deepEqual(d.attentes, [30000]);
  assert.deepEqual(d.appels.slice(0, 3), [
    ['ouvrir', 'a', 'claude', 'https://claude.ai/new'],
    ['scheduler:run-claude-job', 'a', 'p', null],
    ['taches:report', 'tache-1', 'a', { ok: true }]
  ]);
  assert.equal(d.appels.filter(a => a[0] === 'taches:report').length, 3);
});

test('executerEtape : page pas prête -> nouvelles tentatives, puis succès', async () => {
  const d = deps([{ error: 'Aucune webview ouverte pour le profil « a ».' }, { error: 'element_not_found' }, { ok: true }]);
  await r.executerEtape(PLAN, PLAN.etapes[0], d);
  assert.deepEqual(d.attentes, [r.PAUSE_TENTATIVE_MS, r.PAUSE_TENTATIVE_MS]);
  assert.deepEqual(d.appels.at(-1), ['taches:report', 'tache-1', 'a', { ok: true }]);
});

test('executerEtape : abandon après TENTATIVES ; autre erreur sans nouvelle tentative', async () => {
  const jamais = Array(r.TENTATIVES + 2).fill({ error: 'element_not_found' });
  const d = deps(jamais);
  await r.executerEtape(PLAN, PLAN.etapes[0], d);
  assert.equal(d.appels.filter(a => a[0] === 'scheduler:run-claude-job').length, r.TENTATIVES);
  const q = deps([{ error: 'quota_exhausted' }]);
  await r.executerEtape(PLAN, PLAN.etapes[0], q);
  assert.equal(q.appels.filter(a => a[0] === 'scheduler:run-claude-job').length, 1);
  const vide = deps([null]);
  await r.executerEtape(PLAN, PLAN.etapes[0], vide);
  assert.deepEqual(vide.appels.at(-1), ['taches:report', 'tache-1', 'a', null]);
});

test('executerEtape : exception de l\'envoi convertie en erreur', async () => {
  const d = deps([new Error('ipc cassé'), 'brut']);
  await r.executerEtape(PLAN, PLAN.etapes[0], d);
  assert.deepEqual(d.appels.at(-1), ['taches:report', 'tache-1', 'a', { error: 'ipc cassé' }]);
  const e = deps(['brut']);
  await r.executerEtape(PLAN, PLAN.etapes[0], e);
  assert.deepEqual(e.appels.at(-1), ['taches:report', 'tache-1', 'a', { error: 'brut' }]);
});

test('executerEtape : onglet impossible à ouvrir -> compte rendu sans envoi', async () => {
  const d = deps([], { ouvrir: false });
  await r.executerEtape(PLAN, PLAN.etapes[1], d);
  assert.equal(d.appels.some(a => a[0] === 'scheduler:run-claude-job'), false);
  assert.match(d.appels.at(-1)[3].error, /Aucune webview .*« b »/);
});

test('creerMinuterie : plans dus exécutés, pas de passage concurrent, réponse non tableau', async () => {
  const d = deps([], { dues: [Object.assign({}, PLAN, { etapes: [PLAN.etapes[0]] })] });
  const passage = r.creerMinuterie(d);
  const p1 = passage();
  assert.equal(await passage(), false); // déjà en cours
  assert.equal(await p1, true);
  assert.deepEqual(d.appels[0], ['taches:dues', [{ profile: 'a', services: ['claude'] }]]);
  assert.equal(d.appels.filter(a => a[0] === 'taches:report').length, 1);
  const e = deps([], { dues: { error: 'boum' } });
  assert.equal(await r.creerMinuterie(e)(), true);
});

test('creerMinuterie : une exception libère la minuterie', async () => {
  const d = deps([]);
  d.invoke = async () => { throw new Error('ipc'); };
  const passage = r.creerMinuterie(d);
  await assert.rejects(passage(), /ipc/);
  await assert.rejects(passage(), /ipc/); // pas bloquée
});

test('taches-runner s\'attache à window dans le renderer', () => {
  const chemin = require.resolve('../lib/taches-runner.js');
  const avant = global.window;
  global.window = {};
  try {
    delete require.cache[chemin];
    require(chemin);
    assert.equal(typeof global.window.iaoTachesRunner.creerMinuterie, 'function');
  } finally {
    if (avant === undefined) delete global.window; else global.window = avant;
    delete require.cache[chemin];
  }
});
