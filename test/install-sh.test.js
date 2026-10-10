'use strict';

// test/install-sh.test.js — install.sh reconstruit un build périmé (issue #165).
// Avant le correctif, un build présent dans dist/ était réinstallé tel quel,
// même après un `git pull` : l'utilisateur gardait l'ancienne interface.
// Le vrai install.sh tourne dans un projet temporaire, avec un faux `npm`
// dans le PATH (il simule `npm install` / `npm run dist:linux` et compte ses
// appels) et un HOME temporaire : aucun accès réseau ni build Electron réel.

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const skip = process.platform === 'win32' ? 'install.sh est propre à Linux' : false;

function makeProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iao-install-'));
  const project = path.join(dir, 'project');
  const home = path.join(dir, 'home');
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(path.join(project, 'installer'), { recursive: true });
  fs.mkdirSync(path.join(project, 'build'), { recursive: true });
  fs.mkdirSync(home);
  fs.mkdirSync(bin);
  fs.copyFileSync(path.join(ROOT, 'install.sh'), path.join(project, 'install.sh'));
  fs.chmodSync(path.join(project, 'install.sh'), 0o755);
  fs.copyFileSync(path.join(ROOT, 'installer', 'iao.desktop.in'), path.join(project, 'installer', 'iao.desktop.in'));
  fs.copyFileSync(path.join(ROOT, 'build', 'icon.png'), path.join(project, 'build', 'icon.png'));
  fs.writeFileSync(path.join(project, 'main.js'), '// v1\n');
  fs.writeFileSync(path.join(project, 'index.html'), '<!-- v1 -->\n');
  fs.writeFileSync(path.join(project, 'package-lock.json'), '{}\n');
  // Faux npm : journalise chaque appel ; `install` crée node_modules,
  // `run dist:linux` produit dist/IAO-linux-x64/IAO.
  const log = path.join(dir, 'npm.log');
  fs.writeFileSync(path.join(bin, 'npm'), [
    '#!/usr/bin/env bash',
    'echo "$*" >> "' + log + '"',
    'if [ "$1" = install ]; then',
    '  mkdir -p node_modules/.bin',
    '  printf "#!/bin/sh\\n" > node_modules/.bin/electron-packager',
    '  chmod +x node_modules/.bin/electron-packager',
    '  echo "{}" > node_modules/.package-lock.json',
    'elif [ "$1 $2" = "run dist:linux" ]; then',
    '  mkdir -p dist/IAO-linux-x64',
    '  printf "#!/bin/sh\\n" > dist/IAO-linux-x64/IAO',
    '  chmod +x dist/IAO-linux-x64/IAO',
    'fi',
    ''
  ].join('\n'));
  fs.chmodSync(path.join(bin, 'npm'), 0o755);
  return { dir, project, home, bin, log };
}

function run(ctx, args) {
  const r = spawnSync('bash', [path.join(ctx.project, 'install.sh')].concat(args || []), {
    cwd: ctx.project,
    encoding: 'utf8',
    env: Object.assign({}, process.env, {
      HOME: ctx.home,
      PATH: ctx.bin + path.delimiter + process.env.PATH
    })
  });
  assert.strictEqual(r.status, 0, 'install.sh a échoué :\n' + r.stdout + r.stderr);
  return r.stdout;
}

function npmCalls(ctx) {
  return fs.existsSync(ctx.log) ? fs.readFileSync(ctx.log, 'utf8').trim().split('\n') : [];
}

// Recule l'horloge des sources pour que le build les précède nettement.
function age(ctx, rel, seconds) {
  const t = Date.now() / 1000 - seconds;
  fs.utimesSync(path.join(ctx.project, rel), t, t);
}

function cleanup(ctx) {
  fs.rmSync(ctx.dir, { recursive: true, force: true });
}

test('install.sh : sans build, installe les dépendances puis construit', { skip }, () => {
  const ctx = makeProject();
  try {
    const out = run(ctx);
    assert.deepStrictEqual(npmCalls(ctx), ['install', 'run dist:linux']);
    assert.match(out, /Aucun build trouvé/);
    assert.ok(fs.existsSync(path.join(ctx.home, '.local/opt/iao/IAO')), 'application non copiée');
    assert.ok(fs.existsSync(path.join(ctx.home, '.local/bin/iao')), 'lanceur absent');
  } finally { cleanup(ctx); }
});

test('install.sh : build à jour → réinstallé sans reconstruction', { skip }, () => {
  const ctx = makeProject();
  try {
    for (const f of ['main.js', 'index.html', 'package-lock.json']) age(ctx, f, 60);
    run(ctx);
    const out = run(ctx);
    assert.deepStrictEqual(npmCalls(ctx), ['install', 'run dist:linux'], 'reconstruction inutile');
    assert.doesNotMatch(out, /périmé/);
  } finally { cleanup(ctx); }
});

test('install.sh : source plus récente que le build (git pull) → reconstruit (issue #165)', { skip }, () => {
  const ctx = makeProject();
  try {
    for (const f of ['main.js', 'index.html', 'package-lock.json']) age(ctx, f, 60);
    run(ctx);
    fs.writeFileSync(path.join(ctx.project, 'index.html'), '<!-- v2 -->\n');
    const t = Date.now() / 1000 + 5;
    fs.utimesSync(path.join(ctx.project, 'index.html'), t, t);
    const out = run(ctx);
    assert.match(out, /Build périmé : index\.html/);
    assert.deepStrictEqual(npmCalls(ctx), ['install', 'run dist:linux', 'run dist:linux'],
      'npm install relancé alors que package-lock.json est inchangé');
  } finally { cleanup(ctx); }
});

test('install.sh : package-lock.json modifié → npm install puis reconstruction', { skip }, () => {
  const ctx = makeProject();
  try {
    for (const f of ['main.js', 'index.html', 'package-lock.json']) age(ctx, f, 60);
    run(ctx);
    age(ctx, 'node_modules/.package-lock.json', 30);
    age(ctx, 'dist/IAO-linux-x64/IAO', 30);
    age(ctx, 'package-lock.json', 1);
    run(ctx);
    assert.deepStrictEqual(npmCalls(ctx), ['install', 'run dist:linux', 'install', 'run dist:linux']);
  } finally { cleanup(ctx); }
});

test('install.sh : --no-build garde le build périmé, --rebuild force la construction', { skip }, () => {
  const ctx = makeProject();
  try {
    for (const f of ['main.js', 'index.html', 'package-lock.json']) age(ctx, f, 60);
    run(ctx);
    const t = Date.now() / 1000 + 5;
    fs.utimesSync(path.join(ctx.project, 'main.js'), t, t);
    run(ctx, ['--no-build']);
    assert.deepStrictEqual(npmCalls(ctx), ['install', 'run dist:linux'], '--no-build a reconstruit');
    age(ctx, 'main.js', 60);
    const out = run(ctx, ['--rebuild']);
    assert.match(out, /Reconstruction demandée/);
    assert.deepStrictEqual(npmCalls(ctx), ['install', 'run dist:linux', 'run dist:linux']);
  } finally { cleanup(ctx); }
});
