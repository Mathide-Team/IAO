const { app, BrowserWindow, ipcMain, dialog, shell, session } = require('electron');
const path = require('path');
const fs = require('fs');
const fsPromises = fs.promises;

const { isAllowedPopup } = require('./lib/popup-guard');
const { Scheduler, registerSchedulerIPC } = require('./scheduler');

// On fixe le dossier de données (comptes + sessions IA) sur "ai-manager" quel que
// soit le nom du produit. Ainsi la version packagée (.exe) réutilise le profil
// existant au lieu d'en créer un vierge.
app.setPath('userData', path.join(app.getPath('appData'), 'ai-manager'));

// Nom applicatif stable : sous Linux, Electron s'en sert pour le WM_CLASS de la
// fenêtre. Le fichier .desktop déclare `StartupWMClass=IAO`, ce qui
// permet à GNOME/Ubuntu de rattacher la fenêtre ouverte à l'icône du Dock au
// lieu d'afficher une entrée « inconnue » séparée. (Sans effet sur Windows, et
// sans effet sur le dossier de données : userData est fixé juste au-dessus.)
app.setName('IAO');

// ===== Journal de démarrage et de diagnostic (issue #52) =====
// Avant : une erreur du preload ou du renderer ne laissait AUCUNE trace dans le
// terminal (seuls les messages de Chromium y défilaient) et rien du tout quand
// IAO était lancé depuis l'icône du Dock. Désormais chaque événement utile est
// écrit dans le terminal ET dans <userData>/logs/iao.log (tourné à 1 Mo).
// `--debug` (ou IAO_DEBUG=1) recopie en plus TOUS les messages console de la
// fenêtre principale, pas seulement warnings et erreurs.
const diag = require('./lib/startup-diagnostics');
const DEBUG = diag.isDebugEnabled(process.argv, process.env);
const debugTrace = require('./lib/debug-trace');
const LOG_DIR = path.join(app.getPath('userData'), 'logs');
const LOG_FILE = path.join(LOG_DIR, 'iao.log');
const LOG_MAX_BYTES = 1024 * 1024;
let logFileReady = false;

function prepareLogFile() {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    try {
      if (fs.statSync(LOG_FILE).size > LOG_MAX_BYTES) fs.renameSync(LOG_FILE, LOG_FILE + '.1');
    } catch (_) { /* pas encore de journal */ }
    logFileReady = true;
  } catch (e) {
    console.error('[demarrage] journal indisponible (' + LOG_FILE + ') :', e.message);
  }
}

function log(scope, level, message, sourceId, line) {
  const text = diag.formatLogLine(new Date(), scope, level, message, sourceId, line);
  const name = diag.consoleLevelName(level);
  if (name === 'error') console.error(text);
  else if (name === 'warning') console.warn(text);
  else console.log(text);
  if (logFileReady) {
    try { fs.appendFileSync(LOG_FILE, text + '\n', 'utf-8'); } catch (_) { /* disque plein : terminal seul */ }
  }
}

// Issue #162 : trace réservée au mode debug (--debug ou IAO_DEBUG=1).
function debug(scope, message) {
  if (DEBUG) log(scope, 'debug', message);
}

// Issue #162 : en mode debug, chaque appel IPC (main.js et ordonnanceur) est
// journalisé — canal, durée, succès ou erreur, jamais les arguments. Hors
// mode debug, `ipc` est ipcMain lui-même.
const ipc = debugTrace.traceIpcMain(ipcMain, { enabled: DEBUG, log });

