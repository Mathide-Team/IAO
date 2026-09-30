'use strict';

// test/scheduler-rate-limiter.test.js — Tests des fonctions pures du limiteur
// de lancement (scheduler/core.js, lot 18/09/2026, FEATURES.md P1).

var test = require('node:test');
var assert = require('node:assert');

var core = require('../scheduler/core');

// --- countRunningJobs ----------------------------------------------------

test('countRunningJobs compte les jobs en état RUNNING', function() {
  var jobs = [
    { status: 'RUNNING' },
    { status: 'COMPLETED' },
    { status: 'RUNNING' },
    { status: 'RESUME_REQUIRED' }
  ];
  assert.strictEqual(core.countRunningJobs(jobs), 2);
});

test('countRunningJobs renvoie 0 pour un tableau vide', function() {
  assert.strictEqual(core.countRunningJobs([]), 0);
  assert.strictEqual(core.countRunningJobs(null), 0);
  assert.strictEqual(core.countRunningJobs(undefined), 0);
});

test('countRunningJobs ignore les entries invalides', function() {
  var jobs = [null, undefined, { status: 'RUNNING' }, {}];
  assert.strictEqual(core.countRunningJobs(jobs), 1);
});

// --- canLaunchJob --------------------------------------------------------

test('canLaunchJob renvoie true sous la limite', function() {
  var jobs = [{ status: 'RUNNING' }];
  var config = { enabled: true, maxConcurrentJobs: 2 };
  assert.ok(core.canLaunchJob(jobs, config, Date.now()));
});

test('canLaunchJob renvoie false a la limite', function() {
  var jobs = [{ status: 'RUNNING' }, { status: 'RUNNING' }];
  var config = { enabled: true, maxConcurrentJobs: 2 };
  assert.ok(!core.canLaunchJob(jobs, config, Date.now()));
});

test('canLaunchJob renvoie false si ordonnanceur desactive', function() {
  var jobs = [];
  var config = { enabled: false, maxConcurrentJobs: 2 };
  assert.ok(!core.canLaunchJob(jobs, config, Date.now()));
});

test('canLaunchJob utilise au moins 1 si maxConcurrentJobs invalide', function() {
  var jobs = [{ status: 'RUNNING' }];
  var config = { enabled: true, maxConcurrentJobs: 0 };
  assert.ok(!core.canLaunchJob(jobs, config, Date.now()));
  var config2 = { enabled: true, maxConcurrentJobs: 'abc' };
  assert.ok(!core.canLaunchJob(jobs, config2, Date.now()));
});

test('canLaunchJob renvoie true avec 0 jobs en cours', function() {
  var jobs = [{ status: 'COMPLETED' }, { status: 'DELIVERED' }];
  var config = { enabled: true, maxConcurrentJobs: 1 };
  assert.ok(core.canLaunchJob(jobs, config, Date.now()));
});

test('canLaunchJob renvoie false si config est null (issue #80)', function() {
  assert.ok(!core.canLaunchJob([], null, Date.now()));
  assert.ok(!core.canLaunchJob([], undefined, Date.now()));
});

// --- Alias du plan initial (issue #80) -------------------------------------

test('isMaxConcurrentReached est l\'inverse de canLaunchJob', function() {
  var jobs = [{ status: 'RUNNING' }, { status: 'RUNNING' }];
  var config = { enabled: true, maxConcurrentJobs: 2 };
  assert.ok(core.isMaxConcurrentReached(jobs, config, Date.now()));
  var jobs2 = [{ status: 'COMPLETED' }];
  assert.ok(!core.isMaxConcurrentReached(jobs2, config, Date.now()));
});

test('getRunningJobsCount est un alias de countRunningJobs', function() {
  var jobs = [{ status: 'RUNNING' }, { status: 'COMPLETED' }];
  assert.strictEqual(core.getRunningJobsCount(jobs), core.countRunningJobs(jobs));
});

test('selectEligibleJobForLaunch est un alias de selectNextJobToLaunch', function() {
  var jobs = [{ status: 'RESUME_REQUIRED', createdAt: '2026-09-18T08:00:00Z' }];
  var config = { enabled: true, maxConcurrentJobs: 2, minDelayBetweenAutomationsMinutes: 30 };
  assert.strictEqual(core.selectEligibleJobForLaunch(jobs, config, 0, Date.now()),
                     core.selectNextJobToLaunch(jobs, config, 0, Date.now()));
});

// --- Branches supplémentaires (issue #80) -----------------------------------

test('isMinDelayRespected utilise Date.now() si now est absent (branche || Date.now())', function() {
  // Sans now, Number(undefined) = NaN -> Date.now()
  var last = Date.now() - (31 * 60 * 1000); // 31 min ago
  assert.ok(core.isMinDelayRespected(last, 30));
});

