'use strict';
// ---------------------------------------------------------------------------
// test-electron/smoke-packaged.js — test de FUMÉE du binaire PACKAGÉ
// (lot du 18/09/2026 : « build Electron local complet »).
//
// Usage (Linux, depuis la racine du projet, après `npm run dist:linux`) :
//   xvfb-run -a node test-electron/smoke-packaged.js
// Pour tester un AUTRE binaire packagé (extraction AppImage, .deb décompressé) :
//   SMOKE_APP_BINARY=/chemin/vers/ai-manager xvfb-run -a node test-electron/smoke-packaged.js
//
// Vérifie que l'application packagée par electron-packager
// (dist/IAO-linux-x64/IAO) démarre réellement :
//   1. le process reste vivant (pas de crash au lancement),
//   2. main.js s'exécute : le scheduler démarre et journalise
//      « Ordonnanceur démarré » (console + activity.json dans un userData
//      ISOLÉ via XDG_CONFIG_HOME temporaire),
//   3. le preload et l'interface se chargent (logs/iao.log, issue #52) ;
//   4. le process se termine proprement sur SIGTERM.
//
// Sortie : code 0 si tout passe, 1 sinon.
// ---------------------------------------------------------------------------

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const APP_BINARY = process.env.SMOKE_APP_BINARY ||
  path.join(__dirname, '..', 'dist', 'IAO-linux-x64', 'IAO');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  if (!fs.existsSync(APP_BINARY)) {
    console.error('Binaire packagé introuvable : ' + APP_BINARY);
    console.error('Lancez d\'abord `npm run dist:linux`.');
    process.exit(1);
  }

  // Environnement isolé : userData (= XDG_CONFIG_HOME/ai-manager) vierge pour
  // prouver que c'est bien LE BINAIRE PACKAGÉ qui écrit le journal.
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'iao-smoke-'));
  const tmpConfig = path.join(tmpHome, '.config');
  fs.mkdirSync(tmpConfig, { recursive: true });

  console.log('Lancement du binaire packagé : ' + APP_BINARY);
  const child = spawn(APP_BINARY, ['--no-sandbox'], {
    env: Object.assign({}, process.env, {
      HOME: tmpHome,
      XDG_CONFIG_HOME: tmpConfig
    }),
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let stdout = '';
  child.stdout.on('data', d => { stdout += d.toString(); });
  child.stderr.on('data', d => { stdout += d.toString(); });

  let crashed = false;
  child.on('exit', (code, signal) => {
    if (code !== null && code !== 0 && signal !== 'SIGTERM') crashed = true;
  });

  const activityPath = path.join(tmpConfig, 'ai-manager', 'scheduler', 'activity.json');
  let ok = true;

  // 1. Le process doit rester vivant au moins 8 s (pas de crash au boot).
  await sleep(8000);
  if (crashed || child.exitCode !== null) {
    console.error('ECHEC : le binaire packagé s\'est arrêté pendant le démarrage.');
    console.error(stdout.split('\n').slice(-30).join('\n'));
    process.exit(1);
  }
  console.log('ok - le process packagé reste vivant 8 s (pas de crash au boot)');

  // 2. Le scheduler a démarré et journalisé (console OU activity.json).
  await sleep(2000);
  const loggedInConsole = stdout.indexOf('Ordonnanceur démarré') !== -1;
  let loggedInActivity = false;
  try {
    const activity = fs.readFileSync(activityPath, 'utf-8');
    loggedInActivity = activity.indexOf('Ordonnanceur démarré') !== -1;
  } catch (e) { /* fichier pas encore écrit */ }
  if (!loggedInConsole && !loggedInActivity) {
    ok = false;
    console.error('ECHEC : « Ordonnanceur démarré » introuvable (console=' + loggedInConsole +
      ', activity.json=' + loggedInActivity + ')');
    console.error('Sortie du process (30 dernières lignes) :');
    console.error(stdout.split('\n').slice(-30).join('\n'));
  } else {
    console.log('ok - main.js exécuté : « Ordonnanceur démarré » journalisé (' +
      (loggedInConsole ? 'console' : 'activity.json') + ')');
  }

  // 2bis. Issue #52/#54 : le preload et l'interface se chargent DANS LE BINAIRE
  // PACKAGÉ. Le journal <userData>/logs/iao.log (issue #52) doit contenir
  // « interface chargée » et AUCUNE ligne [preload] error ni d'erreur de
  // démarrage du renderer (bandeau boot-guard). Un preload cassé (require
  // interdit en sandbox) laissait sinon passer ce test de fumée.
  const iaoLogPath = path.join(tmpConfig, 'ai-manager', 'logs', 'iao.log');
  let iaoLog = '';
  try { iaoLog = fs.readFileSync(iaoLogPath, 'utf-8'); } catch (e) { /* absent */ }
  const uiLoaded = iaoLog.indexOf('interface chargée') !== -1;
  const startupErrors = iaoLog.split('\n').filter(l =>
    /\[preload\] error|\[renderer\] error .*\[demarrage\]|chargement impossible|processus de rendu arrêté/.test(l));
  if (!uiLoaded || startupErrors.length > 0) {
    ok = false;
    console.error('ECHEC : interface non chargée proprement (journal ' + iaoLogPath + ', interface chargée=' + uiLoaded + ')');
    console.error((startupErrors.length ? startupErrors : iaoLog.split('\n').slice(-20)).join('\n'));
  } else {
    console.log('ok - preload et interface chargés dans le binaire packagé (logs/iao.log, aucune erreur de démarrage)');
  }

  // 3. Terminaison propre sur SIGTERM.
  await new Promise(resolve => {
    child.once('exit', resolve);
    child.kill('SIGTERM');
    setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) {} resolve(); }, 5000);
  });
  if (crashed) {
    ok = false;
    console.error('ECHEC : le process packagé s\'est arrêté en erreur.');
  } else {
    console.log('ok - terminaison propre sur SIGTERM');
  }

  // Nettoyage du HOME temporaire (best effort).
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch (e) {}

  process.exit(ok ? 0 : 1);
}

main().catch(e => { console.error('Erreur fatale du smoke test :', e); process.exit(1); });
