'use strict';

// Garde-fou structurel de la CSP (lot 18/09/2026) : index.html ne doit plus
// contenir NI script inline NI gestionnaire d'événement inline (une CSP
// `script-src 'self'` les bloquerait), la balise CSP doit être présente, et
// la table UI_ACTIONS d'assets/app.js doit couvrir exactement les
// data-action="ui-*" posés dans le HTML.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const appJs = fs.readFileSync(path.join(ROOT, 'assets', 'app.js'), 'utf8');

// --- CSP présente ---------------------------------------------------------

test('index.html déclare une CSP stricte (meta http-equiv)', () => {
  const m = /<meta http-equiv="Content-Security-Policy" content="([^"]*)">/.exec(html);
  assert.ok(m, 'balise <meta http-equiv="Content-Security-Policy"> absente');
  const csp = m[1];
  assert.ok(csp.includes("default-src 'none'"), "default-src 'none' absent : " + csp);
  assert.ok(csp.includes("script-src 'self'"), "script-src 'self' absent : " + csp);
  assert.ok(!/script-src[^;]*unsafe-inline/.test(csp),
    "script-src ne doit PAS contenir 'unsafe-inline'");
  // Lot 9 : style-src 'unsafe-inline' subsiste uniquement pour Monaco Editor,
  // qui crée des éléments avec style="..." en interne. Notre propre code n'utilise
  // plus aucun style inline (vérifié par le test dédié ci-dessous).
  assert.ok(csp.includes("style-src 'self'"), "style-src 'self' absent : " + csp);
  assert.ok(csp.includes("font-src 'self'"), "font-src 'self' absent : " + csp);
  assert.ok(csp.includes("img-src 'self' data:"), "img-src 'self' data: absent : " + csp);
  assert.ok(csp.includes("worker-src 'self' blob:"),
    "worker-src 'self' blob: absent (requis par les workers Monaco) : " + csp);
});

// --- Aucun script inline -------------------------------------------------

test('index.html ne contient aucun <script> inline (tous ont un src)', () => {
  const scripts = html.match(/<script\b[^>]*>/g) || [];
  assert.ok(scripts.length > 0, 'aucune balise <script> trouvée');
  scripts.forEach(tag => {
    assert.ok(/\ssrc=/.test(tag), 'balise <script> sans src : ' + tag);
  });
});