// ===== Instance unique (issue #52) =====
// Deux IAO lancés en même temps se disputent le même dossier de données
// (localStorage, cookies des ~70 partitions, service workers). Chromium
// n'obtient alors pas les verrous de ses bases et inonde le terminal de
// « Failed to delete the database: Database IO error », avec une interface
// qui peut sembler vide. La 2e instance passe donc la main à la 1re (mise au
// premier plan) et s'arrête immédiatement.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  console.warn('[demarrage] IAO est déjà lancé : la fenêtre existante est mise au premier plan, cette instance s\'arrête.');
  app.quit();
} else {
  prepareLogFile();
  app.on('second-instance', () => {
    log('demarrage', 'info', 'Seconde instance demandée : mise au premier plan de la fenêtre existante.');
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

// ===== Durcissement navigation / popups (chantier B) =====
// La liste blanche ALLOWED_POPUP_HOSTS et isAllowedPopup() vivent désormais
// dans lib/popup-guard.js (chantier F) : extraction pure, testable via
// `node --test` sans lancer Electron. Comportement inchangé.

// N'expose que le host dans les logs : une URL d'auth complète peut contenir des
// tokens OAuth en query string qu'on n'a pas à écrire dans la console.
function hostOf(urlStr) {
  try { return new URL(urlStr).host; } catch (_) { return '(url illisible)'; }
}

// Taille max d'un fichier ouvrable dans l'éditeur intégré. Au-delà, lire le
// fichier entier en mémoire + le transférer par IPC figerait main ET renderer.
const MAX_EDITABLE_FILE_BYTES = 20 * 1024 * 1024; // 20 Mo

// ===== Ordonnanceur IA (chantier E) =====
// Instance unique, créée ici (module.getPath('userData') est déjà fixé plus
// haut) mais initialisée (watchers de téléchargement, journal de démarrage)
// seulement dans app.whenReady() : les sessions Electron par partition ne
// sont utilisables qu'une fois l'app prête. `mainWindow` sert d'ancrage aux
// boîtes de dialogue « Choisir un dossier » du panneau Ordonnanceur.
const scheduler = new Scheduler(app, session);
let mainWindow = null;

function createWindow() {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 600,
    backgroundColor: '#0a0c10',
    title: 'IAO',
    // Icône de fenêtre : utilisée par les environnements Linux (barre des tâches,
    // Alt+Tab) quand l'app tourne depuis les sources. Dans un build packagé,
    // l'icône est déjà embarquée par le packager — ce chemin reste valide.
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      webviewTag: true,
      // Issue #4 : contextIsolation: true + preload = le renderer n'a plus
      // accès direct à Node (require, ipcRenderer, fs…). Seules les APIs
      // exposées par preload.js (window.iaoAPI) sont disponibles.
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });
  // Issue #149 : la barre de menu native (File, Edit, View, Window) disparaît de
  // l'écran. Le menu reste l'application menu d'Electron : ses raccourcis
  // (Ctrl+Maj+I, Ctrl+R, zoom, copier/coller) fonctionnent toujours. Avec
  // autoHideMenuBar à false (défaut), la touche Alt ne la fait pas réapparaître,
  // ce qui compte ici : Alt+1..9 sert à changer d'onglet.
  win.setMenuBarVisibility(false);

  // --- 1. La fenêtre HÔTE est privilégiée (nodeIntegration:true). Elle ne doit
  // JAMAIS naviguer ailleurs que vers son index.html local : sinon un contenu
  // distant hériterait de l'accès complet à Node/OS. On bloque toute navigation
  // dont l'URL n'est pas un fichier local (le rechargement dev reste un file://).
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) {
      event.preventDefault();
      console.warn('[security] navigation de la fenêtre hôte bloquée :', hostOf(url));
    }
  });

  // --- 2. L'hôte ne doit ouvrir AUCUNE nouvelle fenêtre lui-même.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  // --- 3. Les <webview> sont des invités sandboxés (sans nodeIntegration). On
  // filtre leurs popups : seules les origines connues (services + auth OAuth)
  // peuvent ouvrir une fenêtre ; tout le reste est refusé. Une popup autorisée
  // s'ouvre avec les webPreferences de l'invité (donc SANS privilèges Node),
  // jamais avec ceux de l'hôte.
  win.webContents.on('did-attach-webview', (event, guestContents) => {
    guestContents.on('render-process-gone', (_e, details) => {
      log('webview', 'warning', 'onglet ' + hostOf(guestContents.getURL()) + ' arrêté : ' + details.reason);
    });
    // Issue #162 : en mode debug, navigations, échecs de chargement et
    // avertissements/erreurs console de chaque onglet IA (hôte seulement).
    debug('webview', 'onglet attaché : ' + hostOf(guestContents.getURL()));
    guestContents.on('did-navigate', (_e, url) => debug('webview', 'navigation → ' + hostOf(url)));
    guestContents.on('did-fail-load', (_e, code, description, url) => {
      debug('webview', 'échec de chargement ' + hostOf(url) + ' : ' + description + ' (' + code + ')');
    });
    guestContents.on('console-message', (ev) => {
      if (DEBUG && debugTrace.shouldForwardGuestConsole(ev.level)) {
        log('webview ' + hostOf(guestContents.getURL()), ev.level, ev.message, ev.sourceId, ev.lineNumber);
      }
    });
    guestContents.setWindowOpenHandler(({ url }) => {
      if (isAllowedPopup(url)) return { action: 'allow' };
      // Origine hors liste : jamais de fenêtre Electron. Si c'est un lien web
      // classique, on le confie au navigateur système (aucun privilège Node) ;
      // sinon (about:, data:, javascript:…) on refuse purement.
      if (/^https?:\/\//i.test(url)) {
        shell.openExternal(url);
        console.warn('[security] popup hors liste -> navigateur système :', hostOf(url));
      } else {
        console.warn('[security] popup refusée (schéma non web) :', hostOf(url));
      }
      return { action: 'deny' };
    });
    // Ordonnanceur (lot 18/09/2026) : enregistre le webContents de chaque
    // <webview> attachée pour que le scheduler puisse interagir avec Claude.ai
    // via executeJavaScript et CDP (points 7-8, 10-13).
    // Correctif du lot « test Electron réel du 18/09/2026 » : sur Electron 43,
    // guestContents.getWebPreferences() renvoie undefined pour un guest —
    // l'ancienne lecture directe de la partition échouait donc en silence et
    // AUCUNE webview n'était jamais enregistrée (automatisation Claude
    // inopérante). Le profil est désormais résolu par comparaison de session
    // (scheduler.resolveProfileFromSession, testée en réel par le harnais
    // test-electron/popups-continue.js — test B4).
    try {
      const profile = scheduler.resolveProfileFromSession(guestContents.session);
      if (profile) {
        scheduler.registerWebview(profile, guestContents);
        guestContents.on('destroyed', () => {
          try { scheduler.unregisterWebview(profile); } catch (_) {}
        });
      }
    } catch (e) {
      // Session non identifiable (webview sans partition connue) -> non enregistrée.
    }
  });

  // --- 4. Diagnostic (issue #52) : tout échec du preload, du chargement ou
  // du renderer de la fenêtre principale est journalisé (terminal + fichier).
  const wc = win.webContents;
  wc.on('preload-error', (_event, preloadPath, error) => {
    log('preload', 'error', 'échec de ' + path.basename(preloadPath) + ' : ' + diag.errorText(error) +
      ' — window.iaoAPI sera absent, l\'interface ne peut pas afficher les comptes.');
  });
  wc.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
    if (isMainFrame) log('renderer', 'error', 'chargement impossible de ' + url + ' : ' + description + ' (' + code + ')');
  });
  wc.on('render-process-gone', (_event, details) => {
    log('renderer', 'error', 'processus de rendu arrêté : ' + details.reason + ' (code ' + details.exitCode + ')');
  });
  wc.on('unresponsive', () => log('renderer', 'warning', 'la fenêtre ne répond plus'));
  wc.on('console-message', (event) => {
    // Electron >= 35 : un seul objet `event` (level, message, lineNumber,
    // sourceId). Déclarer des arguments positionnels déclenche un avertissement
    // de dépréciation : on ne lit que l'objet.
    if (diag.shouldForwardConsole(event.level, DEBUG)) {
      log('renderer', event.level, event.message, event.sourceId, event.lineNumber);
    }
  });
  wc.on('did-finish-load', () => log('demarrage', 'info', 'interface chargée (' + path.basename(wc.getURL()) + ').'));

  win.loadFile('index.html');
  mainWindow = win;
  win.on('closed', () => { if (mainWindow === win) mainWindow = null; });
}

