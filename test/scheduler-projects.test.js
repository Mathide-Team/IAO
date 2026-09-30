'use strict';

// test/scheduler-projects.test.js — Tests des fonctions pures de scheduler/core.js
// pour les projets et tâches (lot 18/09/2026, point 6).
// Invariant 11 : toute fonction pure va dans lib/ ou scheduler/core.js avec son test.

const test = require('node:test');
const assert = require('node:assert');

const core = require('../scheduler/core');

// --- buildProjectRecord --------------------------------------------------

test('buildProjectRecord crée un projet avec les champs par défaut', () => {
  const p = core.buildProjectRecord({ id: 'proj_001', name: 'Mon projet' });
  assert.strictEqual(p.id, 'proj_001');
  assert.strictEqual(p.name, 'Mon projet');
  assert.strictEqual(p.status, 'active');
  assert.deepStrictEqual(p.allowedAccountIds, []);
  assert.deepStrictEqual(p.tasks, []);
  assert.ok(p.createdAt);
  assert.ok(p.lastActivityAt);
});

test('buildProjectRecord lève une erreur sans id', () => {
  assert.throws(() => core.buildProjectRecord({ name: 'test' }), /id de projet manquant/);
  assert.throws(() => core.buildProjectRecord(null), /id de projet manquant/);
});

test('buildProjectRecord accepte des allowedAccountIds', () => {
  const p = core.buildProjectRecord({ id: 'proj_001', allowedAccountIds: ['acc1', 'acc2'] });
  assert.deepStrictEqual(p.allowedAccountIds, ['acc1', 'acc2']);
});

test('buildProjectRecord accepte un status personnalisé', () => {
  const p = core.buildProjectRecord({ id: 'proj_001', status: 'completed' });
  assert.strictEqual(p.status, 'completed');
});

// --- buildTaskRecord -----------------------------------------------------

test('buildTaskRecord crée une tâche avec les champs par défaut', () => {
  const t = core.buildTaskRecord({ id: 'task_001', projectId: 'proj_001', prompt: 'Fais ceci' });
  assert.strictEqual(t.id, 'task_001');
  assert.strictEqual(t.projectId, 'proj_001');
  assert.strictEqual(t.prompt, 'Fais ceci');
  assert.strictEqual(t.status, 'pending');
  assert.strictEqual(t.assignedProfile, null);
  assert.strictEqual(t.sourceZip, null);
  assert.ok(t.createdAt);
  assert.ok(t.lastActivityAt);
});

test('buildTaskRecord lève une erreur sans id', () => {
  assert.throws(() => core.buildTaskRecord({ projectId: 'p1' }), /id de tâche manquant/);
  assert.throws(() => core.buildTaskRecord(null), /id de tâche manquant/);
});

// --- canAssignTaskToAccount ----------------------------------------------

test('canAssignTaskToAccount renvoie true pour un compte vert autorisé', () => {
  const now = Date.now();
  const project = { id: 'p1', allowedAccountIds: [] };
  const account = { id: 'a1', automation: { lastUsedAt: now - (6 * 60 * 60 * 1000) } };
  assert.ok(core.canAssignTaskToAccount(project, account, new Set(), 5, now));
});

test('canAssignTaskToAccount renvoie false pour un compte avec onglet ouvert', () => {
  const now = Date.now();
  const project = { id: 'p1', allowedAccountIds: [] };
  const account = { id: 'a1', automation: { lastUsedAt: now - (10 * 60 * 60 * 1000) } };
  assert.ok(!core.canAssignTaskToAccount(project, account, new Set(['a1']), 5, now));
});

test('canAssignTaskToAccount renvoie false pour un compte récent (moins de 5h)', () => {
  const now = Date.now();
  const project = { id: 'p1', allowedAccountIds: [] };
  const account = { id: 'a1', automation: { lastUsedAt: now - (3 * 60 * 60 * 1000) } };
  assert.ok(!core.canAssignTaskToAccount(project, account, new Set(), 5, now));
});

