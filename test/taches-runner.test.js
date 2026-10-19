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

// --- Lot 4 : moteur partagé minuterie / « Exécuter maintenant » ---

test('creerMoteur.executer : plan manuel exécuté par le même chemin que la minuterie', async () => {
  const d = deps([]);
  const moteur = r.creerMoteur(d);
  assert.equal(await moteur.executer(PLAN), true);
  assert.deepEqual(d.appels[0], ['ouvrir', 'a', 'claude', 'https://claude.ai/new']);
  assert.deepEqual(d.appels[1], ['scheduler:run-claude-job', 'a', 'p', null]);
  assert.deepEqual(d.appels[2], ['taches:report', 'tache-1', 'a', { ok: true }]);
});

test('creerMoteur : garde partagée, refus AVANT tout appel au service', async () => {
  // Promesse différée explicite : le premier plan reste en vol jusqu'à ce que
  // le test la résolve. Pendant ce temps, un second appel (minuterie ou
  // « Exécuter maintenant ») doit être refusé sans toucher au service.
  let resoudre = null;
  const enVol = new Promise(r => { resoudre = r; });
  const appelsService = [];
  const d = Object.assign(deps([]), {
    invoke: async (canal, ...args) => {
      appelsService.push(canal);
      if (canal === 'taches:dues') return [PLAN];
      if (canal === 'scheduler:run-claude-job') return enVol; // en vol
      return true;
    }
  });
  const moteur = r.creerMoteur(d);
  const passage = moteur.passage();
  await Promise.resolve();
  // Pendant l'exécution : la minuterie et le manuel sont refusés, sans
  // nouvel appel à taches:dues ni à taches:run-now.
  const nbAvant = appelsService.length;
  assert.equal(await moteur.passage(), false);
  assert.deepEqual(await moteur.executerTache('tache-1'), { ok: false, motif: 'occupe' });
  assert.equal(appelsService.length, nbAvant, 'aucun appel au service pendant la garde');
  resoudre({ ok: true });
  assert.equal(await passage, true);
});

test('creerMoteur.executerTache : plan du service exécuté par le même chemin', async () => {
  // Même chemin que la minuterie : run-now (service) -> ouvrir l'onglet ->
  // scheduler:run-claude-job -> taches:report. Les deux tableaux (invoke et
  // ouverture d'onglet) sont vérifiés séparément — ils sont remplis par des
  // dépendances distinctes.
  const appels = [];
  const ouvertures = [];
  const d = Object.assign(deps([]), {
    ouvrirOnglet: (profil, f, url) => { ouvertures.push(['ouvrir', profil, f, url]); return true; },
    invoke: async (canal, ...args) => {
      appels.push([canal, ...args]);
      if (canal === 'taches:run-now') return Object.assign({}, PLAN);
      if (canal === 'scheduler:run-claude-job') return { ok: true };
      return true;
    }
  });
  const moteur = r.creerMoteur(d);
  assert.deepEqual(await moteur.executerTache('tache-1'), { ok: true, motif: 'lancee' });
  // Le plan de test compte trois étapes (a, b, c) : même chemin pour chacune.
  assert.deepEqual(appels[0], ['taches:run-now', 'tache-1', [{ profile: 'a', services: ['claude'] }]]);
  assert.deepEqual(appels[1], ['scheduler:run-claude-job', 'a', 'p', null]);
  assert.deepEqual(appels[2], ['taches:report', 'tache-1', 'a', { ok: true }]);
  assert.deepEqual(appels[3], ['scheduler:run-claude-job', 'b', 'p', null]);
  assert.deepEqual(appels[4], ['taches:report', 'tache-1', 'b', { ok: true }]);
  assert.deepEqual(appels[5], ['scheduler:run-claude-job', 'c', 'p', null]);
  assert.deepEqual(appels[6], ['taches:report', 'tache-1', 'c', { ok: true }]);
  assert.deepEqual(ouvertures, [
    ['ouvrir', 'a', 'claude', 'https://claude.ai/new'],
    ['ouvrir', 'b', 'claude', 'https://claude.ai/new'],
    ['ouvrir', 'c', 'claude', 'https://claude.ai/new']
  ]);
});

test('creerMoteur.executerTache : tâche introuvable / erreur du service', async () => {
  let reponse = null;
  const d = Object.assign(deps([]), {
    invoke: async (canal) => {
      if (canal === 'taches:run-now') return reponse;
      return true;
    }
  });
  const moteur = r.creerMoteur(d);
  assert.deepEqual(await moteur.executerTache('absente'), { ok: false, motif: 'introuvable' });
  reponse = { error: 'boom' };
  assert.deepEqual(await moteur.executerTache('absente'), { ok: false, motif: 'erreur-service' });
});

test('creerMoteur : une exception libère la garde', async () => {
  const d = Object.assign(deps([]), {
    invoke: async (canal, ...args) => {
      if (canal === 'taches:dues') throw new Error('boom');
      return true;
    }
  });
  const moteur = r.creerMoteur(d);
  await assert.rejects(moteur.passage(), /boom/);
  assert.equal(await moteur.executer(PLAN), true); // la garde est libérée
});