// Issue #149 : les outils de développement passent du menu natif (masqué) à
// un bouton de la barre du workspace. Seule la fenêtre principale peut les
// ouvrir, et seulement pour elle-même : une <webview> invitée n'a pas accès
// à ce canal (preload non exposé), mais on vérifie l'émetteur par principe.
// Issue #162 : le renderer adapte ses traces (dbg) et affiche un badge.
ipc.handle('app:is-debug', () => DEBUG);

ipc.handle('app:toggle-devtools', (event) => {
  if (!mainWindow || event.sender !== mainWindow.webContents) return false;
  event.sender.toggleDevTools();
  return true;
});

// --- IPC pour la gestion des fichiers locaux ---

ipc.handle('select-folder', async () => {
  const result = await dialog.showOpenDialog({ properties: ['openDirectory'] });
  if (!result.canceled && result.filePaths.length > 0) return result.filePaths[0];
  return null;
});

ipc.handle('read-directory', async (event, folderPath) => {
  try {
    const files = await fsPromises.readdir(folderPath, { withFileTypes: true });
    const ignored = ['node_modules', '.git', '.next', 'dist', 'build', '.cache'];
    return files
      .filter(dirent => dirent.isFile() && !ignored.includes(dirent.name))
      .map(dirent => ({ name: dirent.name, path: path.join(folderPath, dirent.name) }));
  } catch (error) { return []; }
});

