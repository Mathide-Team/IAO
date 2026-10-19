'use strict';

// Issue #199, lot 1 : l'ancien ordonnanceur (ZIP, jobs, projets) est désactivé
// par défaut ; IAO_ORDONNANCEUR_ANCIEN=1 le réactive.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const { ancienFluxActif } = require('../scheduler/taches.js');

test('ancienFluxActif : désactivé sauf valeur explicite', () => {
  assert.equal(ancienFluxActif({}), false);
  assert.equal(ancienFluxActif(undefined), false);
  assert.equal(ancienFluxActif({ IAO_ORDONNANCEUR_ANCIEN: '0' }), false);
  assert.equal(ancienFluxActif({ IAO_ORDONNANCEUR_ANCIEN: 'non' }), false);
  for (const v of ['1', 'true', ' YES ', 'on']) {
    assert.equal(ancienFluxActif({ IAO_ORDONNANCEUR_ANCIEN: v }), true, v);
  }
});

function creer(t, env) {
  const avant = process.env.IAO_ORDONNANCEUR_ANCIEN;
  if (env === undefined) delete process.env.IAO_ORDONNANCEUR_ANCIEN;
  else process.env.IAO_ORDONNANCEUR_ANCIEN = env;
  const { Scheduler } = require('../scheduler/index');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iao-ancien-'));
  const partitions = [];
  const scheduler = new Scheduler({ getPath: () => dir }, {
    fromPartition(nom) { partitions.push(nom); return { on() {}, removeListener() {} }; }
  });
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    if (avant === undefined) delete process.env.IAO_ORDONNANCEUR_ANCIEN;
    else process.env.IAO_ORDONNANCEUR_ANCIEN = avant;
  });
  return { scheduler, partitions };
}

test('par défaut : démarrage refusé, journalisé, aucune partition surveillée', (t) => {
  const { scheduler, partitions } = creer(t, undefined);
  scheduler.syncAccounts([{ profile: 'profil_1' }]);
  const cfg = scheduler.setEnabled(true);
  assert.equal(cfg.enabled, false);
  assert.deepEqual(partitions, []);
  const etat = scheduler.getState();
  assert.equal(etat.ancienFlux, false);
  assert.match(etat.log[0].message, /désactivé \(#199\)/);
  // L'arrêt reste possible (aucun effet).
  assert.equal(scheduler.setEnabled(false).enabled, false);
});

test('IAO_ORDONNANCEUR_ANCIEN=1 : comportement d\'avant (#181)', (t) => {
  const { scheduler, partitions } = creer(t, '1');
  scheduler.syncAccounts([{ profile: 'profil_1' }]);
  assert.equal(scheduler.setEnabled(true).enabled, true);
  assert.deepEqual(partitions, ['persist:profil_1']);
  assert.equal(scheduler.getState().ancienFlux, true);
});