test('checkJobLaunchEligibility couvre || 1 quand maxConcurrentJobs est 0 avec jobs RUNNING', function() {
  var job = { status: 'RESUME_REQUIRED' };
  var jobs = [{ status: 'RUNNING' }];
  var config = { enabled: true, maxConcurrentJobs: 0, minDelayBetweenAutomationsMinutes: 30 };
  // maxConcurrentJobs=0 -> canLaunchJob met max=1, 1 RUNNING >= 1 -> false
  var result = core.checkJobLaunchEligibility(job, jobs, config, 0, Date.now());
  assert.ok(!result.canLaunch);
  assert.match(result.reason, /concurrent/);
});

test('checkJobLaunchEligibility couvre || 0 quand minDelay est 0', function() {
  var now = Date.now();
  var job = { status: 'RESUME_REQUIRED', createdAt: '2026-09-18T00:00:00Z' };
  // minDelay=0 -> || 0 -> le message affiche 0 min
  var config = { enabled: true, maxConcurrentJobs: 2, minDelayBetweenAutomationsMinutes: 0 };
  // Avec minDelay=0, isMinDelayRespected renvoie true (pas de restriction)
  var result = core.checkJobLaunchEligibility(job, [], config, now - 1000, now);
  assert.ok(result.canLaunch);
});

test('selectNextJobToLaunch trie plusieurs jobs RESUME_REQUIRED par ancienneté (branche sort)', function() {
  var jobs = [
    { status: 'RESUME_REQUIRED', createdAt: '2026-09-18T10:00:00Z' },
    { status: 'RESUME_REQUIRED', createdAt: '2026-09-18T06:00:00Z' },
    { status: 'RESUME_REQUIRED', createdAt: '2026-09-18T08:00:00Z' }
  ];
  var config = { enabled: true, maxConcurrentJobs: 2, minDelayBetweenAutomationsMinutes: 30 };
  var result = core.selectNextJobToLaunch(jobs, config, 0, Date.now());
  assert.strictEqual(result.createdAt, '2026-09-18T06:00:00Z');
});

// --- isMinDelayRespected ------------------------------------------------

test('isMinDelayRespected renvoie true si jamais execute (lastAutomationAt=0)', function() {
  assert.ok(core.isMinDelayRespected(0, 30, Date.now()));
});

test('isMinDelayRespected renvoie true si delai ecoule', function() {
  var now = Date.now();
  var last = now - (31 * 60 * 1000); // 31 min
  assert.ok(core.isMinDelayRespected(last, 30, now));
});

test('isMinDelayRespected renvoie false si delai non ecoule', function() {
  var now = Date.now();
  var last = now - (10 * 60 * 1000); // 10 min
  assert.ok(!core.isMinDelayRespected(last, 30, now));
});

test('isMinDelayRespected renvoie true au delai exact (limite inclusive)', function() {
  var now = Date.now();
  var last = now - (30 * 60 * 1000); // exactement 30 min
  assert.ok(core.isMinDelayRespected(last, 30, now));
});

test('isMinDelayRespected renvoie true si delai a 0 (pas de restriction)', function() {
  var now = Date.now();
  var last = now - 1000;
  assert.ok(core.isMinDelayRespected(last, 0, now));
});

// --- checkJobLaunchEligibility ------------------------------------------

test('checkJobLaunchEligibility renvoie canLaunch=true pour un job eligible', function() {
  var job = { status: 'RESUME_REQUIRED', createdAt: '2026-09-18T00:00:00Z' };
  var jobs = [{ status: 'COMPLETED' }];
  var config = { enabled: true, maxConcurrentJobs: 2, minDelayBetweenAutomationsMinutes: 30 };
  var result = core.checkJobLaunchEligibility(job, jobs, config, 0, Date.now());
  assert.ok(result.canLaunch);
  assert.strictEqual(result.reason, 'OK');
});

test('checkJobLaunchEligibility refuse un job non RESUME_REQUIRED', function() {
  var job = { status: 'COMPLETED' };
  var jobs = [];
  var config = { enabled: true, maxConcurrentJobs: 2, minDelayBetweenAutomationsMinutes: 30 };
  var result = core.checkJobLaunchEligibility(job, jobs, config, 0, Date.now());
  assert.ok(!result.canLaunch);
  assert.ok(result.reason.indexOf('attente de reprise') !== -1);
});

test('checkJobLaunchEligibility refuse si ordonnanceur desactive', function() {
  var job = { status: 'RESUME_REQUIRED' };
  var config = { enabled: false, maxConcurrentJobs: 2, minDelayBetweenAutomationsMinutes: 30 };
  var result = core.checkJobLaunchEligibility(job, [], config, 0, Date.now());
  assert.ok(!result.canLaunch);
  assert.ok(result.reason.indexOf('d\u00e9sactiv\u00e9') !== -1 || result.reason.indexOf('desactive') !== -1);
});