// Lot 18/09/2026 : lecture récursive (sous-dossiers) pour l'explorateur de
// fichiers. Renvoie une liste PLATE de fichiers avec chemin relatif au dossier
// racine, prête à être filtrée par filterFiles() côté renderer. Garde-fous :
//   - dossiers ignorés (node_modules, .git, .next, dist, build, .cache) ;
//   - pas de suivi des liens symboliques (évite les boucles) ;
//   - profondeur maximale 5 (évite de scanner tout un disque) ;
//   - nombre maximum de fichiers 500 (garde anti-saturation).
const MAX_RECURSION_DEPTH = 5;
const MAX_RECURSIVE_FILES = 500;
const IGNORED_DIRS = new Set(['node_modules', '.git', '.next', 'dist', 'build', '.cache']);

ipc.handle('read-directory-recursive', async (event, folderPath) => {
  const result = [];
  async function walk(dir, prefix, depth) {
    if (depth > MAX_RECURSION_DEPTH) return;
    // Pas de garde « result.length >= MAX » ici : la boucle ci-dessous la
    // teste avant chaque entrée, donc avant chaque appel récursif (branche
    // impossible à provoquer, retirée pour la couverture, #55).
    let entries;
    try { entries = await fsPromises.readdir(dir, { withFileTypes: true }); }
    catch (_) { return; }
    for (const dirent of entries) {
      if (result.length >= MAX_RECURSIVE_FILES) return;
      const name = dirent.name;
      if (dirent.isFile()) {
        const fullPath = path.join(dir, name);
        const rel = prefix ? prefix + '/' + name : name;
        result.push({ name, path: fullPath, relativePath: rel });
      } else if (dirent.isDirectory() && !IGNORED_DIRS.has(name) && !dirent.isSymbolicLink()) {
        await walk(path.join(dir, name), prefix ? prefix + '/' + name : name, depth + 1);
      }
    }
  }
  try { await walk(folderPath, '', 0); }
  catch (error) { /* retourne ce qu'on a déjà */ }
  return result;
});

ipc.handle('read-file', async (event, filePath) => {
  try {
    // Garde-fou taille : un gros fichier lu en entier figerait l'app. On renvoie
    // un objet-sentinel que le renderer sait distinguer d'un contenu texte.
    const stat = await fsPromises.stat(filePath);
    if (stat.size > MAX_EDITABLE_FILE_BYTES) {
      return { error: 'too_large', size: stat.size };
    }
    return await fsPromises.readFile(filePath, 'utf-8');
  } catch (error) { return null; }
});

// NOUVEAU : Sauvegarder un fichier depuis l'éditeur
ipc.handle('save-file', async (event, filePath, content) => {
  try {
    await fsPromises.writeFile(filePath, content, 'utf-8');
    return true;
  } catch (error) {
    console.error('Erreur sauvegarde:', error);
    return false;
  }
});