test('index.html ne contient aucun gestionnaire inline (onclick, oninput, onerror…)', () => {
  const handlers = html.match(/\son[a-z]+\s*=\s*["']/g) || [];
  assert.deepEqual(handlers, [], 'gestionnaires inline trouvés : ' + JSON.stringify(handlers));
});

test('index.html ne référence aucun javascript: ni aucune URL distante (http/https) dans les attributs', () => {
  assert.ok(!/javascript:/i.test(html), 'pseudo-URL javascript: trouvée');
  const srcs = html.match(/(?:src|href)="([^"]*)"/g) || [];
  srcs.forEach(attr => {
    const url = attr.slice(attr.indexOf('=') + 2, -1);
    assert.ok(!/^https?:\/\//i.test(url), 'URL distante référencée : ' + attr);
  });
});

// --- Fichiers extraits ----------------------------------------------------

test('assets/app.js et assets/pre-monaco.js existent et ne sont pas vides', () => {
  ['app.js', 'pre-monaco.js'].forEach(f => {
    const p = path.join(ROOT, 'assets', f);
    assert.ok(fs.existsSync(p), f + ' absent');
    const stat = fs.statSync(p);
    const min = f === 'app.js' ? 10000 : 100;
    assert.ok(stat.size > min, f + ' suspectement petit (' + stat.size + ' octets, min ' + min + ')');
  });
});

test('ordre de chargement : pre-monaco.js AVANT loader.js AVANT app.js', () => {
  // On cherche les BALISES <script src>, pas la première mention du nom
  // (le commentaire CSP en tête d'index.html cite aussi ces fichiers).
  const iPre = html.indexOf('<script src="assets/pre-monaco.js"');
  const iLoader = html.indexOf('<script src="node_modules/monaco-editor/min/vs/loader.js"');
  const iApp = html.indexOf('<script src="assets/app.js"');
  assert.ok(iPre !== -1, 'pre-monaco.js non référencé');
  assert.ok(iLoader !== -1, 'loader.js non référencé');
  assert.ok(iApp !== -1, 'app.js non référencé');
  assert.ok(iPre < iLoader, 'pre-monaco.js doit précéder loader.js');
  assert.ok(iLoader < iApp, 'loader.js doit précéder app.js');
});

test('assets/pre-monaco.js ne sauvegarde plus window.__iaoNodeRequire (issue #4)', () => {
  const pre = fs.readFileSync(path.join(ROOT, 'assets', 'pre-monaco.js'), 'utf8');
  assert.ok(!pre.includes('window.__iaoNodeRequire = window.require'),
    'pre-monaco.js ne doit plus sauvegarder window.require (contextIsolation: true)');
});

test('assets/app.js ne contient plus nodeRequire (issue #4 : contextIsolation)', () => {
  assert.ok(!appJs.includes('nodeRequire('),
    'app.js ne doit plus contenir d\'appel nodeRequire() (contextIsolation: true)');
  assert.ok(!appJs.includes('__iaoNodeRequire'),
    'app.js ne doit plus faire référence à __iaoNodeRequire');
});

// --- Cohérence data-action ↔ UI_ACTIONS -----------------------------------

test('chaque data-action="ui-*" du HTML a une entrée dans UI_ACTIONS (app.js), et réciproquement', () => {
  const mapMatch = /const UI_ACTIONS = \{([\s\S]*?)\};/.exec(appJs);
  assert.ok(mapMatch, 'table UI_ACTIONS introuvable dans assets/app.js');
  const mapKeys = new Set(
    Array.from(mapMatch[1].matchAll(/'([^']+)'\s*:/g), m => m[1])
  );

  const htmlActions = new Set(
    Array.from(html.matchAll(/data-action="(ui-[^"]+)"/g), m => m[1])
  );

  assert.ok(htmlActions.size > 0, 'aucun data-action="ui-*" dans le HTML');

  for (const a of htmlActions) {
    assert.ok(mapKeys.has(a), 'action "' + a + '" posée dans le HTML mais absente de UI_ACTIONS');
  }
  for (const k of mapKeys) {
    assert.ok(htmlActions.has(k), 'entrée UI_ACTIONS "' + k + '" jamais utilisée dans le HTML');
  }
});

test('chaque data-input-action du HTML a une entrée dans INPUT_ACTIONS (app.js), et réciproquement', () => {
  const mapMatch = /const INPUT_ACTIONS = \{([\s\S]*?)\};/.exec(appJs);
  assert.ok(mapMatch, 'table INPUT_ACTIONS introuvable dans assets/app.js');
  const mapKeys = new Set(
    Array.from(mapMatch[1].matchAll(/'([^']+)'\s*:/g), m => m[1])
  );

  const htmlActions = new Set(
    Array.from(html.matchAll(/data-input-action="([^"]+)"/g), m => m[1])
  );

  for (const a of htmlActions) {
    assert.ok(mapKeys.has(a), 'action "' + a + '" posée dans le HTML mais absente de INPUT_ACTIONS');
  }
  for (const k of mapKeys) {
    assert.ok(htmlActions.has(k), 'entrée INPUT_ACTIONS "' + k + '" jamais utilisée dans le HTML');
  }
});

test('les actions sched-* ne passent pas par UI_ACTIONS (délégations séparées)', () => {
  const mapMatch = /const UI_ACTIONS = \{([\s\S]*?)\};/.exec(appJs);
  const mapKeys = Array.from(mapMatch[1].matchAll(/'([^']+)'\s*:/g), m => m[1]);
  const schedEntries = mapKeys.filter(k => !k.startsWith('ui-'));
  assert.deepEqual(schedEntries, [],
    'UI_ACTIONS contient des entrées non "ui-*" : ' + JSON.stringify(schedEntries));
});

test('index.html ne contient aucun attribut style="..." inline (hors commentaires)', () => {
  // Lot 9 (18/09/2026) : tous les styles inline ont été migrés vers des classes CSS.
  // La CSP style-src 'self' (sans 'unsafe-inline') bloquerait tout attribut style restant.
  // On retire d'abord les commentaires HTML multi-lignes avant de chercher.
  const stripped = html.replace(/<!--[\s\S]*?-->/g, '');
  const lines = stripped.split('\n');
  const violations = [];
  lines.forEach((line, i) => {
    if (/\bstyle="[^"]*"/.test(line)) {
      violations.push('ligne ' + (i + 1) + ' : ' + line.trim().slice(0, 80));
    }
  });
  assert.deepEqual(violations, [],
    'attributs style="..." inline restants dans index.html (doivent être migrés vers des classes CSS) :\n' + violations.join('\n'));
});

// --- Extraction CSS (lot 8, 18/09/2026) -----------------------------------

const cssPath = path.join(ROOT, 'assets', 'app.css');

test('assets/app.css existe et n\'est pas vide', () => {
  assert.ok(fs.existsSync(cssPath), 'assets/app.css absent');
  const stat = fs.statSync(cssPath);
  assert.ok(stat.size > 5000, 'app.css suspectement petit (' + stat.size + ' octets)');
});

test('index.html référence app.css via <link rel="stylesheet">', () => {
  assert.ok(/<link\s+rel="stylesheet"\s+href="assets\/app\.css"/.test(html),
    'balise <link rel="stylesheet" href="assets/app.css"> absente');
});

test('index.html ne contient plus de bloc <style>', () => {
  assert.ok(!/<style[\s>]/.test(html), 'balise <style> encore présente dans index.html');
  assert.ok(!/<\/style>/.test(html), 'balise </style> encore présente dans index.html');
});

test('assets/app.css référence les polices avec des chemins relatifs à assets/', () => {
  const css = fs.readFileSync(cssPath, 'utf8');
  const fontUrls = Array.from(css.matchAll(/url\("([^"]+)"\)/g), m => m[1]);
  assert.ok(fontUrls.length >= 6, 'moins de 6 @font-face dans app.css (' + fontUrls.length + ')');
  fontUrls.forEach(u => {
    assert.ok(u.startsWith('fonts/'),
      'chemin de police non relatif à assets/ : ' + u + ' (doit commencer par fonts/)');
  });
});

test('chaque police référencée dans app.css pointe vers un fichier existant', () => {
  const css = fs.readFileSync(cssPath, 'utf8');
  const fontUrls = Array.from(css.matchAll(/url\("([^"]+)"\)/g), m => m[1]);
  fontUrls.forEach(u => {
    const fontPath = path.join(ROOT, 'assets', u);
    assert.ok(fs.existsSync(fontPath), 'fichier de police manquant : ' + u + ' (attendu dans assets/' + u + ')');
  });
});

test('assets/app.css contient les variables de thème (:root)', () => {
  const css = fs.readFileSync(cssPath, 'utf8');
  assert.ok(/:root\s*\{/.test(css), 'bloc :root absent de app.css');
  assert.ok(/--accent:/.test(css), 'variable --accent absente de app.css');
  assert.ok(/--rose:/.test(css), 'variable --rose absente de app.css');
});

// --- Exclusions Monaco dans build.files (lot 8, P3) -----------------------

test('package.json build.files exclut les dossiers Monaco inutiles au runtime', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const files = pkg.build.files;
  assert.ok(Array.isArray(files), 'build.files n\'est pas un tableau');
  const joined = files.join('\n');
  const required = [
    'monaco-editor/dev/**',
    'monaco-editor/esm/**',
    'monaco-editor/min-maps/**',
    'editor.main.nls.*.js'
  ];
  required.forEach(pat => {
    assert.ok(joined.includes(pat),
      'motif d\'exclusion Monaco manquant dans build.files : ' + pat);
  });
});

// --- Migration styles inline (lot 9, 18/09/2026) --------------------------

test('assets/app.js ne contient aucun element.style.cssText (bloqué par CSP sans unsafe-inline)', () => {
  assert.ok(!/\.style\.cssText\s*=/.test(appJs),
    'app.js contient encore .style.cssText = ... (bloqué par CSP style-src self sans unsafe-inline)');
});

test('assets/app.js contient la fonction applyDataColors pour les couleurs dynamiques', () => {
  assert.ok(/function applyDataColors\s*\(/.test(appJs),
    'fonction applyDataColors absente de app.js (requis pour les couleurs dynamiques sans style inline)');
});

test('assets/app.css contient les classes utilitaires du lot 9', () => {
  const css = fs.readFileSync(cssPath, 'utf8');
  const required = ['.btn--danger', '.settings-body', '.sched-section-label', '.explorer-header', '.modal--confirm'];
  required.forEach(cls => {
    assert.ok(css.includes(cls), 'classe CSS manquante dans app.css : ' + cls);
  });
});

// --- install.bat (lot 9, 18/09/2026) ---------------------------------------

const installBatPath = path.join(ROOT, 'install.bat');

test('install.bat existe a la racine du projet', () => {
  assert.ok(fs.existsSync(installBatPath), 'install.bat absent de la racine du projet');
  const stat = fs.statSync(installBatPath);
  assert.ok(stat.size > 1000, 'install.bat suspectement petit (' + stat.size + ' octets)');
});

test('install.bat contient les fonctionnalites documentees', () => {
  const bat = fs.readFileSync(installBatPath, 'utf8');
  // Options requises
  assert.ok(/\/system/i.test(bat), 'install.bat : option /system absente');
  assert.ok(/\/uninstall/i.test(bat), 'install.bat : option /uninstall absente');
  assert.ok(/\/desktop/i.test(bat), 'install.bat : option /desktop absente');
  assert.ok(/\/help/i.test(bat), 'install.bat : option /help absente');
  // Chemins cibles
  assert.ok(/IAO-win32-x64/.test(bat), 'install.bat : reference dist\IAO-win32-x64 absente');
  assert.ok(/IAO\.exe/.test(bat), 'install.bat : reference IAO.exe absente');
  assert.ok(/Programs\\IAO/.test(bat), 'install.bat : chemin %LOCALAPPDATA%\\Programs\\IAO absent');
  // robocopy /MIR
  assert.ok(/robocopy.*\/MIR/i.test(bat), 'install.bat : robocopy /MIR absent');
  // Raccourcis via WScript.Shell
  assert.ok(/WScript\.Shell/.test(bat), 'install.bat : WScript.Shell absent (creation de raccourcis)');
  // Preservation des donnees utilisateur
  assert.ok(/ai-manager/.test(bat), 'install.bat : reference %APPDATA%\\ai-manager absente');
  assert.ok(/PRESERVE|preserve|ne sont JAMAIS/i.test(bat), 'install.bat : pas de mention de preservation des donnees');
  // Desinstallation ne supprime pas les donnees
  assert.ok(!/rmdir.*ai-manager/i.test(bat) || /ne JAMAIS|PRESERVE/i.test(bat),
    'install.bat : la desinstallation ne doit pas supprimer %APPDATA%\\ai-manager');
  // Auto-build si dist absent (lot 10)
  assert.ok(/npm install/.test(bat), 'install.bat : auto-build npm install absent');
  assert.ok(/dist:win/.test(bat), 'install.bat : reference dist:win absente');
});

test('install.bat : PATH utilisateur lu et ecrit dans le registre, sans setx (issue #3)', () => {
  const bat = fs.readFileSync(installBatPath, 'utf8');
  // setx PATH "%PATH%;..." recopie le PATH systeme dans le PATH utilisateur
  // et le tronque a 1024 caracteres.
  assert.ok(!/setx\s+PATH/i.test(bat), 'install.bat : setx PATH ne doit plus etre utilise');
  assert.ok(/GetEnvironmentVariable\('Path', 'User'\)/.test(bat), 'install.bat : lecture du PATH utilisateur absente');
  assert.ok(/call :path_user remove/.test(bat), 'install.bat : /uninstall doit retirer IAO du PATH utilisateur');
  assert.ok(/GetFolderPath\('Desktop'\)/.test(bat), 'install.bat : Bureau redirige (OneDrive) non gere');
});

test('recette Windows : workflow et script de controle presents (issue #3)', () => {
  const wf = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'install-windows.yml'), 'utf8');
  assert.ok(/runs-on:\s*windows-latest/.test(wf), 'install-windows.yml : runner windows-latest attendu');
  assert.ok(/test-install-windows\.ps1/.test(wf), 'install-windows.yml : script de recette non appele');
  const ps = fs.readFileSync(path.join(ROOT, 'scripts', 'test-install-windows.ps1'), 'utf8');
  for (const opt of ['/desktop', '/system', '/uninstall', '/help']) {
    assert.ok(ps.indexOf("Lancer '" + opt) !== -1, 'test-install-windows.ps1 : scenario ' + opt + ' absent');
  }
  assert.ok(/PRESERVE/.test(ps), 'test-install-windows.ps1 : controle de preservation des donnees absent');
});

test('index.html ne contient aucun attribut class duplique sur un meme element', () => {
  // Lot 10 (18/09/2026) : deux attributs class sur le meme element sont invalides
  // en HTML5 (seul le premier est pris en compte par le navigateur).
  const stripped = html.replace(/<!--[\s\S]*?-->/g, '');
  const dupPattern = /<\w+\s[^>]*\bclass="[^"]*"[^>]*\bclass="[^"]*"/g;
  const matches = stripped.match(dupPattern) || [];
  assert.deepEqual(matches, [],
    'attributs class dupliques sur un meme element dans index.html :\n' + matches.join('\n'));
});

test('assets/app.js ne contient aucun attribut class duplique sur un meme element', () => {
  // Lot 10 : meme verification pour les templates JS
  const dupPattern = /<\w+\s[^>]*\bclass="[^"]*"[^>]*\bclass="[^"]*"/g;
  const matches = appJs.match(dupPattern) || [];
  assert.deepEqual(matches, [],
    'attributs class dupliques sur un meme element dans app.js :\n' + matches.join('\n'));
});