test('checkJobLaunchEligibility refuse si limite concurrent atteinte', function() {
  var job = { status: 'RESUME_REQUIRED' };
  var jobs = [{ status: 'RUNNING' }, { status: 'RUNNING' }];
  var config = { enabled: true, maxConcurrentJobs: 2, minDelayBetweenAutomationsMinutes: 30 };
  var result = core.checkJobLaunchEligibility(job, jobs, config, 0, Date.now());
  assert.ok(!result.canLaunch);
  assert.ok(result.reason.indexOf('concurrent') !== -1);
});

test('checkJobLaunchEligibility refuse si delai minimum non respecte', function() {
  var now = Date.now();
  var job = { status: 'RESUME_REQUIRED' };
  var config = { enabled: true, maxConcurrentJobs: 2, minDelayBetweenAutomationsMinutes: 30 };
  var last = now - (5 * 60 * 1000); // 5 min
  var result = core.checkJobLaunchEligibility(job, [], config, last, now);
  assert.ok(!result.canLaunch);
  assert.ok(result.reason.indexOf('delai') !== -1 || result.reason.indexOf('D\u00e9lai') !== -1);
});

test('checkJobLaunchEligibility gère un job null', function() {
  var result = core.checkJobLaunchEligibility(null, [], { enabled: true }, 0, Date.now());
  assert.ok(!result.canLaunch);
});

// --- selectNextJobToLaunch -----------------------------------------------

test('selectNextJobToLaunch selectionne le plus ancien RESUME_REQUIRED', function() {
  var jobs = [
    { status: 'RESUME_REQUIRED', createdAt: '2026-09-18T10:00:00Z' },
    { status: 'RESUME_REQUIRED', createdAt: '2026-09-18T08:00:00Z' },
    { status: 'COMPLETED', createdAt: '2026-09-18T09:00:00Z' }
  ];
  var config = { enabled: true, maxConcurrentJobs: 2, minDelayBetweenAutomationsMinutes: 30 };
  var result = core.selectNextJobToLaunch(jobs, config, 0, Date.now());
  assert.ok(result);
  assert.strictEqual(result.createdAt, '2026-09-18T08:00:00Z');
});

test('selectNextJobToLaunch renvoie null si aucun job eligible', function() {
  var jobs = [{ status: 'COMPLETED' }];
  var config = { enabled: true, maxConcurrentJobs: 2, minDelayBetweenAutomationsMinutes: 30 };
  var result = core.selectNextJobToLaunch(jobs, config, 0, Date.now());
  assert.strictEqual(result, null);
});

test('selectNextJobToLaunch renvoie null si limite concurrent atteinte', function() {
  var jobs = [
    { status: 'RUNNING' },
    { status: 'RUNNING' },
    { status: 'RESUME_REQUIRED', createdAt: '2026-09-18T08:00:00Z' }
  ];
  var config = { enabled: true, maxConcurrentJobs: 2, minDelayBetweenAutomationsMinutes: 30 };
  var result = core.selectNextJobToLaunch(jobs, config, 0, Date.now());
  assert.strictEqual(result, null);
});

test('selectNextJobToLaunch renvoie null si ordonnanceur desactive', function() {
  var jobs = [{ status: 'RESUME_REQUIRED', createdAt: '2026-09-18T08:00:00Z' }];
  var config = { enabled: false, maxConcurrentJobs: 2, minDelayBetweenAutomationsMinutes: 30 };
  var result = core.selectNextJobToLaunch(jobs, config, 0, Date.now());
  assert.strictEqual(result, null);
});

test('selectNextJobToLaunch renvoie null si delai non respecte', function() {
  var now = Date.now();
  var jobs = [{ status: 'RESUME_REQUIRED', createdAt: '2026-09-18T08:00:00Z' }];
  var config = { enabled: true, maxConcurrentJobs: 2, minDelayBetweenAutomationsMinutes: 30 };
  var last = now - (5 * 60 * 1000);
  var result = core.selectNextJobToLaunch(jobs, config, last, now);
  assert.strictEqual(result, null);
});

test('selectNextJobToLaunch gère un tableau vide', function() {
  var config = { enabled: true, maxConcurrentJobs: 2, minDelayBetweenAutomationsMinutes: 30 };
  assert.strictEqual(core.selectNextJobToLaunch([], config, 0, Date.now()), null);
  assert.strictEqual(core.selectNextJobToLaunch(null, config, 0, Date.now()), null);
});