// --- IPC pour l'import/export JSON des comptes ---
// La sérialisation (exportAccountsJSON()/importAccountsJSON()) reste côté
// renderer (index.html, chantier C) : main.js ne fait ici que ce que le
// renderer ne peut pas faire lui-même (choix de fichier + lecture/écriture
// disque), sur le même modèle que 'read-file'/'save-file' plus haut.
ipc.handle('accounts:export', async (event, jsonContent) => {
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Exporter les comptes',
    defaultPath: `iao-comptes-${stamp}.json`,
    filters: [{ name: 'JSON', extensions: ['json'] }]
  });
  if (result.canceled || !result.filePath) return { canceled: true };
  try {
    await fsPromises.writeFile(result.filePath, jsonContent, 'utf-8');
    return { canceled: false, filePath: result.filePath };
  } catch (error) {
    console.error('Erreur export comptes:', error);
    return { canceled: false, error: 'write_failed' };
  }
});

ipc.handle('accounts:import', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Importer des comptes',
    properties: ['openFile'],
    filters: [{ name: 'JSON', extensions: ['json'] }]
  });
  if (result.canceled || result.filePaths.length === 0) return { canceled: true };
  try {
    const content = await fsPromises.readFile(result.filePaths[0], 'utf-8');
    return { canceled: false, filePath: result.filePaths[0], content };
  } catch (error) {
    console.error('Erreur import comptes:', error);
    return { canceled: false, error: 'read_failed' };
  }
});

// --- IPC pour la déconnexion d'un profil (lot « Actions sur un onglet
// ouvert », 17/09/2026) ---
// Purge cookies + stockage web de la partition Electron du compte (destructif,
// confirmé côté renderer avant l'appel — voir index.html, #disconnectModal).
// `session` n'existe que côté process principal, d'où l'IPC (comme pour les 4
// handlers fichiers ci-dessus). Un profil = un seul compte (invariant 4,
// CLAUDE.md), donc ceci ne peut jamais affecter qu'un compte à la fois.
ipc.handle('accounts:disconnect-profile', async (event, profile) => {
  if (!profile || typeof profile !== 'string') return { ok: false, error: 'invalid_profile' };
  try {
    const ses = session.fromPartition(`persist:${profile}`);
    await ses.clearStorageData();
    return { ok: true };
  } catch (error) {
    console.error('Erreur déconnexion profil:', error);
    return { ok: false, error: 'clear_failed' };
  }
});

// --- IPC pour les réglages utilisateur (lot 18/09/2026, FEATURES.md P2) ---
// Persistance dans <userData>/settings.json. La normalisation/validation est
// faite côté renderer via lib/settings.js (fonctions pures testées).
const { normalizeSettings, DEFAULT_SETTINGS } = require('./lib/settings');
const settingsPath = path.join(app.getPath('userData'), 'settings.json');

ipc.handle('settings:load', async () => {
  try {
    const raw = await fsPromises.readFile(settingsPath, 'utf-8');
    return normalizeSettings(JSON.parse(raw));
  } catch (_) {
    // Fichier inexistant ou illisible -> renvoyer les valeurs par défaut
    return DEFAULT_SETTINGS;
  }
});

ipc.handle('settings:save', async (event, rawSettings) => {
  try {
    const normalized = normalizeSettings(rawSettings);
    await fsPromises.writeFile(settingsPath, JSON.stringify(normalized, null, 2), 'utf-8');
    return { ok: true, settings: normalized };
  } catch (error) {
    console.error('Erreur sauvegarde réglages:', error);
    return { ok: false, error: error.message };
  }
});

// --- IPC pour l'ordonnanceur IA (chantier E) ---
registerSchedulerIPC(ipc, scheduler, () => mainWindow);

app.whenReady().then(() => {
  // 2e instance (voir « Instance unique ») : ne rien ouvrir, app.quit() est en cours.
  if (!gotSingleInstanceLock) return;
  log('demarrage', 'info', 'IAO ' + app.getVersion() + ' — Electron ' + process.versions.electron +
    ', ' + process.platform + '/' + process.arch + (app.isPackaged ? ', packagé' : ', sources') +
    (DEBUG ? ', mode debug' : '') + '. Données : ' + app.getPath('userData') + ' — journal : ' + LOG_FILE);
  debug('demarrage', debugTrace.describeRuntime(process));
  // Issue #162 : le journal d'activité de l'ordonnanceur rejoint iao.log, et
  // ses traces détaillées sont actives en mode debug.
  scheduler.setLogger(log, DEBUG);
  createWindow();
  scheduler.init();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});