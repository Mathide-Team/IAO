'use strict';

// test/scheduler-core-branches.test.js — issue #55 : dernières branches de
// scheduler/core.js (98,05 % sur dev @ dbf4245).
//
// - canTransition : repli `|| []` quand un état valide n'a pas d'entrée dans
//   ALLOWED_TRANSITIONS (objet exporté, donc modifiable par un appelant) ;
// - isFrenchQuietHours / quietHoursRemainingMs : normalisation de l'heure
//   « 24 » (certaines versions d'ICU formatent minuit ainsi en hour12:false)
//   et garde `waitSec <= 0` (bascule à 20:30 entre les deux lectures de
//   l'horloge). L'ICU embarqué par Node 22 renvoie « 00 » : ces chemins ne
//   se provoquent qu'avec un Intl.DateTimeFormat simulé.

const test = require('node:test');
const assert = require('node:assert/strict');

const core = require('../scheduler/core');

// Remplace Intl.DateTimeFormat : chaque appel consomme l'heure suivante de
// `sequence` ([h, m, s] sous forme de chaînes, comme formatToParts).
function stubIntl(t, sequence) {
  const original = Intl.DateTimeFormat;
  let i = 0;
  Intl.DateTimeFormat = function FakeDateTimeFormat() {
    const [hour, minute, second] = sequence[Math.min(i++, sequence.length - 1)];
    return {
      formatToParts: () => [
        { type: 'hour', value: hour },
        { type: 'literal', value: ':' },
        { type: 'minute', value: minute },
        { type: 'literal', value: ':' },
        { type: 'second', value: second }
      ]
    };
  };
  t.after(() => { Intl.DateTimeFormat = original; });
}

test('canTransition : état valide sans entrée de transitions -> false', (t) => {
  const saved = core.ALLOWED_TRANSITIONS.DELIVERED;
  delete core.ALLOWED_TRANSITIONS.DELIVERED;
  t.after(() => { core.ALLOWED_TRANSITIONS.DELIVERED = saved; });
  assert.equal(core.canTransition('DELIVERED', 'ERROR'), false);
});

test('isFrenchQuietHours : heure « 24 » normalisée en minuit (hors pause)', (t) => {
  stubIntl(t, [['24', '10', '00']]);
  assert.equal(core.isFrenchQuietHours(new Date()), false);
});

test('quietHoursRemainingMs : heure « 24 » à la 2e lecture -> attente jusqu\'à 20:30', (t) => {
  // 1re lecture (isFrenchQuietHours) : 16:00, dans la pause ; 2e lecture :
  // « 24:00:00 » = minuit, soit 20 h 30 d'attente.
  stubIntl(t, [['16', '00', '00'], ['24', '00', '00']]);
  assert.equal(core.quietHoursRemainingMs(new Date()), (20 * 3600 + 30 * 60) * 1000);
});

test('quietHoursRemainingMs : 20:30 atteint entre les deux lectures -> 0', (t) => {
  stubIntl(t, [['20', '29', '59'], ['20', '30', '00']]);
  assert.equal(core.quietHoursRemainingMs(new Date()), 0);
});
