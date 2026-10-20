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
