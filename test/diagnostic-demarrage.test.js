'use strict';

// Script de diagnostic de démarrage (issues #52, #58, #59, #184) : présence,
// syntaxe bash et exécution en mode --sans-lancer dans un dossier isolé.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'diagnostic-demarrage.sh');

test('diagnostic-demarrage.sh : présent, exécutable, syntaxe bash valide', () => {
  assert.ok(fs.existsSync(SCRIPT));
  assert.ok((fs.statSync(SCRIPT).mode & 0o111) !== 0, 'le script doit être exécutable');
  execFileSync('bash', ['-n', SCRIPT]);
});

test('diagnostic-demarrage.sh --sans-lancer : rapport Markdown, droits et compteurs', () => {
  const xdg = fs.mkdtempSync(path.join(os.tmpdir(), 'iao-diag-'));
  const logs = path.join(xdg, 'ai-manager', 'logs');
  fs.mkdirSync(logs, { recursive: true });
  fs.writeFileSync(path.join(logs, 'iao.log'),
    'interface chargée\nFailed to delete the database: Database IO error\nFailed to delete the database: Database IO error\n');
  const out = execFileSync('bash', [SCRIPT, '--sans-lancer'], {
    env: { ...process.env, XDG_CONFIG_HOME: xdg }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
  });
  assert.match(out, /## Diagnostic de démarrage IAO/);
  assert.match(out, /Nombre : \*\*0\*\*/);
  assert.match(out, /« Failed to delete the database » \(iao\.log\) \| 2 \|/);
  assert.match(out, /Démarrages journalisés \(iao\.log\) \| 1 \|/);
  fs.rmSync(xdg, { recursive: true, force: true });
});

// --publier <n> (issue #58) : un faux gh enregistre ses arguments.
function fauxGh(dossier, connecte) {
  const trace = path.join(dossier, 'gh.trace');
  const gh = path.join(dossier, 'gh');
  fs.writeFileSync(gh, '#!/usr/bin/env bash\n' +
    'if [ "$1 $2" = "auth status" ]; then exit ' + (connecte ? 0 : 1) + '; fi\n' +
    'echo "$@" >> "' + trace + '"\n' +
    'if [ "$1 $2" = "issue comment" ]; then grep -q "Diagnostic de démarrage" "$7" && echo FICHIER_OK >> "' + trace + '"; fi\nexit 0\n');
  fs.chmodSync(gh, 0o755);
  return { gh, trace };
}

function lancer(args, env) {
  const xdg = fs.mkdtempSync(path.join(os.tmpdir(), 'iao-diag-'));
  try {
    const r = require('child_process').spawnSync('bash', [SCRIPT, '--sans-lancer', ...args], {
      env: { ...process.env, XDG_CONFIG_HOME: xdg, ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
    });
    return r;
  } finally {
    fs.rmSync(xdg, { recursive: true, force: true });
  }
}

test('diagnostic-demarrage.sh : section carte graphique (#52)', () => {
  const r = lancer([], {});
  assert.equal(r.status, 0);
  assert.match(r.stdout, /### Carte graphique/);
  assert.match(r.stdout, /LIBVA_DRIVER_NAME=/);
  assert.match(r.stderr, /--publier <n>/);
});

test('diagnostic-demarrage.sh --publier : confirmation -> gh issue comment avec le rapport', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'iao-gh-'));
  const { gh, trace } = fauxGh(d, true);
  const r = lancer(['--publier', '58'], { IAO_DIAG_GH: gh, IAO_DIAG_CONFIRMER: 'o' });
  assert.equal(r.status, 0, r.stderr);
  const t = fs.readFileSync(trace, 'utf8');
  assert.match(t, /^issue comment 58 -R Mathilde-Team\/IAO -F \/tmp\/iao-diagnostic-/m);
  assert.match(t, /FICHIER_OK/);
  assert.match(r.stderr, /Rapport publié dans l'issue #58/);
  fs.rmSync(d, { recursive: true, force: true });
});

test('diagnostic-demarrage.sh --publier : refus, gh non connecté, gh absent, échec', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'iao-gh-'));
  const ok = fauxGh(d, true);
  let r = lancer(['--publier', '59'], { IAO_DIAG_GH: ok.gh, IAO_DIAG_CONFIRMER: 'n' });
  assert.equal(r.status, 0);
  assert.match(r.stderr, /Rapport non publié/);
  assert.ok(!fs.existsSync(ok.trace), 'aucun commentaire sans confirmation');

  const d2 = fs.mkdtempSync(path.join(os.tmpdir(), 'iao-gh-'));
  const ko = fauxGh(d2, false);
  r = lancer(['--publier', '59'], { IAO_DIAG_GH: ko.gh, IAO_DIAG_CONFIRMER: 'o' });
  assert.equal(r.status, 0);
  assert.match(r.stderr, /gh n'est pas connecté/);

  r = lancer(['--publier', '59'], { IAO_DIAG_GH: path.join(d, 'inexistant') });
  assert.equal(r.status, 0);
  assert.match(r.stderr, /gh absent/);

  const echec = path.join(d, 'gh-echec');
  fs.writeFileSync(echec, '#!/usr/bin/env bash\n[ "$1" = auth ] && exit 0\nexit 1\n');
  fs.chmodSync(echec, 0o755);
  r = lancer(['--publier', '59'], { IAO_DIAG_GH: echec, IAO_DIAG_CONFIRMER: 'oui' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Publication impossible/);
  fs.rmSync(d, { recursive: true, force: true });
  fs.rmSync(d2, { recursive: true, force: true });
});

test('diagnostic-demarrage.sh : options invalides refusées (code 2)', () => {
  assert.equal(lancer(['--publier', 'abc'], {}).status, 2);
  assert.equal(lancer(['--publier'], {}).status, 2);
  const r = lancer(['--inconnue'], {});
  assert.equal(r.status, 2);
  assert.match(r.stderr, /Option inconnue/);
});
