'use strict';
// ---------------------------------------------------------------------------
// test-electron/ui-flows.js — harnais d'intégration Electron pour les flux UI
// non couverts par popups-continue.js.
//
// Cibles (issue #5) :
//   C1. Rendu du panneau comptes (renderAccounts) : cartes, boutons, escapeHtml
//   C2. Ajout/suppression de comptes via l'UI (data-action delegation)
//   C3. Bascule de thème (settings) : data-theme sur <html>
//   C4. Explorateur de fichiers : ouverture du panneau + rendu
//   C5. Restauration d'onglets au démarrage (serialize/deserialize)
//
// Usage :
//   xvfb-run -a npx electron --no-sandbox test-electron/ui-flows.js
//
// Mêmes contraintes que popups-continue.js : fixtures locales uniquement,
// aucun accès réseau.
// ---------------------------------------------------------------------------

const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const v8cov = require('./v8-coverage');

// Mesure optionnelle (issue #100) : IAO_COVERAGE=1 affiche la couverture V8 de
// assets/app.js. Purement informatif : n'affecte JAMAIS le code de sortie.
const MEASURE_COVERAGE = process.env.IAO_COVERAGE === '1';

// --- Mini framework de test (identique à popups-continue.js) ---------------
let passed = 0;
let failed = 0;
const failures = [];

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion échouée');
}

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log('ok - ' + name);
  } catch (e) {
    failed += 1;
    failures.push({ name: name, error: e });
    console.log('NOT OK - ' + name + ' : ' + (e && e.message ? e.message : e));
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

app.disableHardwareAcceleration();

// Garde-fou : 180 s (ces tests sont plus simples que popups-continue).
setTimeout(() => {
  console.error('TIMEOUT global du harnais UI (180 s) — abandon.');
  process.exit(2);
}, 180000);

async function run() {
  // =========================================================================
  // Préparation : environnement userData ISOLÉ + seed de comptes
  // =========================================================================
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iao-ui-'));
  app.setPath('appData', tmpRoot);
  app.setAppPath(path.join(__dirname, '..'));

  // Seed : 2 comptes dans localStorage (via le renderer au chargement)
  // On seed directement le localStorage en injectant du JS avant initApp.
  // Les comptes doivent être valides (migrateOldAccounts les complète).
  const seedAccounts = [
    {
      id: 'acc_test_1',
      name: 'Compte Test Un',
      email: 'test1@example.com',
      profile: 'profil_1',
      color: '#ffb347',
      services: ['claude', 'chatgpt', 'gemini'],
      cooldowns: { claude: 0, chatgpt: 0, gemini: 0, perplexity: 0, zeta: 0, grok: 0, leonardo: 0, suno: 0, meshy: 0 },
      automation: { enabled: true, lastUsedAt: 0, lastAutomationAt: 0 }
    },
    {
      id: 'acc_test_2',
      name: '<script>alert(1)</script>', // Test escapeHtml
      email: 'test2@example.com',
      profile: 'profil_2',
      color: '#8b5cf6',
      services: ['claude', 'perplexity'],
      cooldowns: { claude: 0, chatgpt: 0, gemini: 0, perplexity: 0, zeta: 0, grok: 0, leonardo: 0, suno: 0, meshy: 0 },
      automation: { enabled: true, lastUsedAt: 0, lastAutomationAt: 0 }
    }
  ];

  // Seed onglets persistés (pour le test de restauration)
  const seedTabs = [
    { accId: 'acc_test_1', svcId: 'claude' },
    { accId: 'acc_test_1', svcId: 'chatgpt' }
  ];

  // Créer un dossier de test pour l'explorateur
  const testDir = path.join(tmpRoot, 'test-folder');
  fs.mkdirSync(testDir, { recursive: true });
  fs.writeFileSync(path.join(testDir, 'test-file.txt'), 'Hello IAO', 'utf-8');
  fs.mkdirSync(path.join(testDir, 'subfolder'), { recursive: true });
  fs.writeFileSync(path.join(testDir, 'subfolder', 'nested.js'), 'console.log("nested")', 'utf-8');

  // Stub shell.openExternal
  try {
    const shell = require('electron').shell;
    shell.openExternal = function () { return Promise.resolve(); };
  } catch (e) { /* best-effort */ }

  // Aucun accès réseau (issue #54) : ouvrir un service crée une <webview> vers
  // https://claude.ai… — on annule toute requête http(s) dans TOUTES les
  // sessions (défaut + partitions persist:profil_N), la webview reste vide.
  const blockNetwork = (ses) => {
    ses.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_d, cb) => cb({ cancel: true }));
  };
  app.on('session-created', blockNetwork);

  // Chargement de l'application RÉELLE
  require('../main.js');

  let win = null;
  for (let i = 0; i < 150 && !win; i++) {
    win = BrowserWindow.getAllWindows().find(w => {
      try { return !w.isDestroyed() && w.webContents.getURL().endsWith('index.html'); }
      catch (e) { return false; }
    });
    if (!win) await sleep(100);
  }
  assert(win, 'fenêtre principale jamais créée');

  const waitLoaded = async () => {
    for (let i = 0; i < 100; i++) {
      if (!win.webContents.isLoading()) break;
      await sleep(100);
    }
    await sleep(800); // initApp + loadSettings (IPC asynchrone)
  };
  await waitLoaded();

  // Utilitaire : exécuter du JS dans le renderer
  const exec = (script) => win.webContents.executeJavaScript(script);

  // Utilitaire : IPC via le pont du preload (issue #4 : plus de module.require
  // dans le renderer, contextIsolation: true).
  const ipc = (channel, ...args) => exec(
    'window.iaoAPI.ipcInvoke(' + JSON.stringify(channel) +
    (args.length ? ', ' + args.map(a => JSON.stringify(a)).join(', ') : '') + ')'
  );

  // Seed : initApp lit localStorage AU DÉMARRAGE -> on écrit puis on RECHARGE
  // la page (renderAccounts n'est pas exposée globalement, à dessein).
  // startWithLastSession est activé pour tester la restauration des onglets.
  const saved = await ipc('settings:save', { startWithLastSession: true });
  assert(saved && saved.ok, 'settings:save a échoué : ' + JSON.stringify(saved));
  await exec(`
    localStorage.setItem('ai_accounts', ${JSON.stringify(JSON.stringify(seedAccounts))});
    localStorage.setItem('ai_open_tabs', ${JSON.stringify(JSON.stringify(seedTabs))});
    'injected'
  `);
  if (MEASURE_COVERAGE) {
    try { await v8cov.startCoverage(win.webContents); }
    catch (e) { console.log('COV démarrage impossible : ' + e.message); }
  }
  win.webContents.reload();
  await sleep(300);
  await waitLoaded();

  // =========================================================================
  // C0 — Démarrage sain (issue #52)
  // =========================================================================
  console.log('\n--- C0 : Démarrage ---');

  await test('C0.1 le preload est chargé (window.iaoAPI) et aucun bandeau d\'erreur', async () => {
    assert(await exec('typeof window.iaoAPI === "object"'), 'window.iaoAPI absent : preload non exécuté');
    assert(await exec('document.getElementById("bootError") === null'), 'bandeau d\'erreur de démarrage affiché');
  });

  await test('C0.2 toutes les icônes statiques sont hydratées (SVG)', async () => {
    const r = await exec(`({ total: document.querySelectorAll('span.ic[data-icon]').length,
      done: document.querySelectorAll('span.ic[data-icon] svg').length })`);
    assert(r.total > 0, 'aucune icône dans la page');
    assert(r.done === r.total, 'icônes non hydratées : ' + r.done + '/' + r.total);
  });

  // =========================================================================
  // C1 — Rendu du panneau comptes
  // =========================================================================
  console.log('\n--- C1 : Rendu du panneau comptes ---');

  await test('C1.1 renderAccounts affiche 2 cartes de comptes', async () => {
    const count = await exec('document.querySelectorAll(\'#accountsList .account-card\').length');
    assert(count === 2, 'attendu 2 cartes, trouvé ' + count);
  });

  await test('C1.2 Le nom du compte est échappé (escapeHtml — pas de <script>)', async () => {
    const r = await exec(`(() => {
      const list = document.getElementById('accountsList');
      return { scripts: list.querySelectorAll('script').length,
               escaped: list.textContent.indexOf('<script>alert(1)</script>') !== -1 };
    })()`);
    assert(r.scripts === 0, 'un élément <script> a été injecté dans la liste des comptes');
    assert(r.escaped, 'le nom « <script>… » n\'est pas affiché tel quel (texte échappé)');
  });

  await test('C1.3 Chaque carte a des boutons de service (data-action)', async () => {
    const cards = await exec('document.querySelectorAll(\'#accountsList .account-card\').length');
    assert(cards > 0, 'aucune carte');
    for (let i = 0; i < cards; i++) {
      const btns = await exec(`document.querySelectorAll('#accountsList .account-card')[${i}].querySelectorAll('[data-action="open-service"]').length`);
      assert(btns > 0, 'carte ' + i + ' : aucun bouton open-service');
    }
  });

  await test('C1.4 Le bouton « Ajouter un compte » ouvre la modale', async () => {
    const opened = await exec(`(() => {
      const btn = document.querySelector('[data-action="ui-openModal"]');
      if (!btn) return 'absent';
      btn.click();
      const open = document.getElementById('accountModal').classList.contains('open');
      window.closeModal && window.closeModal();
      return open;
    })()`);
    assert(opened === true, 'modale d\'ajout non ouverte (' + opened + ')');
  });

  await test('C1.5 Les statistiques reflètent les comptes seedés', async () => {
    const txt = await exec('document.querySelector(".dashboard").innerText');
    assert(/COMPTES ACTIFS\s*2/i.test(txt), 'compteur « comptes actifs » ≠ 2 : ' + txt.slice(0, 120));
  });

  // =========================================================================
  // C2 — Réglages et thème
  // =========================================================================
  console.log('\n--- C2 : Réglages et thème ---');

  await test('C2.1 Le thème par défaut est posé sur <html> (data-theme)', async () => {
    const theme = await exec('document.documentElement.getAttribute(\'data-theme\')');
    assert(theme !== null && theme !== '', 'aucun data-theme sur <html>');
  });

  await test('C2.2 Le bouton Réglages ouvre la modale (délégation data-action)', async () => {
    const r = await exec(`(() => {
      const btn = document.querySelector('[data-action="ui-openSettingsModal"]');
      if (!btn) return 'bouton absent';
      btn.click();
      return document.getElementById('settingsModal').classList.contains('open');
    })()`);
    assert(r === true, 'modale de réglages non ouverte (' + r + ')');
    await sleep(300);
    const checked = await exec('document.getElementById("settingsStartWithLastSession").checked');
    assert(checked === true, 'réglage startWithLastSession non reflété dans la modale');
    await exec('window.closeSettingsModal(); "ok"');
  });

  // =========================================================================
  // C3 — Explorateur de fichiers
  // =========================================================================
  console.log('\n--- C3 : Explorateur de fichiers ---');

  await test('C3.1 Le panneau explorateur existe dans le DOM', async () => {
    const explorer = await exec('document.querySelector(\'#fileExplorer\') !== null');
    assert(explorer, 'panneau #fileExplorer absent du DOM');
  });

  await test('C3.2 Le bouton Explorateur bascule le panneau', async () => {
    const before = await exec('document.getElementById("fileExplorer").classList.contains("collapsed")');
    await exec('document.querySelector(\'[data-action="ui-toggleExplorer"]\').click(); "ok"');
    await sleep(200);
    const after = await exec('document.getElementById("fileExplorer").classList.contains("collapsed")');
    assert(before !== after, 'le panneau n\'a pas changé d\'état (collapsed=' + before + ')');
  });

  await test('C3.3 read-directory-recursive liste les fichiers et sous-dossiers', async () => {
    const files = await ipc('read-directory-recursive', testDir);
    const rels = files.map(f => f.relativePath).sort();
    assert(rels.includes('test-file.txt'), 'test-file.txt absent : ' + rels.join(', '));
    assert(rels.includes('subfolder/nested.js'), 'subfolder/nested.js absent : ' + rels.join(', '));
  });

  // =========================================================================
  // C4 — Restauration et persistance des onglets
  // =========================================================================
  console.log('\n--- C4 : Onglets ---');

  await test('C4.1 serializeOpenTabs/deserializeOpenTabs sont exposés (lib/settings.js)', async () => {
    assert(await exec('typeof window.serializeOpenTabs === \'function\''), 'serializeOpenTabs non exposé sur window');
    assert(await exec('typeof window.deserializeOpenTabs === \'function\''), 'deserializeOpenTabs non exposé sur window');
  });

  await test('C4.2 Les 2 onglets persistés sont restaurés au démarrage (startWithLastSession)', async () => {
    const n = await exec('document.querySelectorAll("#tabsBar .tab").length');
    assert(n === 2, 'attendu 2 onglets restaurés, trouvé ' + n);
  });

  await test('C4.3 Ouvrir un service ajoute un onglet et le persiste', async () => {
    await exec(`document.querySelector('#accountsList [data-action="open-service"][data-acc="acc_test_2"][data-svc="perplexity"]').click(); 'ok'`);
    await sleep(400);
    const n = await exec('document.querySelectorAll("#tabsBar .tab").length');
    assert(n === 3, 'attendu 3 onglets, trouvé ' + n);
    const stored = JSON.parse(await exec('localStorage.getItem("ai_open_tabs")'));
    assert(stored.some(t => t.accId === 'acc_test_2' && t.svcId === 'perplexity'),
      'onglet non persisté : ' + JSON.stringify(stored));
  });

  await test('C4.4 Rouvrir le même couple (compte, service) réutilise l\'onglet', async () => {
    await exec(`document.querySelector('#accountsList [data-action="open-service"][data-acc="acc_test_1"][data-svc="claude"]').click(); 'ok'`);
    await sleep(300);
    const n = await exec('document.querySelectorAll("#tabsBar .tab").length');
    assert(n === 3, 'un doublon d\'onglet a été créé (' + n + ' onglets)');
  });

  // =========================================================================
  // C5 — Barre d'onglets
  // =========================================================================
  console.log('\n--- C5 : Barre d\'onglets ---');

  await test('C5.1 Les onglets utilisent la délégation d\'événements (data-action)', async () => {
    const r = await exec(`({ activate: document.querySelectorAll('#tabsBar [data-action="activate-tab"]').length,
      close: document.querySelectorAll('#tabsBar [data-action="close-tab"]').length })`);
    assert(r.activate === 3 && r.close === 3, 'data-action attendus sur 3 onglets : ' + JSON.stringify(r));
  });

  await test('C5.2 Aucun onclick généré dans la barre d\'onglets ni les cartes (invariant 2)', async () => {
    const n = await exec('document.querySelectorAll("#tabsBar [onclick], #accountsList [onclick]").length');
    assert(n === 0, n + ' attribut(s) onclick généré(s)');
  });

  // =========================================================================
  // C6. Issue #149 : menu natif masqué, barre du workspace, bouton Ctrl+K
  // =========================================================================
  await test('C6.1 La barre de menu native est masquée (le menu garde ses raccourcis)', async () => {
    assert(win.isMenuBarVisible() === false, 'barre de menu visible');
    assert(require('electron').Menu.getApplicationMenu() !== null, 'menu applicatif supprimé : raccourcis perdus');
  });

  await test('C6.2 Nom de l\'app, Explorateur, Éditeur et outils de dév. dans la barre du workspace', async () => {
    const r = await exec(`(() => {
      const bar = document.querySelector('.workspace-header');
      return {
        brand: bar.querySelector('.app-brand__title') && bar.querySelector('.app-brand__title').textContent,
        actions: [...bar.querySelectorAll('[data-action]')].map(b => b.getAttribute('data-action')),
        ancien: !!document.querySelector('#dashboard header, .header__brand')
      };
    })()`);
    assert(r.brand === 'IAO', 'nom de l\'app absent de la barre : ' + r.brand);
    const i = r.actions.indexOf('ui-toggleIdePanel');
    assert(r.actions.indexOf('ui-toggleExplorer') >= 0 && i >= 0, 'Explorateur/Éditeur absents : ' + r.actions);
    assert(r.actions[i + 1] === 'ui-toggleDevTools', 'outils de dév. pas à côté de l\'Éditeur : ' + r.actions);
    assert(r.ancien === false, 'ancien en-tête encore présent dans la barre latérale');
  });

  await test('C6.3 Le bouton Ctrl+K, à côté des compteurs, ouvre la palette', async () => {
    const r = await exec(`(() => {
      const stats = document.querySelector('#dashboard .stats');
      const btn = stats.querySelector('#btnOpenPalette');
      if (!btn) return { btn: false };
      btn.click();
      const open = document.getElementById('paletteOverlay').classList.contains('open');
      const focus = document.activeElement && document.activeElement.id;
      document.getElementById('paletteOverlay').classList.remove('open');
      return { btn: true, cartes: stats.querySelectorAll('.stat-card').length, open, focus };
    })()`);
    assert(r.btn, 'bouton Ctrl+K absent de la ligne des compteurs');
    assert(r.cartes === 2 && r.open === true && r.focus === 'paletteInput', JSON.stringify(r));
  });

  await test('C6.4 Le bouton des outils de développement les ouvre puis les referme', async () => {
    const ouvert = await exec('window.toggleDevTools()');
    assert(ouvert === true, 'app:toggle-devtools refusé : ' + ouvert);
    for (let i = 0; i < 30 && !win.webContents.isDevToolsOpened(); i++) await sleep(100);
    assert(win.webContents.isDevToolsOpened(), 'outils de développement non ouverts');
    await exec('window.toggleDevTools()');
    for (let i = 0; i < 30 && win.webContents.isDevToolsOpened(); i++) await sleep(100);
    assert(!win.webContents.isDevToolsOpened(), 'outils de développement non refermés');
  });

  // =========================================================================
  // C7 — Internationalisation (issue #51)
  // =========================================================================
  console.log('\n--- C7 : Internationalisation ---');

  await test('C7.1 Par défaut l\'interface reste en français (langue source)', async () => {
    const r = await exec(`({ lang: document.documentElement.lang,
      title: document.querySelector('[data-action="ui-openModal"]').getAttribute('title') })`);
    assert(r.lang === 'fr', 'lang attendu fr, trouvé ' + r.lang);
    assert(r.title === 'Ajouter un compte', 'title inattendu : ' + r.title);
  });

  await test('C7.2 IAO_LANG=en traduit textes, title et placeholder sans casser les icônes', async () => {
    process.env.IAO_LANG = 'en';
    try {
      win.webContents.reload();
      await sleep(300);
      await waitLoaded();
      const r = await exec(`({
        lang: document.documentElement.lang,
        title: document.querySelector('[data-action="ui-openModal"]').getAttribute('title'),
        placeholder: document.getElementById('paletteInput').getAttribute('placeholder'),
        section: document.querySelector('.section-title--accounts span').textContent,
        icons: document.querySelectorAll('span.ic[data-icon]').length,
        svgs: document.querySelectorAll('span.ic[data-icon] svg').length,
        bootError: document.getElementById('bootError') !== null
      })`);
      assert(r.lang === 'en', 'lang attendu en, trouvé ' + r.lang);
      assert(r.title === 'Add an account', 'title non traduit : ' + r.title);
      assert(r.placeholder === 'Search for an account or an AI...', 'placeholder non traduit : ' + r.placeholder);
      assert(r.section === 'Saved accounts', 'texte non traduit : ' + r.section);
      assert(r.svgs === r.icons, 'icônes perdues après traduction : ' + r.svgs + '/' + r.icons);
      assert(!r.bootError, 'bandeau d\'erreur de démarrage affiché');
    } finally {
      delete process.env.IAO_LANG;
    }
  });

  // =========================================================================
  // Nettoyage
  // =========================================================================
  console.log('\n--- Résumé ---');
  console.log('tests: ' + (passed + failed) + ', pass: ' + passed + ', fail: ' + failed);
  if (failures.length > 0) {
    console.log('\nÉchecs :');
    for (const f of failures) {
      console.log('  ' + f.name + ' : ' + (f.error && f.error.message ? f.error.message : f.error));
    }
  }

  if (MEASURE_COVERAGE) {
    try {
      const text = fs.readFileSync(path.join(__dirname, '..', 'assets', 'app.js'), 'utf-8');
      const r = await v8cov.takeCoverage(win.webContents, 'assets/app.js', text);
      if (!r) {
        console.log('COV assets/app.js : script non chargé, aucune mesure');
      } else {
        console.log('COV assets/app.js : lignes ' + r.lines.covered + '/' + r.lines.total +
          ' (' + r.lines.pct.toFixed(1) + ' %), fonctions ' + r.functions.called + '/' + r.functions.total +
          ' (' + r.functions.pct.toFixed(1) + ' %) — informatif, non bloquant');
        if (process.env.IAO_COVERAGE_OUT) {
          fs.writeFileSync(process.env.IAO_COVERAGE_OUT, JSON.stringify(r, null, 2), 'utf-8');
        }
      }
    } catch (e) { console.log('COV mesure impossible : ' + e.message); }
  }

  try { win.destroy(); } catch (e) { /* ignore */ }
  app.exit(failed > 0 ? 1 : 0);
}

app.whenReady().then(run).catch((e) => {
  console.error('Erreur fatale du harnais UI :', e);
  app.exit(1);
});