test('canAssignTaskToAccount respecte allowedAccountIds du projet', () => {
  const now = Date.now();
  const project = { id: 'p1', allowedAccountIds: ['a1', 'a3'] };
  const account1 = { id: 'a1', automation: { lastUsedAt: now - (6 * 60 * 60 * 1000) } };
  const account2 = { id: 'a2', automation: { lastUsedAt: now - (6 * 60 * 60 * 1000) } };
  assert.ok(core.canAssignTaskToAccount(project, account1, new Set(), 5, now));
  assert.ok(!core.canAssignTaskToAccount(project, account2, new Set(), 5, now));
});

test('canAssignTaskToAccount autorise tous les comptes si allowedAccountIds est vide', () => {
  const now = Date.now();
  const project = { id: 'p1', allowedAccountIds: [] };
  const account = { id: 'a99', automation: { lastUsedAt: now - (6 * 60 * 60 * 1000) } };
  assert.ok(core.canAssignTaskToAccount(project, account, new Set(), 5, now));
});

test('canAssignTaskToAccount renvoie true pour un compte jamais utilisé', () => {
  const now = Date.now();
  const project = { id: 'p1', allowedAccountIds: [] };
  const account = { id: 'a1', automation: { lastUsedAt: 0 } };
  assert.ok(core.canAssignTaskToAccount(project, account, new Set(), 5, now));
});

test('canAssignTaskToAccount gère null/undefined', () => {
  assert.ok(!core.canAssignTaskToAccount(null, {}, new Set(), 5, Date.now()));
  assert.ok(!core.canAssignTaskToAccount({}, null, new Set(), 5, Date.now()));
});

test('canAssignTaskToAccount accepte un tableau au lieu d\'un Set pour openAccountIds', () => {
  const now = Date.now();
  const project = { id: 'p1', allowedAccountIds: [] };
  const account = { id: 'a1', automation: { lastUsedAt: now - (6 * 60 * 60 * 1000) } };
  assert.ok(core.canAssignTaskToAccount(project, account, ['a2'], 5, now));
  assert.ok(!core.canAssignTaskToAccount(project, account, ['a1'], 5, now));
});

// --- Branches supplémentaires (issue #80) -----------------------------------

test('canAssignTaskToAccount gère openAccountIds null (branche || [])', () => {
  const now = Date.now();
  const project = { id: 'p1', allowedAccountIds: [] };
  const account = { id: 'a1', automation: { lastUsedAt: now - (6 * 60 * 60 * 1000) } };
  assert.ok(core.canAssignTaskToAccount(project, account, null, 5, now));
});

test('canAssignTaskToAccount utilise Date.now() si now est absent (branche || Date.now())', () => {
  const project = { id: 'p1', allowedAccountIds: [] };
  const account = { id: 'a1', automation: { lastUsedAt: 0 } };
  assert.ok(core.canAssignTaskToAccount(project, account, new Set(), 5));
});

test('canAssignTaskToAccount utilise 5 si thresholdHours est 0 (branche || 5)', () => {
  const now = Date.now();
  const project = { id: 'p1', allowedAccountIds: [] };
  // thresholdHours=0 -> Number(0)||5 = 5, donc 5h de seuil
  const account = { id: 'a1', automation: { lastUsedAt: now - (6 * 60 * 60 * 1000) } };
  assert.ok(core.canAssignTaskToAccount(project, account, new Set(), 0, now));
  // 3h < 5h -> pas assignable
  const account2 = { id: 'a2', automation: { lastUsedAt: now - (3 * 60 * 60 * 1000) } };
  assert.ok(!core.canAssignTaskToAccount(project, account2, new Set(), 0, now));
});

test('buildProjectRecord gère fields.tasks non-tableau (branche : [])', () => {
  const p = core.buildProjectRecord({ id: 'p1', tasks: 'not an array' });
  assert.deepStrictEqual(p.tasks, []);
});

test('buildProjectRecord accepte un vrai tableau pour tasks (branche ?)', () => {
  const tasks = [{ id: 't1', status: 'pending' }];
  const p = core.buildProjectRecord({ id: 'p1', tasks });
  assert.deepStrictEqual(p.tasks, tasks);
});

test('buildTaskRecord couvre || null pour projectId et sourceZip', () => {
  const t = core.buildTaskRecord({ id: 't1' });
  assert.strictEqual(t.projectId, null);
  assert.strictEqual(t.sourceZip, null);
});
