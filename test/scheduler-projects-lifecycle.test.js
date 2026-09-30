'use strict';

// test/scheduler-projects-lifecycle.test.js — Couverture de scheduler/index.js :
// updateProject, deleteProject, createTask, assignTask et
// getAssignableAccountsForProject (issue #89, tâche 55.20 de #55).
// `app` Electron simulé, userData temporaire, aucun accès réseau.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Scheduler } = require('../scheduler/index');

const HOUR = 60 * 60 * 1000;

// Crée un Scheduler sur un userData temporaire, supprimé en fin de test.
function makeScheduler(t, accounts) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'iao-proj-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const s = new Scheduler({ getPath: () => tmp }, {});
  s.accountsSnapshot = accounts || [];
  return s;
}

// Un compte « vert » (inactif depuis 10 h), un « rouge » (utilisé il y a 1 h).
function accounts() {
  const now = Date.now();
  return [
    { id: 'green', name: 'Vert', profile: 'profil_1', automation: { lastUsedAt: now - 10 * HOUR } },
    { id: 'red', name: 'Rouge', profile: 'profil_2', automation: { lastUsedAt: now - 1 * HOUR } },
    { id: 'fresh', name: 'Neuf', profile: 'profil_3' }
  ];
}

// --- updateProject -----------------------------------------------------------

test('updateProject lève une erreur pour un projet inconnu', (t) => {
  const s = makeScheduler(t);
  assert.throws(() => s.updateProject('proj_404', { name: 'x' }), /Projet introuvable : proj_404/);
});

test('updateProject met à jour nom, comptes autorisés et statut, et persiste', (t) => {
  const s = makeScheduler(t);
  const p = s.createProject('Initial', []);
  const r = s.updateProject(p.id, { name: 'Renommé', allowedAccountIds: ['green'], status: 'paused' });
  assert.equal(r.name, 'Renommé');
  assert.deepEqual(r.allowedAccountIds, ['green']);
  assert.equal(r.status, 'paused');
  const onDisk = JSON.parse(fs.readFileSync(s.projectsPath, 'utf-8'));
  assert.equal(onDisk[0].name, 'Renommé');
  assert.equal(onDisk[0].status, 'paused');
});

test('updateProject ignore les champs absents ou invalides', (t) => {
  const s = makeScheduler(t);
  const p = s.createProject('Stable', ['a']);
  const before = { name: p.name, ids: p.allowedAccountIds.slice(), status: p.status };
  // allowedAccountIds non-tableau, name/status vides : rien ne change.
  s.updateProject(p.id, { name: '', allowedAccountIds: 'nope', status: '' });
  assert.equal(p.name, before.name);
  assert.deepEqual(p.allowedAccountIds, before.ids);
  assert.equal(p.status, before.status);
  // fields absent : ne plante pas.
  assert.doesNotThrow(() => s.updateProject(p.id));
  assert.doesNotThrow(() => s.updateProject(p.id, null));
});

// --- deleteProject -----------------------------------------------------------

test('deleteProject lève une erreur pour un projet inconnu', (t) => {
  const s = makeScheduler(t);
  assert.throws(() => s.deleteProject('proj_404'), /Projet introuvable : proj_404/);
});

test('deleteProject supprime le projet, le renvoie et persiste', (t) => {
  const s = makeScheduler(t);
  const a = s.createProject('A');
  const b = s.createProject('B');
  const removed = s.deleteProject(a.id);
  assert.equal(removed.id, a.id);
  assert.deepEqual(s.projects.map(p => p.id), [b.id]);
  assert.deepEqual(JSON.parse(fs.readFileSync(s.projectsPath, 'utf-8')).map(p => p.id), [b.id]);
});

// --- createTask (prérequis des tests d'assignation) ---------------------------

test('createTask lève une erreur pour un projet inconnu', (t) => {
  const s = makeScheduler(t);
  assert.throws(() => s.createTask('proj_404', 'prompt'), /Projet introuvable : proj_404/);
});

test('createTask ajoute une tâche avec valeurs par défaut', (t) => {
  const s = makeScheduler(t);
  const p = s.createProject('P');
  const task = s.createTask(p.id);
  assert.equal(task.prompt, '');
  assert.equal(task.sourceZip, null);
  assert.equal(task.status, 'pending');
  assert.equal(p.tasks.length, 1);
});

// --- assignTask --------------------------------------------------------------

test('assignTask : projet, tâche et compte inconnus lèvent une erreur explicite', (t) => {
  const s = makeScheduler(t, accounts());
  const p = s.createProject('P');
  const task = s.createTask(p.id, 'go');
  assert.throws(() => s.assignTask('proj_404', task.id, 'green'), /Projet introuvable : proj_404/);
  assert.throws(() => s.assignTask(p.id, 'task_404', 'green'), /Tâche introuvable : task_404/);
  assert.throws(() => s.assignTask(p.id, task.id, 'ghost'), /Compte introuvable : ghost/);
});

test('assignTask refuse un compte non vert (récent ou onglet ouvert)', (t) => {
  const s = makeScheduler(t, accounts());
  const p = s.createProject('P');
  const task = s.createTask(p.id, 'go');
  assert.throws(() => s.assignTask(p.id, task.id, 'red'), /n'est pas assignable/);
  assert.throws(() => s.assignTask(p.id, task.id, 'green', ['green']), /n'est pas assignable/);
  assert.equal(task.status, 'pending');
  assert.equal(task.assignedProfile, null);
});

test('assignTask refuse un compte non autorisé par le projet', (t) => {
  const s = makeScheduler(t, accounts());
  const p = s.createProject('P', ['fresh']);
  const task = s.createTask(p.id, 'go');
  assert.throws(() => s.assignTask(p.id, task.id, 'green'), /n'est pas assignable/);
});

test('assignTask assigne un compte vert autorisé et persiste', (t) => {
  const s = makeScheduler(t, accounts());
  const p = s.createProject('P', ['green']);
  const task = s.createTask(p.id, 'go');
  const r = s.assignTask(p.id, task.id, 'green');
  assert.equal(r.status, 'assigned');
  assert.equal(r.assignedProfile, 'profil_1');
  assert.equal(p.lastActivityAt, r.lastActivityAt);
  const onDisk = JSON.parse(fs.readFileSync(s.projectsPath, 'utf-8'));
  assert.equal(onDisk[0].tasks[0].status, 'assigned');
});

// --- getAssignableAccountsForProject -----------------------------------------

test('getAssignableAccountsForProject lève une erreur pour un projet inconnu', (t) => {
  const s = makeScheduler(t, accounts());
  assert.throws(() => s.getAssignableAccountsForProject('proj_404'), /Projet introuvable : proj_404/);
});

test('getAssignableAccountsForProject ne renvoie que les comptes verts autorisés', (t) => {
  const s = makeScheduler(t, accounts());
  const open = s.createProject('Ouvert', []);
  // Sans openAccountIds : verts = green + fresh (jamais utilisé), pas red.
  assert.deepEqual(s.getAssignableAccountsForProject(open.id).map(a => a.id), ['green', 'fresh']);
  // openAccountIds en tableau : green est exclu (onglet ouvert).
  assert.deepEqual(s.getAssignableAccountsForProject(open.id, ['green']).map(a => a.id), ['fresh']);
  // openAccountIds en Set.
  assert.deepEqual(s.getAssignableAccountsForProject(open.id, new Set(['fresh'])).map(a => a.id), ['green']);
  // Projet restreint à red (non vert) : aucun compte.
  const restricted = s.createProject('Restreint', ['red']);
  assert.deepEqual(s.getAssignableAccountsForProject(restricted.id), []);
});
