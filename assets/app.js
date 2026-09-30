// assets/app.js — ancien <script> inline de fin d'index.html (lot CSP, 18/09/2026).
// Extrait tel quel : voir index.html pour le HTML, lib/*.js pour les modules purs.
// Comportement identique au script inline d'origine (même portée globale).

// Issue #4 : contextIsolation: true — le renderer n'a plus accès à Node.
// Les APIs nécessaires sont exposées par preload.js via window.iaoAPI.
// L'ancien mécanisme de sauvegarde du require Electron est supprimé.

  // escapeHtml() vient désormais de lib/escape-html.js (chantier F, chargé en
  // <script src> plus haut) — comportement identique, désormais testé par
  // `node --test` (test/pure.test.js).

  // Filet de sécurité (chantier audit 3.6) : si assets/icons.js n'a pas pu se
  // charger, `hydrateIcons` serait absente et le 1er appel dans initApp() ferait
  // planter TOUTE l'app. On garantit une fonction no-op -> au pire, pas d'icônes,
  // mais l'app reste utilisable.
  if (typeof window.hydrateIcons !== 'function') window.hydrateIcons = function () {};

  // === Démarrage ===
  // L'application démarre IMMÉDIATEMENT et NE DÉPEND PAS de Monaco.
  // Monaco (l'éditeur de code) est chargé EN LOCAL depuis node_modules et reste
  // OPTIONNEL : s'il n'arrive pas à s'initialiser (fichier manquant, erreur),
  // tout le reste de l'application continue de fonctionner normalement.
  // Chargement PARESSEUX (audit perf) : ~8 Mo de JS Monaco ne sont plus parsés
  // au démarrage mais au premier clic sur l'éditeur (qui démarre replié).
  var monacoRequested = false;
  function ensureMonacoLoaded() {
    if (monacoRequested) return;
    monacoRequested = true;
    // Placeholder le temps du chargement (~centaines de ms) ; remplacé par
    // Monaco (__initMonacoEditor vide le conteneur) ou par l'éditeur de secours.
    const c = document.getElementById('monacoContainer');
    if (c) c.innerHTML = '<div class="monaco-loading">Chargement de l\'éditeur…</div>';
    loadMonaco();
  }
  initApp();

  function loadMonaco() {
    // Si le loader.js n'a pas pu se charger, window.require reste le require
    // d'Electron (qui n'a pas de .config) : on bascule sur le mode dégradé.
    if (window.__monacoLoadFailed || typeof window.require === 'undefined' || typeof window.require.config !== 'function') {
      console.warn('[editor] loader.js indisponible (__monacoLoadFailed=' + window.__monacoLoadFailed + ', require=' + typeof window.require + ')');
      onMonacoUnavailable();
      return;
    }
    try {
      // Issue #4 : le chemin absolu de Monaco est calculé par preload.js
      // (window.iaoAPI.resolveMonacoBase) car le renderer n'a plus accès à
      // Node's url/path modules.
      let vsBase = 'node_modules/monaco-editor/min/vs';
      try {
        const resolved = window.iaoAPI.resolveMonacoBase();
        if (resolved) vsBase = resolved;
      } catch (e) { console.warn('[editor] chemin absolu Monaco indisponible, repli relatif'); }
      window.require.config({ paths: { vs: vsBase } });
      window.require(
        ['vs/editor/editor.main'],
        function () {
          console.log('[editor] Monaco chargé OK');
          if (window.__initMonacoEditor) window.__initMonacoEditor();
        },
        function (err) {
          // Échec du chargement du module Monaco.
          console.error('[editor] échec require(editor.main):', err && (err.message || err));
          onMonacoUnavailable();
        }
      );
    } catch (e) {
      console.error('[editor] exception loadMonaco:', e && (e.message || e));
      onMonacoUnavailable();
    }
  }

  function onMonacoUnavailable() {
    // Monaco indisponible : on bascule sur l'éditeur de secours (textarea).
    if (window.__initFallbackEditor) window.__initFallbackEditor();
  }

  function initApp() {
    // Issue #4 : ipcRenderer n'est plus accessible directement (contextIsolation).
    // window.iaoAPI.ipcInvoke est exposé par preload.js.
    // Issue #52 : si le preload n'a pas pu s'exécuter, on le dit clairement
    // (bandeau + journal) au lieu de planter sur « Cannot read properties of
    // undefined (reading 'ipcInvoke') » avec une interface vide.
    if (!window.iaoAPI || typeof window.iaoAPI.ipcInvoke !== 'function') {
      if (typeof window.__iaoReportStartupProblem === 'function') {
        window.__iaoReportStartupProblem('preload', 'window.iaoAPI indisponible : preload.js ne s\'est pas exécuté');
      }
      hydrateIcons(document);
      return;
    }
    const ipcRenderer = { invoke: window.iaoAPI.ipcInvoke };

    const SERVICES = [
      { id: 'claude', name: 'Claude', url: 'https://claude.ai/new', cssClass: 'svc-claude' },
      { id: 'chatgpt', name: 'ChatGPT', url: 'https://chatgpt.com/', cssClass: 'svc-chatgpt' },
      { id: 'gemini', name: 'Gemini', url: 'https://gemini.google.com/app', cssClass: 'svc-gemini' },
      { id: 'zeta', name: 'Z.ai', url: 'https://chat.z.ai/', cssClass: 'svc-zeta' },
      { id: 'perplexity', name: 'Perplexity', url: 'https://www.perplexity.ai/', cssClass: 'svc-perplexity' },
      { id: 'grok', name: 'Grok', url: 'https://grok.com/', cssClass: 'svc-grok' },
      { id: 'leonardo', name: 'Leonardo AI', url: 'https://app.leonardo.ai/', cssClass: 'svc-leonardo' },
      { id: 'suno', name: 'Suno', url: 'https://suno.com/create', cssClass: 'svc-suno' },
      { id: 'meshy', name: 'Meshy AI', url: 'https://www.meshy.ai/workspace', cssClass: 'svc-meshy' },
      // Issue #42 : services additionnels (sélectionnables via le menu)
      { id: 'mistral', name: 'Mistral', url: 'https://chat.mistral.ai/', cssClass: 'svc-mistral' },
      { id: 'deepseek', name: 'DeepSeek', url: 'https://chat.deepseek.com/', cssClass: 'svc-deepseek' },
      { id: 'copilot', name: 'GitHub Copilot', url: 'https://github.com/features/copilot', cssClass: 'svc-copilot' },
      { id: 'elicit', name: 'Elicit', url: 'https://elicit.com/', cssClass: 'svc-elicit' },
      { id: 'notebooklm', name: 'NotebookLM', url: 'https://notebooklm.google.com/', cssClass: 'svc-notebooklm' },
      { id: 'wolfram', name: 'Wolfram Alpha', url: 'https://www.wolframalpha.com/', cssClass: 'svc-wolfram' },
      { id: 'deepl', name: 'DeepL', url: 'https://www.deepl.com/translator', cssClass: 'svc-deepl' },
      { id: 'ideogram', name: 'Ideogram', url: 'https://ideogram.ai/', cssClass: 'svc-ideogram' },
      { id: 'kling', name: 'Kling', url: 'https://klingai.com/', cssClass: 'svc-kling' },
      { id: 'runway', name: 'Runway', url: 'https://runwayml.com/', cssClass: 'svc-runway' },
      { id: 'pika', name: 'Pika', url: 'https://pika.art/', cssClass: 'svc-pika' },
      { id: 'qwen', name: 'Qwen', url: 'https://chat.qwen.ai/', cssClass: 'svc-qwen' }
    ];

    // Issue #42 : liste des services "à portée de main" (9 par défaut).
    // Stockée dans localStorage, modifiable via le menu de sélection.
    const ACTIVE_SERVICES_KEY = 'ai_active_services';
    const DEFAULT_ACTIVE_SERVICES = ['claude','chatgpt','gemini','zeta','perplexity','grok','leonardo','suno','meshy'];
    const MAX_ACTIVE_SERVICES = 9;

    function getActiveServices() {
      try {
        const raw = localStorage.getItem(ACTIVE_SERVICES_KEY);
        if (!raw) return DEFAULT_ACTIVE_SERVICES.slice();
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return DEFAULT_ACTIVE_SERVICES.slice();
        // Filtrer les IDs invalides + limiter à MAX_ACTIVE_SERVICES
        const valid = parsed.filter(id => SERVICES.some(s => s.id === id));
        if (valid.length === 0) return DEFAULT_ACTIVE_SERVICES.slice();
        return valid.slice(0, MAX_ACTIVE_SERVICES);
      } catch (e) { return DEFAULT_ACTIVE_SERVICES.slice(); }
    }

    function saveActiveServices(ids) {
      try { localStorage.setItem(ACTIVE_SERVICES_KEY, JSON.stringify(ids.slice(0, MAX_ACTIVE_SERVICES))); }
      catch (e) { /* non bloquant */ }
    }

    // Retourne les services actifs (objets complets), dans l'ordre de sélection.
    function activeServices() {
      const ids = getActiveServices();
      return ids.map(id => SERVICES.find(s => s.id === id)).filter(Boolean);
    }

    const COLORS = ['#8b5cf6','#f230aa','#c4b5fd','#a855f7','#5865f2','#ec4899','#38bdf8','#f97316'];

    // Contenu de la modale d'aide, indexé par id de service (même philosophie
    // data-driven que SERVICES : ajouter un service = ajouter son entrée ici).
    // Texte statique embarqué (aucun fetch réseau), rédigé neutre / grand public.
    const SERVICE_INFO = {
      claude: {
        what: "L'assistant conversationnel d'Anthropic. Il excelle en rédaction, en analyse de longs documents, en programmation et dans les raisonnements qui demandent plusieurs étapes.",
        when: "Plutôt pour du code, des textes longs et soignés, ou des questions complexes qui demandent de la rigueur."
      },
      chatgpt: {
        what: "L'assistant généraliste d'OpenAI, le plus connu du grand public. Il discute, rédige, résume, génère des images, analyse des fichiers et peut chercher sur le web.",
        when: "Le couteau suisse du quotidien : brainstorming, questions générales, petites tâches variées."
      },
      gemini: {
        what: "L'assistant IA de Google. Multimodal (texte, images, audio, vidéo), il s'appuie sur la recherche Google et s'intègre aux outils Google (Docs, Gmail, Drive…).",
        when: "Plutôt pour analyser des images ou vidéos, ou si vous travaillez déjà dans l'écosystème Google."
      },
      zeta: {
        what: "Le chat de Z.ai, propulsé par les modèles GLM. Gratuit pour l'essentiel, avec un mode agent capable de chercher sur le web et de produire des fichiers (docx, pdf, xlsx).",
        when: "Une alternative gratuite solide pour le chat et le code, quand les quotas des autres sont épuisés."
      },
      perplexity: {
        what: "Un « moteur de réponse » : il cherche sur le web en direct, synthétise plusieurs sources et cite ses références pour chaque affirmation.",
        when: "Plutôt pour la recherche d'informations à jour, la veille et la vérification de faits avec sources."
      },
      grok: {
        what: "L'assistant de xAI (Elon Musk), connecté au réseau X (ex-Twitter). Ton direct, accès au temps réel de X, génération d'images incluse.",
        when: "Plutôt pour suivre l'actualité chaude et les tendances via X, ou pour un ton moins formel."
      },
      leonardo: {
        what: "Une plateforme de génération d'images orientée création : illustrations, concept art, assets de jeu vidéo, avec des contrôles fins (styles, modèles, retouche).",
        when: "Plutôt pour produire des visuels et illustrations de qualité avec un contrôle précis du style."
      },
      suno: {
        what: "Un générateur de musique : il compose des chansons complètes (instruments, voix, paroles) à partir d'une simple description texte, dans à peu près tous les genres.",
        when: "Plutôt pour créer une musique, un jingle ou une chanson à partir d'un texte ou d'une idée."
      },
      meshy: {
        what: "Un générateur de modèles 3D : il transforme un texte ou une image en objet 3D texturé, avec rigging/animation automatique et export vers les formats standards (GLB, FBX, STL…).",
        when: "Plutôt pour créer des assets 3D (jeux, impression 3D, animation) sans savoir modéliser."
      },
      // Issue #42 : fiches des services additionnels
      mistral: {
        what: "Le Chat de Mistral AI, éditeur européen (français). Modèles open-weights performants, chat, code et analyse de documents.",
        when: "Alternative européenne solide pour le chat et le code, avec une bonne maîtrise du français."
      },
      deepseek: {
        what: "DeepSeek : assistant IA chinois spécialisé en raisonnement et programmation, particulièrement performant en Python.",
        when: "Pour du code Python, du raisonnement étape par étape, ou une alternative gratuite à ChatGPT."
      },
      copilot: {
        what: "GitHub Copilot : assistant IA intégré dans VS Code et GitHub. Autocomplétion, chat, génération de tests, explication de code.",
        when: "Pour programmer plus vite dans VS Code ou sur GitHub, avec un modèle IA qui connaît votre codebase."
      },
      elicit: {
        what: "Elicit : assistant de recherche scientifique. Trouve des articles, extrait des données, synthétise des études.",
        when: "Pour la recherche académique, la revue de littérature et l'extraction de données d'articles scientifiques."
      },
      notebooklm: {
        what: "NotebookLM de Google : interagissez avec vos propres documents (PDF, texte, audio). Résumés, questions, génération de notes.",
        when: "Pour interroger vos documents personnels ou professionnels avec une IA qui cite ses sources."
      },
      wolfram: {
        what: "Wolfram Alpha : moteur de calcul symbolique. Mathématiques, physique, chimie, données factuelles, conversions.",
        when: "Pour des calculs exacts (mathématiques symboliques), des données chiffrées ou des conversions d'unités."
      },
      deepl: {
        what: "DeepL : traduction automatique de haute qualité, plus naturelle que Google Traduction. Texte et documents entiers.",
        when: "Pour traduire du texte ou des documents avec un rendu naturel et cohérent."
      },
      ideogram: {
        what: "Ideogram : génération d'images orientée design. Logos, typographies, affiches, avec un excellent rendu du texte.",
        when: "Pour créer des visuels avec du texte lisible (logos, affiches, bannières) ou du design graphique."
      },
      kling: {
        what: "Kling : générateur de vidéos courtes à partir de texte ou d'images. Animations réalistes, crédits gratuits disponibles.",
        when: "Pour créer des clips vidéo animés à partir d'une description ou d'une image fixe."
      },
      runway: {
        what: "Runway : suite d'outils IA pour la vidéo. Génération, édition, effets spéciaux, inpainting vidéo.",
        when: "Pour le montage et la création vidéo avancée avec des outils IA intégrés."
      },
      pika: {
        what: "Pika : générateur de vidéos courtes et créatives. Animation d'images, effets, transformation de styles.",
        when: "Pour animer des images ou créer des vidéos courtes originales avec des effets IA."
      },
      qwen: {
        what: "Qwen : assistant IA d'Alibaba. Multimodal (texte, images, code), open-source, disponible en plusieurs tailles.",
        when: "Alternative gratuite pour le chat, le code et l'analyse d'images, avec un bon support multilingue."
      }
    };

    // Icônes statiques du HTML (chantier D) : on remplit les <span class="ic">.
    hydrateIcons(document);

    // === Stockage résilient des comptes (chantier C) ===
    // Toute la persistance passe désormais par ces helpers : lecture tolérante
    // aux données corrompues + une génération de backup avant chaque écrasement.
    const STORE_KEY = 'ai_accounts';
    const BACKUP_KEY = 'ai_accounts_backup';
    const TABS_KEY = 'ai_open_tabs'; // lot 18/09/2026 : restauration des onglets au démarrage
    const STARRED_KEY = 'ai_starred_tabs'; // issue #154 : onglets étoilés (persistants)
    const ORDER_KEY = 'ai_account_order'; // issue #6 : ordre personnalisé des comptes (drag-and-drop)

    // Issue #154 : Gestion des onglets étoilés (star). Un onglet étoilé est
    // identifié par la paire (accId, svcId) — stable même si l'onglet est fermé
    // puis rouvert. La liste persiste dans localStorage et survit aux redémarrages.
    // Les fonctions pures (tabStarKey, isTabStarred, toggleTabStar, serialize,
    // deserialize) viennent de lib/starred-tabs.js — testables par `node --test`.
    let starredTabs = new Set();
    function loadStarredTabs() {
      try {
        var raw = localStorage.getItem(STARRED_KEY);
        starredTabs = deserializeStarredTabs(raw);
      } catch (e) { /* non bloquant */ }
    }
    function saveStarredTabs() {
      try { localStorage.setItem(STARRED_KEY, serializeStarredTabs(starredTabs)); } catch (e) { /* non bloquant */ }
    }
    function isTabStarredById(accId, svcId) { return isTabStarred(starredTabs, accId, svcId); }
    function toggleTabStarById(accId, svcId) {
      starredTabs = toggleTabStar(starredTabs, accId, svcId);
      saveStarredTabs();
    }

    // Lecture JSON sûre : ne throw JAMAIS. Renvoie un statut pour distinguer
    // « vide » (première utilisation) de « corrompu » (backup à proposer).
    function readJSON(key) {
      const raw = localStorage.getItem(key);
      if (raw == null) return { status: 'empty', data: null };
      try { return { status: 'ok', data: JSON.parse(raw) }; }
      catch (e) {
        console.error('[storage] JSON corrompu pour « ' + key + ' » :', e);
        return { status: 'corrupt', data: null, error: e };
      }
    }

    // Sauvegarde la liste de comptes. Avant d'écraser, on copie l'ancienne valeur
    // dans BACKUP_KEY — mais UNIQUEMENT si elle est elle-même un JSON valide, pour
    // ne jamais détruire un bon backup en y recopiant une valeur corrompue.
    function saveAccounts(list) {
      try {
        const prev = localStorage.getItem(STORE_KEY);
        if (prev != null) {
          try { JSON.parse(prev); localStorage.setItem(BACKUP_KEY, prev); }
          catch (_) { /* valeur actuelle illisible : on préserve le backup existant */ }
        }
        localStorage.setItem(STORE_KEY, JSON.stringify(list));
        // Ordonnanceur (chantier E) : on pousse un instantané des comptes
        // (profil + état d'automatisation) au process principal, seul capable
        // de choisir un profil "le plus ancien" indépendamment des fenêtres
        // ouvertes. Best-effort : un échec ici ne doit jamais empêcher
        // l'enregistrement des comptes eux-mêmes.
        try { ipcRenderer.invoke('scheduler:sync-accounts', list).catch(() => {}); } catch (_) { /* ignore */ }
        return true;
      } catch (e) {
        console.error('[storage] échec écriture des comptes :', e);
        showToast('Impossible d\'enregistrer les comptes (stockage plein ?)', 'error');
        return false;
      }
    }

    // Sauvegarde la liste des onglets ouverts (accId + svcId) pour restauration
    // au démarrage si « startWithLastSession » est activé (lot 18/09/2026).
    function saveOpenTabs() {
      try {
        localStorage.setItem(TABS_KEY, serializeOpenTabs(tabs));
      } catch (e) { /* non bloquant */ }
    }

    // Restaure les onglets sauvegardés (lot 18/09/2026).
    function restoreOpenTabs() {
      var raw = localStorage.getItem(TABS_KEY) || '';
      var tabList = deserializeOpenTabs(raw);
      tabList.forEach(function(tab) {
        openService(tab.accId, tab.svcId);
      });
    }

    // Fondation réutilisable pour une future fonctionnalité d'export/import JSON
    // (ne pas coder le backup « en dur » : ces deux fonctions serviront à l'UI).
    function exportAccountsJSON() { return JSON.stringify(accounts, null, 2); }
    function importAccountsJSON(text) {
      const parsed = JSON.parse(text); // peut throw : l'appelant (UI) gère l'erreur
      if (!Array.isArray(parsed)) throw new Error('Format invalide : un tableau de comptes est attendu.');
      accounts = parsed;
      migrateOldAccounts();  // complète/répare les comptes importés
      saveAccounts(accounts);
      renderAccounts();
      return accounts.length;
    }

    // Chargement initial tolérant : l'app ne plante JAMAIS au démarrage, même si
    // ai_accounts est corrompu (le cas échéant on propose la restauration plus bas).
    let dataCorrupt = false;
    let accounts = [];
    (function loadAccounts() {
      const r = readJSON(STORE_KEY);
      if (r.status === 'ok' && Array.isArray(r.data)) accounts = r.data;
      else if (r.status === 'corrupt') dataCorrupt = true;
      // 'empty' ou JSON valide non-tableau -> accounts reste []
    })();

    // Issue #154 : charger les onglets étoilés au démarrage.
    loadStarredTabs();

    // Vue compacte : ids des comptes dont la grille de services est repliée.
    // Persisté dans localStorage (clé dédiée, même modèle défensif que ide_w :
    // une valeur absente/illisible retombe sur le défaut = tout déplié).
    const COLLAPSED_KEY = 'collapsed_accounts';
    let collapsedAccounts = new Set();
    try {
      const saved = JSON.parse(localStorage.getItem(COLLAPSED_KEY) || '[]');
      if (Array.isArray(saved)) collapsedAccounts = new Set(saved.filter(x => typeof x === 'string'));
    } catch (e) { console.warn('[storage] états de repli ignorés :', e); }

    // Écrit l'état de repli en purgeant les ids de comptes supprimés
    // (la clé ne grossit pas indéfiniment au fil des suppressions).
    function saveCollapsed() {
      collapsedAccounts = new Set([...collapsedAccounts].filter(id => accounts.some(a => a.id === id)));
      try { localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...collapsedAccounts])); } catch (e) {}
    }

    window.toggleCardCollapse = function(accId) {
      if (!accounts.some(a => a.id === accId)) return; // garde : id obsolète
      if (collapsedAccounts.has(accId)) collapsedAccounts.delete(accId);
      else collapsedAccounts.add(accId);
      saveCollapsed();
      renderAccounts();
    }

    // Bascule globale : s'il reste au moins une carte dépliée on replie tout,
    // sinon on déplie tout. Idempotent sur les cartes déjà dans l'état cible.
    window.toggleAllCards = function() {
      if (accounts.length === 0) return;
      const anyExpanded = accounts.some(a => !collapsedAccounts.has(a.id));
      if (anyExpanded) accounts.forEach(a => collapsedAccounts.add(a.id));
      else collapsedAccounts.clear();
      saveCollapsed();
      renderAccounts();
    }

    let activeAccountId = null;
    // Onglets IA : chaque service ouvert (compte + service) vit dans son propre
    // onglet, avec sa <webview> dédiée. tabs[] est l'unique source de vérité ;
    // le DOM (barre d'onglets + panneaux) est entièrement redérivé de ce tableau.
    let tabs = [];          // { id, accId, svcId, paneEl }
    let activeTabId = null;
    let tabSeq = 0;
    let monacoEditor = null;
    let fallbackTextarea = null;
    let editorMode = 'none'; // 'monaco' | 'textarea' | 'none'
    let currentOpenFilePath = null;

    // Migration : convertit les anciens comptes et garantit que chaque compte
    // possède TOUS les services + un cooldown pour chacun (répare aussi les
    // comptes enregistrés qui n'avaient pas encore Perplexity/Zeta).
    function migrateOldAccounts() {
      let needsUpdate = false;
    // Issue #42 : ALL_SERVICES utilise les services actifs (9 sélectionnés)
    // au lieu de tous les SERVICES. Les comptes existants gardent leurs services
    // assignés ; les nouveaux comptes obtiennent les 9 services actifs.
    const ALL_SERVICES = getActiveServices();
      accounts.forEach(acc => {
        if (!Array.isArray(acc.services)) { acc.services = [...ALL_SERVICES]; needsUpdate = true; }
        if (acc.quotas && !acc.cooldowns) { delete acc.quotas; needsUpdate = true; }
        if (!acc.cooldowns) { acc.cooldowns = {}; needsUpdate = true; }
        ALL_SERVICES.forEach(sid => {
          if (!acc.services.includes(sid)) { acc.services.push(sid); needsUpdate = true; }
          if (acc.cooldowns[sid] === undefined) { acc.cooldowns[sid] = 0; needsUpdate = true; }
        });
        // Ordonnanceur (chantier E, proposition externe intégrée au backlog) :
        // chaque compte porte désormais son état d'automatisation, indépendant
        // des cooldowns par service. lastUsedAt = dernière ouverture manuelle ;
        // lastAutomationAt = dernier job d'ordonnanceur exécuté sur ce profil
        // (sert à choisir le profil "le plus ancien" avant d'en relancer un).
        if (!acc.automation || typeof acc.automation !== 'object') {
          acc.automation = { enabled: true, lastUsedAt: 0, lastAutomationAt: 0 };
          needsUpdate = true;
        }
      });
      if (needsUpdate) saveAccounts(accounts);
    }
    migrateOldAccounts();

    // Éditeur Monaco — créé UNIQUEMENT si Monaco a pu se charger (optionnel).
    // Appelé par loadMonaco() une fois le CDN chargé. Si Monaco échoue, cette
    // fonction n'est jamais appelée et l'app fonctionne sans éditeur.
    window.__initMonacoEditor = function() {
      if (typeof monaco === 'undefined' || monacoEditor) return;
      const container = document.getElementById('monacoContainer');
      container.innerHTML = ''; // retire le placeholder « Chargement de l'éditeur… »
      monacoEditor = monaco.editor.create(container, {
        value: '// Sélectionnez un fichier pour l\'éditer ici.\n// Ctrl+S pour sauvegarder.',
        language: 'javascript',
        theme: 'vs-dark',
        automaticLayout: true
      });
      monacoEditor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, function() {
        saveCurrentFile();
      });
      editorMode = 'monaco';
    };

    // Éditeur de SECOURS (textarea) — utilisé si Monaco n'a pas pu se charger.
    // Toujours fonctionnel : ouverture, édition et sauvegarde (Ctrl+S).
    window.__initFallbackEditor = function() {
      if (editorMode === 'monaco') return; // Monaco a réussi, on ne fait rien
      const c = document.getElementById('monacoContainer');
      if (!c) return;
      c.innerHTML = `
        <div class="fallback-editor">
          <div class="fallback-editor__warning">
            <span class="ic" data-icon="triangle-exclamation"></span> Éditeur simplifié (Monaco indisponible) — Ctrl+S pour sauvegarder
          </div>
          <textarea id="fallbackEditor" spellcheck="false" disabled
            class="fallback-editor__textarea"
            placeholder="Sélectionnez un fichier pour l'éditer ici."></textarea>
        </div>`;
      hydrateIcons(c); // remplit l'icône SVG du bandeau
      fallbackTextarea = document.getElementById('fallbackEditor');
      fallbackTextarea.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) { e.preventDefault(); saveCurrentFile(); }
        if (e.key === 'Tab') {
          e.preventDefault();
          const s = fallbackTextarea.selectionStart, en = fallbackTextarea.selectionEnd;
          fallbackTextarea.value = fallbackTextarea.value.slice(0, s) + '  ' + fallbackTextarea.value.slice(en);
          fallbackTextarea.selectionStart = fallbackTextarea.selectionEnd = s + 2;
        }
      });
      editorMode = 'textarea';
    };

    // Accès unifié à l'éditeur (Monaco OU textarea de secours).
    function getEditorValue() {
      if (editorMode === 'monaco' && monacoEditor) return monacoEditor.getValue();
      if (editorMode === 'textarea' && fallbackTextarea) return fallbackTextarea.value;
      return null;
    }
    function setEditorContent(content, lang) {
      if (editorMode === 'monaco' && monacoEditor) {
        monaco.editor.setModelLanguage(monacoEditor.getModel(), lang);
        monacoEditor.setValue(content);
      } else if (editorMode === 'textarea' && fallbackTextarea) {
        fallbackTextarea.disabled = false;
        fallbackTextarea.value = content;
      }
    }

    async function saveCurrentFile() {
      if (!currentOpenFilePath || editorMode === 'none') return;
      const content = getEditorValue();
      if (content === null) return;
      const success = await ipcRenderer.invoke('save-file', currentOpenFilePath, content);
      if (success) showToast('Fichier enregistré !');
      else showToast('Erreur d\'enregistrement.', 'error');
    }

    // Rendu
    // --- Issue #6 : ordre personnalisé des comptes (drag-and-drop) ------------
    // L'ordre est stocké comme un tableau d'IDs dans ai_account_order.
    // Les comptes sans ordre explicite sont triés alphabétiquement (fallback).
    function getAccountOrder() {
      try {
        const raw = localStorage.getItem(ORDER_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return null;
        return parsed.filter(id => typeof id === 'string');
      } catch (e) { return null; }
    }

    function saveAccountOrder(orderList) {
      try { localStorage.setItem(ORDER_KEY, JSON.stringify(orderList)); }
      catch (e) { /* non bloquant */ }
    }

    // Trie les comptes : ordre personnalisé d'abord, puis alphabétique pour
    // les comptes sans ordre explicite (nouveaux comptes, comptes importés).
    function sortAccountsByOrder(list) {
      const order = getAccountOrder();
      if (!order || order.length === 0) {
        return [...list].sort((a, b) => compareAccountNames(a.name, b.name));
      }
      const orderMap = new Map();
      order.forEach((id, idx) => orderMap.set(id, idx));
      const fallback = list.length + 1000;
      return [...list].sort((a, b) => {
        const ia = orderMap.has(a.id) ? orderMap.get(a.id) : fallback;
        const ib = orderMap.has(b.id) ? orderMap.get(b.id) : fallback;
        if (ia !== ib) return ia - ib;
        return compareAccountNames(a.name, b.name);
      });
    }

    // Nettoie l'ordre : supprime les IDs de comptes supprimés.
    function pruneAccountOrder(currentAccounts) {
      const order = getAccountOrder();
      if (!order) return;
      const validIds = new Set(currentAccounts.map(a => a.id));
      const pruned = order.filter(id => validIds.has(id));
      // Ajoute les nouveaux comptes à la fin
      currentAccounts.forEach(a => { if (!pruned.includes(a.id)) pruned.push(a.id); });
      saveAccountOrder(pruned);
    }

    function renderAccounts() {
      const container = document.getElementById('accountsList');
      if (accounts.length === 0) {
        // État vide : appel à l'action pour créer un premier compte. Le bouton
        // porte data-action="add" -> géré par la délégation (aucun onclick, aucune
        // donnée utilisateur ici de toute façon).
        container.innerHTML = `
          <div class="tabs-empty--full">
            <div>Aucun compte pour l'instant.</div>
            <button class="btn btn--primary" data-action="add"><span class="ic" data-icon="plus"></span> Créer mon premier compte</button>
          </div>`;
        hydrateIcons(container);
        updateStats(); // remet les stats à 0 (ex. après suppression du dernier compte)
        return;
      }

      // Issue #6 : ordre personnalisé (drag-and-drop) d'abord, fallback
      // alphabétique pour les comptes sans ordre explicite. accounts[] lui-même
      // garde son ordre de stockage -> aucun impact sur saveAccounts()/raccourcis.
      const sortedAccounts = sortAccountsByOrder(accounts);
      container.innerHTML = sortedAccounts.map((acc, idx) => {
        // Toute donnée issue du compte (nom, email, profil, couleur) est saisie
        // par l'utilisateur -> échappée avant injection (chantier A).
        const initials = escapeHtml(String(acc.name).slice(0, 2).toUpperCase());
        const color = escapeHtml(acc.color || COLORS[idx % COLORS.length]);
        const id = escapeHtml(acc.id);
        const isActive = acc.id === activeAccountId;
        const isCollapsed = collapsedAccounts.has(acc.id);
        // Puces de statut (lot 16/09/2026, déplacées par l'issue #137) : une
        // par bouton d'IA, calculée par couple (compte, service) avec les mêmes
        // règles bleu/rouge/vert — voir getServiceActivityStatus().
        const lastUsedBySvc = acc.automation ? acc.automation.lastUsedBySvc : null;
        // Résumé « N/7 » de la carte repliée : même test de disponibilité que
        // updateStats -> reste synchro avec le tick des cooldowns (re-render 1×/min).
        const availCount = acc.services.filter(sid => !acc.cooldowns[sid] || acc.cooldowns[sid] <= Date.now()).length;

        const servicesHtml = acc.services.map(sid => {
          const svc = SERVICES.find(s => s.id === sid);
          if (!svc) return '';
          const cdTime = acc.cooldowns[sid] || 0;
          const isOnCooldown = cdTime > Date.now();
          const btnClass = isOnCooldown ? `${svc.cssClass} cooldown-active` : svc.cssClass;
          // svc.id vient de SERVICES (valeurs sûres codées en dur). Les actions
          // passent par des data-* lus par la délégation d'événements (chantier A) :
          // plus aucune donnée n'est injectée dans un attribut onclick.
          return `
            <div class="service-column">
              <button class="svc-btn ${btnClass}" data-action="open-service" data-acc="${id}" data-svc="${svc.id}">${escapeHtml(svc.name)}${svcStatusDot(acc, svc.id, lastUsedBySvc)}${isTabStarredById(acc.id, svc.id) ? '<span class="svc-btn__star"><span class="ic" data-icon="star"></span></span>' : ''}</button>
            </div>
          `;
        }).join('');

        // Le header entier bascule le repli (data-action="toggle-collapse") :
        // les boutons éditer/supprimer imbriqués portent leur propre data-action,
        // que closest() résout en priorité -> aucun conflit de clic.
        return `
          <div class="account-card ${isActive ? 'active' : ''} ${isCollapsed ? 'collapsed' : ''}" draggable="true" data-acc="${id}">
            <div class="account-header" data-action="toggle-collapse" data-acc="${id}">
              <div class="account-avatar" data-avatar-color="${color}">${initials}</div>
              <div class="account-info">
                <div class="account-name">${escapeHtml(acc.name)} ${isActive ? '<span class="active-dot"></span>' : ''}</div>
                <div class="account-email"><span class="account-email-copy" data-action="copy-email" data-acc="${id}" title="Cliquer pour copier l'e-mail">${escapeHtml(acc.email)}</span> • ${escapeHtml(acc.profile)}</div>
              </div>
              <div class="account-actions">
                <button class="btn btn--icon" data-action="edit" data-acc="${id}"><span class="ic" data-icon="pen"></span></button>
                <button class="btn btn--icon" data-action="delete" data-acc="${id}"><span class="ic icon-danger" data-icon="trash"></span></button>
              </div>
              <span class="svc-summary ${availCount < acc.services.length ? 'has-cd' : ''}" title="${availCount} service(s) hors cooldown sur ${acc.services.length}">${availCount}/${acc.services.length}</span>
              <span class="ic collapse-chevron" data-icon="chevron-down" title="Replier / déplier"></span>
            </div>
            <div class="services-wrap"><div class="services-inner">
              <div class="services-grid">${servicesHtml}</div>
            </div></div>
          </div>
        `;
      }).join('');
      applyDataColors(container); // lot 9 : couleurs dynamiques (avatars)
      hydrateIcons(container); // remplit les icônes SVG des boutons éditer/supprimer
      updateStats();
    }

    // Issue #137 : puce de statut d'un bouton d'IA (compte, service).
    function svcStatusDot(acc, svcId, lastUsedBySvc, now) {
      const status = getServiceActivityStatus({ tabs, accId: acc.id, svcId, lastUsedBySvc, now });
      return `<span class="status-dot status-dot--${status}" title="${activityStatusTitle(status)}"></span>`;
    }

    function updateStats() {
      let activeAccounts = 0, availableIAs = 0;
      accounts.forEach(acc => {
        let hasAvailable = false;
        acc.services.forEach(sid => {
          if (!acc.cooldowns[sid] || acc.cooldowns[sid] <= Date.now()) { availableIAs++; hasAvailable = true; }
        });
        if (hasAvailable) activeAccounts++;
      });
      document.getElementById('statActive').textContent = activeAccounts;
      document.getElementById('statAvailable').textContent = availableIAs;
      // Oriente le chevron du bouton « Tout replier / déplier » selon l'état
      // global (appelé dans les deux branches de renderAccounts, y c. liste vide).
      const allBtn = document.getElementById('btnToggleAllCards');
      if (allBtn) allBtn.classList.toggle('all-collapsed', accounts.length > 0 && accounts.every(a => collapsedAccounts.has(a.id)));
    }

    window.toggleDashboard = function() {
      const dash = document.getElementById('dashboard');
      const btnShow = document.getElementById('btnShowDashboard');
      const btnHide = document.getElementById('btnHideDashboard');
      dash.classList.toggle('collapsed');
      const collapsed = dash.classList.contains('collapsed');
      btnShow.style.display = collapsed ? 'flex' : 'none';
      btnHide.style.display = collapsed ? 'none' : 'flex';
    }

    // Issue #149 : palette ouverte au clavier (Ctrl+K) ou par le bouton à côté
    // des compteurs.
    window.openPalette = function() {
      document.getElementById('paletteOverlay').classList.add('open');
      document.getElementById('paletteInput').focus();
      filterPalette();
    }

    // Issue #149 : les outils de développement quittent le menu natif (masqué)
    // pour un bouton de la barre du workspace. Le main process ne les ouvre que
    // pour la fenêtre principale (canal app:toggle-devtools).
    window.toggleDevTools = function() {
      return window.iaoAPI.ipcInvoke('app:toggle-devtools').catch(() => false);
    }

    window.toggleExplorer = function() { document.getElementById('fileExplorer').classList.toggle('collapsed'); }
    window.toggleIdePanel = function() {
      const p = document.getElementById('idePanel');
      p.classList.toggle('collapsed');
      // Monaco paresseux : chargé à la 1re OUVERTURE du panneau éditeur.
      if (!p.classList.contains('collapsed')) ensureMonacoLoaded();
    }

    // Ouvre un service pour un compte donné : réutilise l'onglet existant s'il
    // y en a déjà un pour ce couple (compte, service), sinon en crée un nouveau.
    window.openService = function(accId, svcId) {
      const acc = accounts.find(a => a.id === accId);
      const svc = SERVICES.find(s => s.id === svcId);
      if (!acc || !svc) return;

      activeAccountId = accId;
      // Ordonnanceur (chantier E) : trace l'ouverture manuelle du profil, pour
      // distinguer lastUsedAt (usage manuel) de lastAutomationAt (usage par
      // l'ordonnanceur) — voir migrateOldAccounts().
      if (!acc.automation) acc.automation = { enabled: true, lastUsedAt: 0, lastAutomationAt: 0 };
      acc.automation.lastUsedAt = Date.now();
      // Issue #137 : horodatage par service pour la puce du bouton d'IA.
      if (!acc.automation.lastUsedBySvc || typeof acc.automation.lastUsedBySvc !== 'object') acc.automation.lastUsedBySvc = {};
      acc.automation.lastUsedBySvc[svcId] = acc.automation.lastUsedAt;
      saveAccounts(accounts);
      // Ouvrir un service (carte OU palette Ctrl+K) déplie la carte concernée :
      // confirmation visuelle du compte utilisé même si elle était repliée.
      if (collapsedAccounts.has(accId)) { collapsedAccounts.delete(accId); saveCollapsed(); }
      renderAccounts();

      // Un onglet existe déjà pour ce compte + service : on l'active simplement,
      // pas de nouvelle webview (pas de rechargement, pas de RAM en plus).
      const existing = tabs.find(t => t.accId === accId && t.svcId === svcId);
      if (existing) {
        activateTab(existing.id);
        showToast(`${svc.name} — ${acc.name} déjà ouvert`);
        return;
      }

      const tabId = 'tab_' + (++tabSeq);
      const pane = document.createElement('div');
      pane.className = 'tab-pane';
      pane.id = tabId;
      document.getElementById('tabsContent').appendChild(pane);

      // Barre d'actions de l'onglet (lot 17/09/2026, FEATURES.md P1) :
      // recharger / accueil du service / déconnexion du profil. Délégation
      // d'événements sur #tabsContent (voir plus bas) : data-tab porte l'id
      // interne de l'onglet (généré ci-dessus, jamais une donnée utilisateur),
      // pas besoin d'escapeHtml() dessus — seul le title="" ci-dessous
      // interpole des données de compte/service, donc échappé.
      const toolbar = document.createElement('div');
      toolbar.className = 'tab-toolbar';
      toolbar.innerHTML = `
        <button type="button" class="tab-toolbar__btn" data-action="tab-reload" data-tab="${tabId}" title="Recharger l'onglet"><span class="ic" data-icon="arrow-rotate-right"></span></button>
        <button type="button" class="tab-toolbar__btn" data-action="tab-home" data-tab="${tabId}" title="Revenir à l'accueil de ${escapeHtml(svc.name)}"><span class="ic" data-icon="house"></span></button>
        <button type="button" class="tab-toolbar__btn tab-toolbar__btn--danger" data-action="tab-disconnect" data-tab="${tabId}" title="Se déconnecter du profil « ${escapeHtml(acc.profile)} »"><span class="ic" data-icon="right-from-bracket"></span></button>
      `;
      pane.appendChild(toolbar);
      hydrateIcons(toolbar);

      // Feedback de chargement : spinner + nom du service/compte le temps que la
      // page charge (avant : panneau noir muet pendant plusieurs secondes).
      // L'animation CSS ne vit que tant que l'overlay existe -> coût nul ensuite.
      const loading = document.createElement('div');
      loading.className = 'tab-loading';
      loading.innerHTML = `<div class="tab-spinner"></div><span>Connexion à ${escapeHtml(svc.name)} — ${escapeHtml(acc.name)}…</span>`;
      pane.appendChild(loading);

      const webview = document.createElement('webview');
      webview.setAttribute('partition', `persist:${acc.profile}`);
      webview.setAttribute('src', svc.url);
      webview.setAttribute('allowpopups', '');
      webview.style.width = '100%';
      webview.style.height = '100%';
      pane.appendChild(webview);

      // Retiré au 1er rendu du service ; filet de 10 s si l'événement ne vient
      // jamais (webview morte) pour ne jamais masquer l'onglet.
      const clearLoading = () => loading.remove();
      webview.addEventListener('dom-ready', clearLoading, { once: true });
      setTimeout(clearLoading, 10000);

      // lastFocusAt initialisé ici (puis maintenu par activateTab) : lot
      // 16/09/2026, rappel visuel « onglet inactif depuis 5 min ».
      tabs.push({ id: tabId, accId, svcId, paneEl: pane, lastFocusAt: Date.now() });
      saveOpenTabs(); // lot 18/09/2026 : persistance pour startWithLastSession
      renderTabsBar();
      activateTab(tabId);
      showToast(`${svc.name} ouvert avec ${acc.name}`);
      // Le renderAccounts() plus haut (avant la création de l'onglet) ne
      // voyait pas encore ce nouvel onglet : on re-rend pour que le badge de
      // statut du compte passe bleu « ouvert » immédiatement (lot 16/09/2026).
      renderAccounts();
    }

    // Réaffiche la barre d'onglets à partir de tabs[] (source de vérité unique).
    // Délégation d'événements (chantier A) : aucun onclick avec donnée interpolée.
    // Lot 16/09/2026 : titre/sous-titre inversés (compte en gras en 1re ligne,
    // service en 2e — cf. .tab__label/.tab__acc) + reflet visuel « inactif
    // depuis 5 min » via isTabIdle(t.lastFocusAt) (lib/activity-status.js).
    function renderTabsBar() {
      const bar = document.getElementById('tabsBar');
      const now = Date.now();
      bar.innerHTML = tabs.map(t => {
        const acc = accounts.find(a => a.id === t.accId);
        const svc = SERVICES.find(s => s.id === t.svcId);
        if (!acc || !svc) return '';
        const isActive = t.id === activeTabId;
        const isIdle = isTabIdle(t.lastFocusAt, now, 5);
        const starred = isTabStarredById(t.accId, t.svcId);
        const cls = ['tab', isActive ? 'active' : '', isIdle ? 'tab--idle' : '', starred ? 'tab--starred' : ''].filter(Boolean).join(' ');
        const starHtml = starred ? '<span class="tab__star"><span class="ic" data-icon="star"></span></span>' : '';
        return `
          <div class="${cls}" draggable="true" data-action="activate-tab" data-tab="${t.id}" data-acc="${t.accId}" data-svc="${t.svcId}" title="${escapeHtml(acc.name)} — ${escapeHtml(svc.name)}">
            <span class="tab__dot svc-bg-${svc.id}"></span>
            ${starHtml}
            <span class="tab__text">
              <span class="tab__label">${escapeHtml(acc.name)}</span>
              <span class="tab__acc">${escapeHtml(svc.name)}</span>
            </span>
            <span class="tab__close" data-action="close-tab" data-tab="${t.id}" title="Fermer l'onglet"><span class="ic" data-icon="times-circle"></span></span>
          </div>
        `;
      }).join('');
      hydrateIcons(bar);
    }

    // Affiche l'onglet demandé (et masque les autres) ; les webviews inactives
    // restent en mémoire (juste cachées), comme un navigateur classique — pour
    // libérer la RAM d'un onglet précis, utiliser la fermeture (×).
    // lastFocusAt (lot 16/09/2026) : horodatage LOCAL du dernier passage au
    // premier plan, pour le rappel visuel « inactif depuis 5 min » — ne lit
    // jamais le contenu de la <webview>.
    function activateTab(tabId) {
      activeTabId = tabId;
      const tab = tabs.find(t => t.id === tabId);
      if (tab) tab.lastFocusAt = Date.now();
      document.querySelectorAll('.tab-pane').forEach(p => p.classList.toggle('active', p.id === tabId));
      document.getElementById('tabsEmpty').style.display = tabId ? 'none' : 'flex';
      renderTabsBar();
    }

    // Ferme un onglet : détruit sa <webview> (le process invité Chromium est
    // libéré, même mécanique que l'ancien « Fermer le panneau 2 »), retire
    // l'onglet de tabs[] et bascule sur un onglet voisin s'il en reste un.
    window.closeTab = function(tabId) {
      const idx = tabs.findIndex(t => t.id === tabId);
      if (idx === -1) return;

      // Confirmation avant fermeture si le réglage est activé (lot 18/09/2026)
      if (currentSettings && currentSettings.confirmBeforeClose) {
        const tab = tabs[idx];
        const acc = accounts.find(a => a.id === tab.accId);
        const svc = SERVICES.find(s => s.id === tab.svcId);
        const label = (acc ? escapeHtml(acc.name) : '?') + ' — ' + (svc ? escapeHtml(svc.name) : '?');
        showConfirmDialog(
          'Fermer l\'onglet',
          'Fermer l\'onglet « ' + label + ' » ? La session web sera libérée.',
          function() { _doCloseTab(tabId); }
        );
      } else {
        _doCloseTab(tabId);
      }
    }

    function _doCloseTab(tabId) {
      const idx = tabs.findIndex(t => t.id === tabId);
      if (idx === -1) return;
      const [tab] = tabs.splice(idx, 1);
      tab.paneEl.remove(); // innerHTML/remove détruit la <webview> -> libère la mémoire

      if (activeTabId === tabId) {
        const next = tabs[idx] || tabs[idx - 1] || null;
        activateTab(next ? next.id : null);
      } else {
        renderTabsBar();
      }
      // Le badge de statut du compte (bleu « ouvert ») dépend de tabs[] —
      // re-rendu ici pour repasser rouge/vert dès la fermeture (lot 16/09/2026).
      renderAccounts();
      saveOpenTabs(); // lot 18/09/2026 : persistance pour startWithLastSession
      showToast('Onglet fermé (mémoire libérée)');
    }

    document.getElementById('tabsBar').addEventListener('click', (e) => {
      const el = e.target.closest('[data-action]');
      if (!el) return;
      const tabId = el.getAttribute('data-tab');
      if (el.getAttribute('data-action') === 'close-tab') closeTab(tabId);
      else activateTab(tabId);
    });

    // Issue #154 : Menu contextuel (clic droit) sur les onglets.
    // Permet d'étoiler / désétoiler un onglet pour le mettre en valeur.
    let ctxMenuEl = null;
    function closeContextMenu() {
      if (ctxMenuEl) { ctxMenuEl.remove(); ctxMenuEl = null; }
    }
    document.addEventListener('click', closeContextMenu);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeContextMenu(); });

    document.getElementById('tabsBar').addEventListener('contextmenu', (e) => {
      const tabEl = e.target.closest('.tab');
      if (!tabEl) return;
      e.preventDefault();
      closeContextMenu();

      const tabId = tabEl.getAttribute('data-tab');
      const accId = tabEl.getAttribute('data-acc');
      const svcId = tabEl.getAttribute('data-svc');
      const tab = tabs.find(t => t.id === tabId);
      if (!tab) return;
      const acc = accounts.find(a => a.id === accId);
      const svc = SERVICES.find(s => s.id === svcId);
      if (!acc || !svc) return;
      const starred = isTabStarredById(accId, svcId);

      ctxMenuEl = document.createElement('div');
      ctxMenuEl.className = 'ctx-menu';
      ctxMenuEl.innerHTML = `
        <div class="ctx-menu__item" data-ctx-action="toggle-star">
          <span class="ic" data-icon="star"></span>
          <span>${starred ? 'Retirer l\'étoile' : 'Étoiler cet onglet'}</span>
        </div>
        <div class="ctx-menu__sep"></div>
        <div class="ctx-menu__item" data-ctx-action="close-tab">
          <span class="ic" data-icon="times-circle"></span>
          <span>Fermer l'onglet</span>
        </div>
      `;
      document.body.appendChild(ctxMenuEl);
      hydrateIcons(ctxMenuEl);

      // Positionner le menu près du curseur, sans déborder de la fenêtre.
      const rect = ctxMenuEl.getBoundingClientRect();
      let x = e.clientX, y = e.clientY;
      if (x + rect.width > window.innerWidth) x = window.innerWidth - rect.width - 4;
      if (y + rect.height > window.innerHeight) y = window.innerHeight - rect.height - 4;
      ctxMenuEl.style.left = x + 'px';
      ctxMenuEl.style.top = y + 'px';

      ctxMenuEl.addEventListener('click', (ev) => {
        const item = ev.target.closest('[data-ctx-action]');
        if (!item) return;
        const action = item.getAttribute('data-ctx-action');
        closeContextMenu();
        if (action === 'toggle-star') {
          toggleTabStarById(accId, svcId);
          renderTabsBar();
          renderAccounts();
          showToast(isTabStarredById(accId, svcId) ? 'Onglet étoilé' : 'Étoile retirée');
        } else if (action === 'close-tab') {
          closeTab(tabId);
        }
      });
    });

    // Réorganisation des onglets par glisser-déposer (lot 16/09/2026). HTML5
    // Drag and Drop natif — aucune dépendance ajoutée (invariant 7) — délégué
    // sur #tabsBar comme le clic ci-dessus, pas de listener par onglet à
    // ré-attacher à chaque renderTabsBar(). Ne déplace que des entrées de
    // tabs[] ; aucune interaction avec le contenu des <webview>.
    let dragTabId = null;
    document.getElementById('tabsBar').addEventListener('dragstart', (e) => {
      const el = e.target.closest('.tab');
      if (!el) return;
      dragTabId = el.getAttribute('data-tab');
      e.dataTransfer.effectAllowed = 'move';
      el.classList.add('tab--dragging');
    });
    document.getElementById('tabsBar').addEventListener('dragend', (e) => {
      const el = e.target.closest('.tab');
      if (el) el.classList.remove('tab--dragging');
      dragTabId = null;
    });
    document.getElementById('tabsBar').addEventListener('dragover', (e) => {
      if (!dragTabId) return;
      e.preventDefault(); // requis par le navigateur pour autoriser le drop
      e.dataTransfer.dropEffect = 'move';
    });
    document.getElementById('tabsBar').addEventListener('drop', (e) => {
      e.preventDefault();
      const targetEl = e.target.closest('.tab');
      if (!dragTabId || !targetEl) return;
      const targetTabId = targetEl.getAttribute('data-tab');
      if (targetTabId === dragTabId) return;
      const fromIdx = tabs.findIndex(t => t.id === dragTabId);
      const toIdx = tabs.findIndex(t => t.id === targetTabId);
      if (fromIdx === -1 || toIdx === -1) return;
      const [moved] = tabs.splice(fromIdx, 1);
      tabs.splice(toIdx, 0, moved);
      renderTabsBar();
    });

    // Actions sur un onglet ouvert (lot 17/09/2026, FEATURES.md P1) : recharger,
    // revenir à l'accueil du service, se déconnecter du profil. Un seul
    // listener délégué sur #tabsContent (conteneur stable, comme #tabsBar
    // plus haut) plutôt qu'un par bouton de barre d'outils — pas de
    // ré-attachement à chaque ouverture d'onglet.
    function reloadTab(tabId) {
      const tab = tabs.find(t => t.id === tabId);
      if (!tab) return;
      const webview = tab.paneEl.querySelector('webview');
      if (webview) webview.reload();
    }

    function tabGoHome(tabId) {
      const tab = tabs.find(t => t.id === tabId);
      if (!tab) return;
      const svc = SERVICES.find(s => s.id === tab.svcId);
      const webview = tab.paneEl.querySelector('webview');
      if (webview && svc) webview.loadURL(svc.url);
    }

    // Déconnexion : purge la partition Electron du compte (cookies + stockage
    // web) -> TOUS les onglets ouverts de ce compte sont concernés, pas
    // seulement celui d'où l'action a été lancée (voir tabsForAccount,
    // lib/tab-actions.js). Destructif : confirmation obligatoire.
    let pendingDisconnectAccId = null;
    window.openDisconnectModal = function(tabId) {
      const tab = tabs.find(t => t.id === tabId);
      if (!tab) return;
      const acc = accounts.find(a => a.id === tab.accId);
      if (!acc) return;
      pendingDisconnectAccId = acc.id;
      const affected = tabsForAccount(tabs, acc.id);
      document.getElementById('disconnectDesc').textContent = buildDisconnectWarning({
        accountName: acc.name,
        profile: acc.profile,
        affectedTabsCount: affected.length
      });
      document.getElementById('disconnectModal').classList.add('open');
    }
    window.closeDisconnectModal = function() {
      pendingDisconnectAccId = null;
      document.getElementById('disconnectModal').classList.remove('open');
    }
    window.confirmDisconnect = async function() {
      const accId = pendingDisconnectAccId;
      closeDisconnectModal();
      const acc = accounts.find(a => a.id === accId);
      if (!acc) return;
      const res = await ipcRenderer.invoke('accounts:disconnect-profile', acc.profile);
      if (!res || !res.ok) { showToast('Échec de la déconnexion du profil'); return; }
      // Toutes les webviews de ce compte doivent recharger pour repartir sur
      // une session vierge (les cookies qu'elles avaient en mémoire ne sont
      // pas invalidés tant qu'elles ne rechargent pas).
      tabsForAccount(tabs, acc.id).forEach(t => {
        const webview = t.paneEl.querySelector('webview');
        if (webview) webview.reload();
      });
      showToast(`Profil « ${acc.profile} » déconnecté — session effacée`);
    }
    document.getElementById('tabsContent').addEventListener('click', (e) => {
      const el = e.target.closest('[data-action]');
      if (!el) return;
      const tabId = el.getAttribute('data-tab');
      const action = el.getAttribute('data-action');
      if (action === 'tab-reload') reloadTab(tabId);
      else if (action === 'tab-home') tabGoHome(tabId);
      else if (action === 'tab-disconnect') openDisconnectModal(tabId);
    });

    // Fichiers
    // Lot 18/09/2026 : lecture récursive (sous-dossiers) + recherche par nom.
    // La liste plate est conservée dans currentFileList pour le filtrage
    // ultérieur sans re-lire le disque.
    let currentFileList = [];

    window.selectLocalFolder = async function() {
      const folderPath = await ipcRenderer.invoke('select-folder');
      if (!folderPath) return;
      const files = await ipcRenderer.invoke('read-directory-recursive', folderPath);
      currentFileList = files;
      // Affiche le champ de recherche (lot 18/09/2026)
      const searchInput = document.getElementById('fileSearchInput');
      searchInput.style.display = 'block';
      searchInput.value = '';
      renderFileList(currentFileList);
    }

    function renderFileList(files) {
      const list = document.getElementById('fileList');
      if (!files.length) {
        list.innerHTML = '<div class="file-list-empty">Aucun fichier trouvé.</div>';
        return;
      }
      // Le chemin et le nom du fichier viennent du système de fichiers : ils
      // peuvent contenir des guillemets / caractères HTML -> échappés, et passés
      // par data-* (lus par la délégation, chantier A) plutôt que dans un onclick.
      list.innerHTML = files.map(f => {
        const relPath = f.relativePath && f.relativePath !== f.name
          ? `<span class="file-item__relpath">${escapeHtml(f.relativePath)}</span>`
          : '';
        return `
        <div class="file-item" data-path="${escapeHtml(f.path)}" data-name="${escapeHtml(f.name)}">
          <span class="ic file-icon-dim" data-icon="file-code"></span> ${escapeHtml(f.name)}${relPath}
        </div>
      `;
      }).join('');
      hydrateIcons(list);
    }

    window.onFileSearch = function() {
      const query = document.getElementById('fileSearchInput').value;
      renderFileList(filterFiles(currentFileList, query));
    }

    window.loadFileInEditor = async function(filePath, fileName, el) {
      const res = await ipcRenderer.invoke('read-file', filePath);
      // Fichier trop volumineux : main renvoie un sentinel {error:'too_large'}.
      if (res && typeof res === 'object' && res.error === 'too_large') {
        showToast('Fichier trop volumineux pour l\'éditeur : ' + Math.round(res.size / 1048576) + ' Mo (limite : 20 Mo).', 'error');
        return;
      }
      if (res === null) return; // fichier illisible (permissions, disparu…)
      const content = res;

      currentOpenFilePath = filePath;
      document.getElementById('activeFileName').textContent = fileName;
      
      document.querySelectorAll('.file-item').forEach(e => e.classList.remove('active'));
      el.classList.add('active');

      const ext = fileName.split('.').pop();
      const langMap = { js: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript', html: 'html', css: 'css', json: 'json', md: 'markdown' };
      const lang = langMap[ext] || 'plaintext';

      setEditorContent(content, lang);
    }

    // Palette
    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        openPalette();
      }
      if (e.key === 'Escape') {
        document.getElementById('paletteOverlay').classList.remove('open');
        document.getElementById('accountModal').classList.remove('open');
        document.getElementById('deleteModal').classList.remove('open');
        document.getElementById('helpModal').classList.remove('open');
        closeImportConfirm(); // ferme + vide pendingImportContent (pas un simple classList.remove)
        closeDisconnectModal(); // ferme + vide pendingDisconnectAccId (lot 17/09/2026)
      }
      if (e.key === 'Enter' && document.getElementById('paletteOverlay').classList.contains('open')) {
        e.preventDefault();
        const sel = document.querySelector('.palette-item.selected');
        if (sel) sel.click();
      }

      // --- Navigation entre onglets IA ---
      // Ctrl+Tab / Ctrl+Maj+Tab : onglet suivant / précédent (cyclique).
      // Alt+1..9 : aller directement au Nᵉ onglet.
      // Note : quand le focus est DANS une webview, l'événement ne remonte pas
      // jusqu'ici (limite Electron) — cliquer dans l'app hôte rend les raccourcis.
      // Ctrl+W est volontairement évité : c'est l'accélérateur « fermer la
      // fenêtre » du menu Electron par défaut, qui passe avant le renderer.
      if (e.ctrlKey && e.key === 'Tab' && tabs.length > 1) {
        e.preventDefault();
        const i = tabs.findIndex(t => t.id === activeTabId);
        const next = e.shiftKey
          ? (i - 1 + tabs.length) % tabs.length
          : (i + 1) % tabs.length;
        activateTab(tabs[next].id);
      }
      if (e.altKey && !e.ctrlKey && /^[1-9]$/.test(e.key)) {
        const t = tabs[parseInt(e.key, 10) - 1];
        if (t) { e.preventDefault(); activateTab(t.id); }
      }
    });

    window.filterPalette = function() {
      const query = document.getElementById('paletteInput').value.toLowerCase();
      const results = document.getElementById('paletteResults');
      let items = [];
      accounts.forEach(acc => {
        if (acc.name.toLowerCase().includes(query) || acc.email.toLowerCase().includes(query)) {
          acc.services.forEach(sid => {
            const svc = SERVICES.find(s => s.id === sid);
            if (svc) items.push({ acc, svc });
          });
        }
      });
      results.innerHTML = items.map((item, idx) => `
        <div class="palette-item ${idx === 0 ? 'selected' : ''}" data-acc="${escapeHtml(item.acc.id)}" data-svc="${escapeHtml(item.svc.id)}">
          <div class="account-avatar account-avatar--sm" data-avatar-color="${escapeHtml(item.acc.color)}">${escapeHtml(String(item.acc.name).slice(0,2))}</div>
          <span>${escapeHtml(item.acc.name)} - ${escapeHtml(item.svc.name)}</span>
        </div>
      `).join('');
      applyDataColors(results); // lot 9 : couleurs dynamiques (avatars)
    }

    // --- Lot 9 (18/09/2026) : applique les couleurs dynamiques via element.style
    //     après innerHTML. Ces propriétés individuelles (.style.background, .style.color)
    //     ne sont PAS bloquées par CSP style-src 'self' (contrairement aux attributs
    //     style="..." qui le sont). Remplace les anciens style="background:${color}".
    function applyDataColors(container) {
      if (!container) return;
      container.querySelectorAll('[data-avatar-color]').forEach(function(el) {
        el.style.background = el.getAttribute('data-avatar-color');
      });
      container.querySelectorAll('[data-dot-color]').forEach(function(el) {
        el.style.background = el.getAttribute('data-dot-color');
      });
      container.querySelectorAll('[data-status-color]').forEach(function(el) {
        el.style.color = el.getAttribute('data-status-color');
      });
    }

    // Modals
    window.openModal = function(accId = null) {
      const modal = document.getElementById('accountModal');
      const title = document.getElementById('modalTitle');
      if (accId) {
        const acc = accounts.find(a => a.id === accId);
        title.textContent = "Modifier le compte";
        document.getElementById('editId').value = acc.id;
        document.getElementById('inputName').value = acc.name;
        document.getElementById('inputEmail').value = acc.email;
        document.getElementById('inputProfile').value = acc.profile;
      } else {
        title.textContent = "Ajouter un compte";
        document.getElementById('editId').value = '';
        document.getElementById('inputName').value = '';
        document.getElementById('inputEmail').value = '';
        // Suggère un profil NON collisionnant (`length+1` pouvait re-proposer un
        // profil déjà pris après une suppression -> sessions partagées).
        const used = new Set(accounts.map(a => a.profile));
        let n = accounts.length + 1;
        while (used.has('profil_' + n)) n++;
        document.getElementById('inputProfile').value = 'profil_' + n;
      }
      modal.classList.add('open');
    }
    window.closeModal = function() { document.getElementById('accountModal').classList.remove('open'); }

    // Modale d'aide « Comprendre les IA disponibles ». Liste régénérée à chaque
    // ouverture depuis SERVICES + SERVICE_INFO : un 10e service apparaîtra tout
    // seul (avec son nom au minimum si sa fiche SERVICE_INFO manque encore).
    // Purement informatif : ne touche ni comptes, ni cooldowns, ni webviews.
    window.openHelpModal = function() {
      const list = document.getElementById('helpList');
      // Contenu 100% statique (SERVICES + SERVICE_INFO codés en dur) -> sûr,
      // mais on garde escapeHtml par cohérence avec le reste du rendu.
      list.innerHTML = SERVICES.map(svc => {
        const info = SERVICE_INFO[svc.id];
        return `
          <div class="help-entry">
            <div class="help-entry__name"><span class="help-entry__dot svc-bg-${svc.id}"></span>${escapeHtml(svc.name)}</div>
            ${info ? `
              <div class="help-entry__line"><span class="help-entry__label">C'est quoi ?</span> ${escapeHtml(info.what)}</div>
              <div class="help-entry__line"><span class="help-entry__label">Quand l'utiliser ?</span> ${escapeHtml(info.when)}</div>
            ` : `<div class="help-entry__line help-entry__line--muted">Description à venir.</div>`}
          </div>
        `;
      }).join('');
      document.getElementById('helpModal').classList.add('open');
    }
    window.closeHelpModal = function() { document.getElementById('helpModal').classList.remove('open'); }
    // Fermeture par clic en dehors de la boîte (sur le fond assombri).
    document.getElementById('helpModal').addEventListener('click', (e) => {
      if (e.target === e.currentTarget) closeHelpModal();
    });

    // --- Issue #42 : Menu de sélection des services « à portée de main » ---
    let pendingServices = null;

    window.openServicesModal = function() {
      const list = document.getElementById('servicesList');
      const activeIds = getActiveServices();
      pendingServices = new Set(activeIds);

      list.innerHTML = SERVICES.map(svc => {
        const checked = activeIds.includes(svc.id) ? 'checked' : '';
        return `
          <div class="help-entry">
            <div class="help-entry__name">
              <label class="service-select-item">
                <input type="checkbox" data-svc-id="${escapeHtml(svc.id)}" ${checked}>
                <span class="help-entry__dot svc-bg-${svc.id}"></span>
                ${escapeHtml(svc.name)}
              </label>
            </div>
          </div>
        `;
      }).join('');

      // Délégation : mettre à jour pendingServices + compter
      list.onchange = (e) => {
        const cb = e.target;
        if (cb && cb.dataset && cb.dataset.svcId) {
          if (cb.checked) {
            if (pendingServices.size >= MAX_ACTIVE_SERVICES) {
              cb.checked = false;
              showToast('Maximum ' + MAX_ACTIVE_SERVICES + ' services à portée de main', 'error');
              return;
            }
            pendingServices.add(cb.dataset.svcId);
          } else {
            pendingServices.delete(cb.dataset.svcId);
          }
        }
      };

      document.getElementById('servicesModal').classList.add('open');
    };
    window.closeServicesModal = function() { document.getElementById('servicesModal').classList.remove('open'); pendingServices = null; };
    window.saveServicesModal = function() {
      if (!pendingServices) return closeServicesModal();
      const ids = Array.from(pendingServices);
      if (ids.length === 0) { showToast('Sélectionnez au moins 1 service', 'error'); return; }
      saveActiveServices(ids);
      closeServicesModal();
      // Mettre à jour ALL_SERVICES et re-rendre les comptes
      showToast('Services mis à jour (' + ids.length + '/' + MAX_ACTIVE_SERVICES + ')');
      // Recharger pour appliquer les changements partout
      renderAccounts();
    };
    document.getElementById('servicesModal').addEventListener('click', (e) => {
      if (e.target === e.currentTarget) closeServicesModal();
    });

    // Suppression de compte
    window.openDeleteModal = function(accId) {
      const acc = accounts.find(a => a.id === accId);
      if (!acc) return;
      document.getElementById('deleteId').value = accId;
      document.getElementById('deleteDesc').textContent =
        `Supprimer « ${acc.name} » (${acc.email}) ? La session restera stockée sur le disque, mais le compte disparaîtra de la liste.`;
      document.getElementById('deleteModal').classList.add('open');
    }
    window.closeDeleteModal = function() { document.getElementById('deleteModal').classList.remove('open'); }

    // --- Export / import JSON des comptes (branchement UI, cf. FEATURES.md P1) ---
    // Les fonctions pures exportAccountsJSON()/importAccountsJSON(text) existaient
    // déjà (chantier C) ; ce lot n'ajoute que la sélection de fichier (côté main.js,
    // IPC 'accounts:export'/'accounts:import' — dialog.showSaveDialog/showOpenDialog,
    // seul process avec accès au système de fichiers) et la confirmation d'écrasement.
    window.exportAccountsToFile = async function() {
      try {
        const res = await ipcRenderer.invoke('accounts:export', exportAccountsJSON());
        if (res && res.canceled) return; // l'utilisateur a fermé la boîte de dialogue
        if (res && res.error) { showToast('Échec de l\'export (écriture impossible)', 'error'); return; }
        showToast(`${accounts.length} compte(s) exporté(s)`);
      } catch (e) {
        console.error('[import-export] export impossible :', e);
        showToast('Export impossible', 'error');
      }
    }

    // Contenu du fichier choisi, en attente de confirmation (voir confirmImport ci-dessous).
    // Remis à null après usage ou annulation : ne doit jamais survivre à la modale.
    let pendingImportContent = null;

    window.importAccountsFromFile = async function() {
      try {
        const res = await ipcRenderer.invoke('accounts:import');
        if (res && res.canceled) return;
        if (res && res.error) { showToast('Échec de la lecture du fichier', 'error'); return; }
        let parsed;
        try { parsed = JSON.parse(res.content); }
        catch (e) { showToast('Fichier JSON invalide', 'error'); return; }
        if (!Array.isArray(parsed)) { showToast('Format invalide : un tableau de comptes est attendu.', 'error'); return; }
        pendingImportContent = res.content;
        document.getElementById('importConfirmDesc').textContent =
          `Le fichier contient ${parsed.length} compte(s). L'import REMPLACE entièrement la liste actuelle ` +
          `(${accounts.length} compte(s)) — cette action écrase les comptes existants, pas leurs sessions ` +
          `(cookies) déjà enregistrées sur le disque. Continuer ?`;
        document.getElementById('importConfirmModal').classList.add('open');
      } catch (e) {
        console.error('[import-export] import impossible :', e);
        showToast('Import impossible', 'error');
      }
    }
    window.closeImportConfirm = function() {
      pendingImportContent = null;
      document.getElementById('importConfirmModal').classList.remove('open');
    }
    // Fermeture par clic en dehors de la boîte (sur le fond assombri), comme #helpModal.
    document.getElementById('importConfirmModal').addEventListener('click', (e) => {
      if (e.target === e.currentTarget) closeImportConfirm();
    });
    window.confirmImport = function() {
      const content = pendingImportContent;
      closeImportConfirm(); // remet pendingImportContent à null avant tout, y compris en cas d'erreur
      if (!content) return;
      try {
        const count = importAccountsJSON(content); // saveAccounts() + renderAccounts() déjà inclus
        showToast(`${count} compte(s) importé(s)`);
      } catch (e) {
        console.error('[import-export] échec de l\'import :', e);
        showToast('Échec de l\'import : ' + (e.message || e), 'error');
      }
    }
    window.confirmDelete = function() {
      const id = document.getElementById('deleteId').value;
      accounts = accounts.filter(a => a.id !== id);
      if (activeAccountId === id) activeAccountId = null;
      saveCollapsed();        // purge l'état de repli du compte supprimé
      pruneAccountOrder(accounts); // issue #6 : nettoie l'ordre des comptes supprimés
      saveAccounts(accounts); // écrit + backup de la génération précédente (chantier C)
      renderAccounts();
      closeDeleteModal();
      showToast('Compte supprimé');
    }

    window.saveAccount = function() {
      const id = document.getElementById('editId').value;
      const name = document.getElementById('inputName').value.trim();
      const email = document.getElementById('inputEmail').value.trim();
      const profile = document.getElementById('inputProfile').value.trim();
      if (!name || !email || !profile) return showToast('Remplissez tous les champs', 'error');

      // Unicité du profil (chantier audit 3.1) : deux comptes partageant le même
      // `profile` utiliseraient la MÊME partition Electron (persist:<profile>) →
      // cookies/sessions mêlés entre comptes. On refuse la collision.
      if (accounts.some(a => a.id !== id && a.profile === profile)) {
        return showToast('Ce profil est déjà utilisé par un autre compte (les sessions seraient partagées).', 'error');
      }

      if (id) {
        const acc = accounts.find(a => a.id === id);
        if (!acc) return; // garde : id obsolète
        Object.assign(acc, { name, email, profile });
        showToast('Compte mis à jour');
      } else {
        accounts.push({
          id: 'acc_' + Date.now(), name, email, profile,
          color: COLORS[accounts.length % COLORS.length],
          services: SERVICES.map(s => s.id),
          cooldowns: Object.fromEntries(SERVICES.map(s => [s.id, 0])),
          automation: { enabled: true, lastUsedAt: 0, lastAutomationAt: 0 }
        });
        showToast('Compte ajouté');
      }
      saveAccounts(accounts); // écrit + backup de la génération précédente (chantier C)
      renderAccounts();
      closeModal();
    }

    // Issue #138 : clic sur l'e-mail d'un compte -> presse-papiers + toast.
    // La délégation résout data-action="copy-email" avant le toggle-collapse
    // du header (closest()), donc le clic ne replie pas la carte.
    function copyAccountEmail(accId) {
      const acc = accounts.find(a => a.id === accId);
      if (!acc || !acc.email) return;
      copyText(acc.email, { clipboard: navigator.clipboard, document }).then(ok => {
        showToast(ok ? 'E-mail copié : ' + acc.email : 'Copie impossible dans le presse-papiers', ok ? 'success' : 'error');
      });
    }

    function showToast(msg, type = 'success') {
      const toast = document.createElement('div');
      toast.className = `toast`;
      toast.style.borderLeftColor = type === 'error' ? 'var(--danger)' : type === 'warning' ? 'var(--warning)' : 'var(--accent)';
      const iconName = type === 'success' ? 'check-circle' : type === 'error' ? 'times-circle' : 'exclamation-triangle';
      // msg peut contenir une donnée utilisateur (ex. nom de compte) -> échappé (chantier A).
      toast.innerHTML = `<span class="ic" data-icon="${iconName}"></span> ${escapeHtml(msg)}`;
      hydrateIcons(toast);
      document.getElementById('toastContainer').appendChild(toast);
      setTimeout(() => { toast.style.opacity = '0'; toast.style.transform = 'translateX(100%)'; setTimeout(() => toast.remove(), 300); }, 3000);
    }

    // Modale de confirmation réutilisable (lot 18/09/2026 — réglage « Confirmer
    // avant de fermer un onglet »). Pas de onclick inline : délégation d'événements
    // (invariant 5) + escapeHtml sur le message (invariant 1).
    var _confirmCallback = null;
    function showConfirmDialog(title, message, onConfirm) {
      _confirmCallback = onConfirm;
      var modal = document.getElementById('confirmModal');
      modal.querySelector('.confirm-title').textContent = title;
      modal.querySelector('.confirm-msg').textContent = message;
      modal.classList.add('open');
    }
    function closeConfirmModal() {
      _confirmCallback = null;
      document.getElementById('confirmModal').classList.remove('open');
    }
    document.getElementById('confirmModal').addEventListener('click', function(e) {
      if (e.target === e.currentTarget) closeConfirmModal();
    });
    document.getElementById('confirmModalYes').addEventListener('click', function() {
      if (_confirmCallback) { _confirmCallback(); }
      closeConfirmModal();
    });
    document.getElementById('confirmModalNo').addEventListener('click', closeConfirmModal);

    // Colonnes redimensionnables à la souris
    function setupResizers() {
      const overlay = document.getElementById('resizeOverlay');
      const idePanel = document.getElementById('idePanel');
      const fileExplorer = document.getElementById('fileExplorer');

      // On lève les limites CSS qui empêcheraient d'agrandir/réduire librement.
      idePanel.style.maxWidth = 'none';
      idePanel.style.minWidth = '0';
      fileExplorer.style.maxWidth = 'none';
      fileExplorer.style.minWidth = '0';

      // Restaure les largeurs mémorisées (via flex-basis = taille exacte).
      // Lecture défensive (chantier C) : une valeur absente/illisible ne doit
      // jamais empêcher l'app de démarrer — on retombe simplement sur le défaut.
      try {
        const savedIde = localStorage.getItem('ide_w');
        if (savedIde) idePanel.style.flex = '0 0 ' + savedIde;
        const savedExp = localStorage.getItem('explorer_w');
        if (savedExp) fileExplorer.style.flex = '0 0 ' + savedExp;
      } catch (e) { console.warn('[storage] largeurs de colonnes ignorées :', e); }

      function makeResizer(resizer, opts) {
        if (!resizer) return;
        resizer.addEventListener('mousedown', (e) => {
          e.preventDefault();
          const startX = e.clientX;
          const startSize = opts.getStart();
          resizer.classList.add('dragging');
          overlay.classList.add('active');
          document.body.style.userSelect = 'none';

          function move(ev) {
            const max = typeof opts.max === 'function' ? opts.max() : opts.max;
            let next = startSize + (ev.clientX - startX);
            next = Math.max(opts.min, Math.min(max, next));
            opts.apply(next);
          }
          function up() {
            document.removeEventListener('mousemove', move);
            document.removeEventListener('mouseup', up);
            resizer.classList.remove('dragging');
            overlay.classList.remove('active');
            document.body.style.userSelect = '';
            if (opts.onEnd) opts.onEnd();
          }
          document.addEventListener('mousemove', move);
          document.addEventListener('mouseup', up);
        });
      }

      // Éditeur (largeur du panneau IDE) ↔ panneaux IA
      makeResizer(document.getElementById('resizerIde'), {
        el: idePanel,
        getStart: () => idePanel.getBoundingClientRect().width,
        min: 260,
        max: () => document.querySelector('.workspace-body').getBoundingClientRect().width - 320,
        apply: (w) => { idePanel.style.flex = '0 0 ' + w + 'px'; },
        onEnd: () => { try { localStorage.setItem('ide_w', Math.round(idePanel.getBoundingClientRect().width) + 'px'); } catch (e) {} }
      });

      // Explorateur de fichiers ↔ éditeur
      makeResizer(document.getElementById('resizerExplorer'), {
        el: fileExplorer,
        getStart: () => fileExplorer.getBoundingClientRect().width,
        min: 120,
        max: () => idePanel.getBoundingClientRect().width - 160,
        apply: (w) => { fileExplorer.style.flex = '0 0 ' + w + 'px'; },
        onEnd: () => { try { localStorage.setItem('explorer_w', Math.round(fileExplorer.getBoundingClientRect().width) + 'px'); } catch (e) {} }
      });
    }
    setupResizers();

    // --- Délégation d'événements (chantier A) ---
    // Les listes rendues dynamiquement (comptes, palette, fichiers) n'ont plus
    // d'attributs onclick. On écoute UN seul clic sur chaque conteneur STABLE et
    // on lit l'action + les identifiants dans les data-*. Le vecteur d'injection
    // (valeur utilisateur interpolée dans un onclick) disparaît complètement.
    document.getElementById('accountsList').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      const accId = btn.getAttribute('data-acc');
      const svcId = btn.getAttribute('data-svc');
      switch (btn.getAttribute('data-action')) {
        case 'add':             openModal(); break;
        case 'open-service':    openService(accId, svcId); break;
        case 'edit':            openModal(accId); break;
        case 'delete':          openDeleteModal(accId); break;
        case 'toggle-collapse': toggleCardCollapse(accId); break;
        case 'copy-email':      copyAccountEmail(accId); break;
      }
    });

    // --- Issue #6 : drag-and-drop pour réorganiser les comptes ------------
    // Délégation d'événements sur le conteneur (même pattern que le clic).
    // HTML5 Drag and Drop API natif — aucune dépendance externe.
    let draggedAccId = null;
    let draggedOverId = null;

    const accountsListEl = document.getElementById('accountsList');

    accountsListEl.addEventListener('dragstart', (e) => {
      const card = e.target.closest('.account-card');
      if (!card) return;
      draggedAccId = card.getAttribute('data-acc');
      card.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      // dataTransfer.setData requis par Firefox pour initier le drag
      try { e.dataTransfer.setData('text/plain', draggedAccId); } catch (_) { /* ignore */ }
    });

    accountsListEl.addEventListener('dragend', (e) => {
      const card = e.target.closest('.account-card');
      if (card) card.classList.remove('dragging');
      // Nettoie les indicateurs visuels
      accountsListEl.querySelectorAll('.account-card.drag-over').forEach(c => c.classList.remove('drag-over'));
      draggedAccId = null;
      draggedOverId = null;
    });

    accountsListEl.addEventListener('dragover', (e) => {
      if (!draggedAccId) return;
      e.preventDefault(); // autorise le drop
      e.dataTransfer.dropEffect = 'move';
      const card = e.target.closest('.account-card');
      if (!card || card.getAttribute('data-acc') === draggedAccId) return;
      const overId = card.getAttribute('data-acc');
      if (draggedOverId !== overId) {
        // Nettoie l'ancien indicateur
        if (draggedOverId) {
          const old = accountsListEl.querySelector('.account-card[data-acc="' + CSS.escape(draggedOverId) + '"]');
          if (old) old.classList.remove('drag-over');
        }
        card.classList.add('drag-over');
        draggedOverId = overId;
      }
    });

    accountsListEl.addEventListener('dragleave', (e) => {
      // Nettoie seulement si on quitte vraiment le conteneur
      if (!accountsListEl.contains(e.relatedTarget)) {
        accountsListEl.querySelectorAll('.account-card.drag-over').forEach(c => c.classList.remove('drag-over'));
        draggedOverId = null;
      }
    });

    accountsListEl.addEventListener('drop', (e) => {
      if (!draggedAccId || !draggedOverId || draggedAccId === draggedOverId) return;
      e.preventDefault();

      // Reconstruit l'ordre : prend l'ordre actuel, déplace draggedAccId
      // à la position de draggedOverId.
      const currentOrder = sortAccountsByOrder(accounts).map(a => a.id);
      const fromIdx = currentOrder.indexOf(draggedAccId);
      const toIdx = currentOrder.indexOf(draggedOverId);
      if (fromIdx === -1 || toIdx === -1 || fromIdx === toIdx) return;

      currentOrder.splice(fromIdx, 1);
      currentOrder.splice(toIdx, 0, draggedAccId);
      saveAccountOrder(currentOrder);
      renderAccounts();
    });

    document.getElementById('paletteResults').addEventListener('click', (e) => {
      const item = e.target.closest('[data-acc]');
      if (!item) return;
      openService(item.getAttribute('data-acc'), item.getAttribute('data-svc'));
      document.getElementById('paletteOverlay').classList.remove('open');
    });

    document.getElementById('fileList').addEventListener('click', (e) => {
      const item = e.target.closest('.file-item');
      if (!item) return;
      loadFileInEditor(item.getAttribute('data-path'), item.getAttribute('data-name'), item);
    });

    // Lot 16/09/2026 : rafraîchissement ciblé par textContent (ne touche que
    // la puce + son title, pas de renderAccounts() complet).
    // Issue #137 : une puce par bouton d'IA (compte, service).
    function refreshAccountStatusDots() {
      const now = Date.now();
      document.querySelectorAll('#accountsList .svc-btn[data-action="open-service"]').forEach(btn => {
        const acc = accounts.find(a => a.id === btn.getAttribute('data-acc'));
        const dot = btn.querySelector('.status-dot');
        if (!acc || !dot) return;
        const status = getServiceActivityStatus({
          tabs, accId: acc.id, svcId: btn.getAttribute('data-svc'), now,
          lastUsedBySvc: acc.automation ? acc.automation.lastUsedBySvc : null
        });
        dot.className = `status-dot status-dot--${status}`;
        dot.title = activityStatusTitle(status);
      });
    }

    // Bascule tab--idle sur chaque onglet sans reconstruire toute la barre
    // (lot 16/09/2026) — même esprit que les deux fonctions ci-dessus.
    function refreshTabIdleClasses() {
      const now = Date.now();
      document.querySelectorAll('#tabsBar .tab').forEach(el => {
        const tab = tabs.find(t => t.id === el.getAttribute('data-tab'));
        if (!tab) return;
        el.classList.toggle('tab--idle', isTabIdle(tab.lastFocusAt, now, 5));
      });
    }

    // Tick cooldowns (1 s) : remet à 0 les cooldowns expirés (re-render pour
    // réactiver le bouton de service). Issue #136 : le bouton manuel de cooldown
    // est retiré, plus aucun cooldown n'est créé depuis l'interface ; ce tick
    // laisse expirer normalement ceux déjà enregistrés dans les comptes.
    // Coût d'un tick sans cooldown actif : boucle comptes x services pure (µs).
    //
    // Lot 18/09/2026 : notification de fin de cooldown. On compare le snapshot
    // des cooldowns actifs au tick précédent avec l'état courant pour détecter
    // les cooldowns qui viennent d'expirer (transition actif -> inactif), et on
    // envoie une notification navigateur + fait clignoter l'onglet concerné.
    let lastCdMinute = -1;
    let prevActiveCooldowns = snapshotActiveCooldowns(accounts);
    const notifiedCooldowns = new Set(); // clés déjà notifiées (anti-double-notification)

    setInterval(() => {
      const now = Date.now();
      let needsRender = false;
      accounts.forEach(acc => {
        SERVICES.forEach(svc => {
          const cd = acc.cooldowns[svc.id];
          if (!cd) return;
          if (cd <= now) { acc.cooldowns[svc.id] = 0; needsRender = true; }
        });
      });
      // Lot 18/09/2026 : détection des cooldowns qui viennent d'expirer.
      // On compare le snapshot précédent (prevActiveCooldowns) avec l'état
      // courant des comptes : tout cooldown qui était actif et ne l'est plus
      // déclenche une notification. Le snapshot est rafraîchi à chaque tick.
      const newlyExpired = getNewlyExpiredCooldowns(accounts, prevActiveCooldowns, now);
      prevActiveCooldowns = snapshotActiveCooldowns(accounts);
      // Nettoie les clés notifiées pour les cooldowns qui sont redevenus actifs
      // (permet de re-notifier si le même couple est réactivé puis expire à nouveau).
      for (const active of prevActiveCooldowns) {
        notifiedCooldowns.delete(active.key);
      }
      if (newlyExpired.length > 0) {
        for (const exp of newlyExpired) {
          if (notifiedCooldowns.has(exp.key)) continue; // déjà notifié
          notifiedCooldowns.add(exp.key);
          const acc = accounts.find(a => a.id === exp.accId);
          const svc = SERVICES.find(s => s.id === exp.svcId);
          if (!acc || !svc) continue;
          // Notification navigateur (si permission accordée)
          if ('Notification' in window && Notification.permission === 'granted') {
            try {
              new Notification('Cooldown terminé', {
                body: acc.name + ' — ' + svc.name + ' est de nouveau disponible.',
                silent: false
              });
            } catch (e) { /* l'app ne doit pas planter sur une notification */ }
          }
          // Fait clignoter l'onglet concerné s'il est ouvert
          const tab = tabs.find(t => t.accId === exp.accId && t.svcId === exp.svcId);
          if (tab) {
            const tabEl = document.querySelector('#tabsBar .tab[data-tab="' + tab.id + '"]');
            if (tabEl) tabEl.classList.add('tab--flash');
          }
          showToast(acc.name + ' — ' + svc.name + ' : cooldown terminé');
        }
      }
      const minute = Math.floor(now / 60000);
      const minuteChanged = minute !== lastCdMinute;
      if (needsRender) renderAccounts();
      // Lot 16/09/2026 : badges de statut compte + rappel onglet inactif,
      // même cadence (1×/min) — indépendants des cooldowns de service
      // ci-dessus. Pas besoin de refreshAccountStatusDots() si renderAccounts()
      // vient déjà de tourner (needsRender) : il a déjà tout reconstruit.
      if (minuteChanged) {
        if (!needsRender) refreshAccountStatusDots();
        refreshTabIdleClasses();
      }
      lastCdMinute = minute;
    }, 1000);

    // Issue #6 : nettoie l'ordre personnalisé des comptes supprimés/importés
    pruneAccountOrder(accounts);

    renderAccounts();

    // === Chargement et application des réglages au démarrage (lot 18/09/2026) ===
    // Applique le thème, la taille de police, le word wrap, et pousse
    // showAutomationWindows vers la config du scheduler.
    loadSettings();

    // === Ordonnanceur IA (chantier E) ===
    // Le registre de jobs vit côté main.js (scheduler/, IPC 'scheduler:*') ;
    // ce bloc ne fait qu'afficher l'état renvoyé par 'scheduler:get-state' et
    // relayer les actions du panneau. Voir FEATURES.md « Ordonnanceur » pour
    // le périmètre exact de ce lot (la fenêtre d'automatisation + le moteur
    // d'adaptateurs par service ne sont PAS encore implémentés).
    const SCHED_STATUS_LABELS = {
      DOWNLOADING: 'Téléchargement…', COMPLETED: 'Téléchargé — à traiter',
      PROJECT_PENDING: "Projet en cours d'analyse", WAITING_FOR_PROFILE: 'Aucun profil disponible',
      RESUME_REQUIRED: 'Reprise programmée', RUNNING: 'En cours', PAUSED: 'En pause',
      DELIVERED: 'Livré', ERROR: 'Erreur'
    };
    const SCHED_STATUS_COLORS = {
      DOWNLOADING: 'var(--accent)', RUNNING: 'var(--accent)', RESUME_REQUIRED: 'var(--accent)',
      COMPLETED: 'var(--warning)', PROJECT_PENDING: 'var(--warning)',
      WAITING_FOR_PROFILE: 'var(--fg-muted)', PAUSED: 'var(--fg-muted)',
      ERROR: 'var(--danger)', DELIVERED: 'var(--rose)'
    };
    let schedulerPollTimer = null;

    window.openSchedulerModal = function() {
      document.getElementById('schedulerModal').classList.add('open');
      refreshScheduler();
      if (!schedulerPollTimer) schedulerPollTimer = setInterval(refreshScheduler, 4000);
    }
    window.closeSchedulerModal = function() {
      document.getElementById('schedulerModal').classList.remove('open');
      if (schedulerPollTimer) { clearInterval(schedulerPollTimer); schedulerPollTimer = null; }
    }
    document.getElementById('schedulerModal').addEventListener('click', (e) => {
      if (e.target === e.currentTarget) closeSchedulerModal();
    });

    // === Réglages (lot 18/09/2026, FEATURES.md P2) ===
    // Persistance via IPC settings:load/settings:save (main.js), normalisation
    // via lib/settings.js (normalizeSettings, DEFAULT_SETTINGS).
    var currentSettings = null;

    // Issue #139 : préférence claire/sombre du bureau. Electron relaie le thème
    // du système (nativeTheme.themeSource = 'system' par défaut) vers
    // prefers-color-scheme. undefined si matchMedia est indisponible.
    var systemThemeQuery = (typeof window.matchMedia === 'function')
      ? window.matchMedia('(prefers-color-scheme: dark)') : null;
    function systemPrefersDark() {
      return systemThemeQuery ? systemThemeQuery.matches === true : undefined;
    }
    // Le bureau change de thème pendant que l'app tourne -> réappliquer si
    // le réglage est « system » (les autres thèmes sont fixes).
    if (systemThemeQuery && typeof systemThemeQuery.addEventListener === 'function') {
      systemThemeQuery.addEventListener('change', function() {
        if (currentSettings && normalizeTheme(currentSettings.theme) === 'system') {
          document.documentElement.setAttribute('data-theme',
            resolveTheme('system', systemPrefersDark()));
        }
      });
    }

    // Applique effectivement tous les réglages à l'UI.
    // Appelée au démarrage (après chargement) et après chaque sauvegarde.
    function applySettings(settings) {
      if (!settings) return;
      currentSettings = settings;
      var plan = buildApplySettingsPlan(settings, { prefersDark: systemPrefersDark() });

      // 1. Thème : pose data-theme sur <html> (« system » -> dark/light selon
      // le bureau, issue #139 ; suivi en direct par l'écouteur ci-dessous)
      document.documentElement.setAttribute('data-theme', plan.themeAttr);

      // 2. Taille de police + retour à la ligne de l'éditeur Monaco
      if (window.monacoEditor && typeof window.monacoEditor.updateOptions === 'function') {
        window.monacoEditor.updateOptions(plan.monacoOptions);
      }
      // Éditeur de secours (textarea)
      var fe = document.getElementById('fallbackEditor');
      if (fe) {
        fe.style.fontSize = plan.fallbackFontSizePx;
      }

      // 3. showAutomationWindows : pousser vers la config du scheduler
      ipcRenderer.invoke('scheduler:set-config', plan.schedulerConfigPush).catch(function() {});
    }

    window.openSettingsModal = function() {
      document.getElementById('settingsModal').classList.add('open');
      loadSettings();
    }
    window.closeSettingsModal = function() {
      document.getElementById('settingsModal').classList.remove('open');
    }
    document.getElementById('settingsModal').addEventListener('click', (e) => {
      if (e.target === e.currentTarget) closeSettingsModal();
    });

    async function loadSettings() {
      try {
        var settings = await ipcRenderer.invoke('settings:load');
        applySettings(settings);
        // Remplir les champs du modal
        document.getElementById('settingsEditorFontSize').value = settings.editorFontSize;
        document.getElementById('settingsTheme').value = settings.theme;
        document.getElementById('settingsEditorWordWrap').value = settings.editorWordWrap;
        document.getElementById('settingsConfirmBeforeClose').checked = settings.confirmBeforeClose;
        document.getElementById('settingsShowAutomationWindows').checked = settings.showAutomationWindows;
        document.getElementById('settingsStartWithLastSession').checked = settings.startWithLastSession;
        // Restaurer les onglets si le réglage est activé (lot 18/09/2026)
        if (settings.startWithLastSession) {
          restoreOpenTabs();
        }
      } catch (e) {
        showToast('Impossible de charger les réglages', 'error');
      }
    }

    async function saveSettings() {
      var raw = {
        editorFontSize: parseInt(document.getElementById('settingsEditorFontSize').value, 10),
        editorWordWrap: document.getElementById('settingsEditorWordWrap').value,
        theme: document.getElementById('settingsTheme').value,
        confirmBeforeClose: document.getElementById('settingsConfirmBeforeClose').checked,
        showAutomationWindows: document.getElementById('settingsShowAutomationWindows').checked,
        startWithLastSession: document.getElementById('settingsStartWithLastSession').checked
      };
      try {
        var result = await ipcRenderer.invoke('settings:save', raw);
        if (result && result.ok) {
          applySettings(result.settings);
          showToast('Réglages enregistrés', 'success');
          closeSettingsModal();
        } else {
          showToast(result && result.error ? result.error : 'Erreur lors de la sauvegarde', 'error');
        }
      } catch (e) {
        showToast('Erreur lors de la sauvegarde des réglages', 'error');
      }
    }
    window.saveSettings = saveSettings;

    async function refreshScheduler() {
      let state;
      try { state = await ipcRenderer.invoke('scheduler:get-state'); }
      catch (e) { console.error('[scheduler] état indisponible :', e); return; }
      if (state && state.error) { console.error('[scheduler]', state.error); return; }
      renderSchedulerState(state);
    }

    function renderSchedulerState(state) {
      var cfg = state.config;
      document.getElementById('schedToggleInput').checked = !!cfg.enabled;
      document.getElementById('statSchedActive').textContent = state.counters.active;
      document.getElementById('statSchedWaiting').textContent = state.counters.waiting;
      document.getElementById('statSchedDelivered').textContent = state.counters.deliveredToday;

      document.getElementById('schedMaxJobs').value = cfg.maxConcurrentJobs;
      document.getElementById('schedMinDelay').value = cfg.minDelayBetweenAutomationsMinutes;
      document.getElementById('schedThreshold').value = cfg.profileAgeThresholdHours;
      document.getElementById('schedDownloadsDir').textContent = cfg.downloadsDir || '(dossier de téléchargements du système)';
      document.getElementById('schedDeliveryDir').textContent = cfg.deliveryDir || '(non défini)';

      // Projets & tâches (lot 18/09/2026, point 6)
      renderProjects(state.projects || []);

      const list = document.getElementById('schedJobsList');
      if (!state.jobs.length) {
        list.innerHTML = '<div class="sched-empty">Aucun job pour l\'instant — un ZIP téléchargé depuis un onglet IA (ordonnanceur activé) en créera un automatiquement.</div>';
      } else {
        list.innerHTML = state.jobs.map(j => {
          const label = SCHED_STATUS_LABELS[j.status] || j.status;
          const color = SCHED_STATUS_COLORS[j.status] || 'var(--fg-muted)';
          const actions = [];
          if (j.status === 'COMPLETED') {
            actions.push(`<button class="btn" data-action="sched-continue" data-job="${escapeHtml(j.id)}">Continuer le projet</button>`);
            actions.push(`<button class="btn" data-action="sched-deliver" data-job="${escapeHtml(j.id)}">Marquer livré</button>`);
          }
          if (['RUNNING', 'RESUME_REQUIRED', 'WAITING_FOR_PROFILE'].includes(j.status)) {
            actions.push(`<button class="btn" data-action="sched-pause" data-job="${escapeHtml(j.id)}">Pause</button>`);
          }
          if (j.status === 'PAUSED' || j.status === 'WAITING_FOR_PROFILE') {
            actions.push(`<button class="btn" data-action="sched-resume" data-job="${escapeHtml(j.id)}">Reprendre</button>`);
          }
          if (j.status === 'ERROR') {
            actions.push(`<button class="btn" data-action="sched-retry" data-job="${escapeHtml(j.id)}">Relancer</button>`);
          }
          if (j.file_path || j.outputZip) {
            actions.push(`<button class="btn" data-action="sched-open-zip" data-job="${escapeHtml(j.id)}">Ouvrir le ZIP</button>`);
            // Lot 18/09/2026 : analyse de complétude — lit le FEATURES.md du ZIP
            // et compte les cases restantes (parseFeaturesMd, scheduler/core.js).
            actions.push(`<button class="btn" data-action="sched-analyze" data-job="${escapeHtml(j.id)}">Analyser la complétude</button>`);
          }
          const fileName = j.file_path ? String(j.file_path).split(/[\\/]/).pop() : null;
          return `
            <div class="sched-job">
              <div class="sched-job__dot" data-dot-color="${color}"></div>
              <div class="sched-job__body">
                <div class="sched-job__title">${escapeHtml(j.id)} — ${escapeHtml(j.service || 'service inconnu')} · ${escapeHtml(j.profile || '—')}</div>
                <div class="sched-job__meta">${escapeHtml(label)} · tentative ${j.attempts || 1}${fileName ? ' · ' + escapeHtml(fileName) : ''}</div>
                ${actions.length ? `<div class="sched-job__actions">${actions.join('')}</div>` : ''}
              </div>
            </div>
          `;
        }).join('');
        applyDataColors(list); // lot 9 : couleurs dynamiques (job dots)
      }

      const log = document.getElementById('schedLog');
      log.innerHTML = state.log.length
        ? state.log.map(l => `<div>[${escapeHtml(new Date(l.ts).toLocaleTimeString('fr-FR'))}] ${escapeHtml(l.message)}</div>`).join('')
        : '<div class="sched-empty-log">Aucune activité enregistrée.</div>';

      hydrateIcons(document.getElementById('schedulerModal'));
    }

    document.getElementById('schedToggleInput').addEventListener('change', async (e) => {
      try {
        const res = await ipcRenderer.invoke('scheduler:set-enabled', e.target.checked);
        if (res && res.error) throw new Error(res.error);
        refreshScheduler();
      } catch (err) { showToast("Impossible de modifier l'état de l'ordonnanceur", 'error'); }
    });

    function bindSchedNumberInput(id, key) {
      document.getElementById(id).addEventListener('change', async (e) => {
        const value = Number(e.target.value);
        try {
          const res = await ipcRenderer.invoke('scheduler:set-config', { [key]: value });
          if (res && res.error) throw new Error(res.error);
          refreshScheduler();
        } catch (err) { showToast('Configuration non enregistrée', 'error'); }
      });
    }
    bindSchedNumberInput('schedMaxJobs', 'maxConcurrentJobs');
    bindSchedNumberInput('schedMinDelay', 'minDelayBetweenAutomationsMinutes');
    bindSchedNumberInput('schedThreshold', 'profileAgeThresholdHours');

    document.getElementById('schedPickDownloads').addEventListener('click', async () => {
      try {
        const res = await ipcRenderer.invoke('scheduler:pick-downloads-dir');
        if (res && res.error) throw new Error(res.error);
        refreshScheduler();
      } catch (e) { showToast('Sélection du dossier impossible', 'error'); }
    });
    document.getElementById('schedPickDelivery').addEventListener('click', async () => {
      try {
        const res = await ipcRenderer.invoke('scheduler:pick-delivery-dir');
        if (res && res.error) throw new Error(res.error);
        refreshScheduler();
      } catch (e) { showToast('Sélection du dossier impossible', 'error'); }
    });

    // Délégation d'événements (chantier A) : un seul listener sur le conteneur,
    // pas de onclick avec donnée interpolée dans le HTML généré ci-dessus.
    document.getElementById('schedJobsList').addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      const jobId = btn.getAttribute('data-job');
      const action = btn.getAttribute('data-action');
      // Lot 18/09/2026 : analyse de complétude — pas un simple relais IPC, on
      // affiche le résultat dans un toast plutôt que de juste rafraîchir la liste.
      if (action === 'sched-analyze') {
        try {
          const res = await ipcRenderer.invoke('scheduler:analyze-completeness', jobId);
          if (res && res.error) { showToast(res.error, 'error'); return; }
          if (res && res.analysis) {
            const a = res.analysis;
            const msg = a.complete
              ? `Projet terminé : ${a.done}/${a.total} tâches faites, 0 restante.`
              : `${a.pending} à faire, ${a.inProgress} en cours, ${a.done} faite(s) sur ${a.total} au total.`;
            showToast(msg, a.complete ? 'success' : 'warning');
          }
        } catch (err) { showToast('Analyse impossible : ' + (err.message || err), 'error'); }
        return;
      }
      const channelByAction = {
        'sched-continue': 'scheduler:continue-project',
        'sched-deliver': 'scheduler:mark-delivered',
        'sched-pause': 'scheduler:pause-job',
        'sched-resume': 'scheduler:resume-job',
        'sched-retry': 'scheduler:retry-job',
        'sched-open-zip': 'scheduler:open-zip'
      };
      const channel = channelByAction[btn.getAttribute('data-action')];
      if (!channel) return;
      try {
        const res = await ipcRenderer.invoke(channel, jobId);
        if (res && res.error) { showToast(res.error, 'error'); return; }
        refreshScheduler();
      } catch (err) { showToast('Action impossible : ' + (err.message || err), 'error'); }
    });

    // --- Projets & tâches (lot 18/09/2026, point 6) ---
    // Affichage et gestion des projets dans le panneau Ordonnanceur.
    // Les tâches ne peuvent être assignées qu'aux comptes verts (plus de 5h
    // d'inactivité) — voir getAssignableAccounts (lib/activity-status.js).
    function renderProjects(projects) {
      var list = document.getElementById('schedProjectsList');
      if (!projects || !projects.length) {
        list.innerHTML = '<div class="sched-empty">Aucun projet pour l\'instant. <button class="btn sched-create-btn" data-action="sched-create-project">Créer un projet</button></div>';
        return;
      }
      list.innerHTML = projects.map(function(p) {
        var tasks = p.tasks || [];
        var taskHtml = tasks.length ? tasks.map(function(t) {
          var statusLabel = {
            pending: 'En attente', assigned: 'Assignée', running: 'En cours',
            completed: 'Terminée', failed: 'Échouée'
          }[t.status] || t.status;
          var statusColor = {
            pending: 'var(--fg-muted)', assigned: 'var(--warning)',
            running: 'var(--accent)', completed: 'var(--status-idle)',
            failed: 'var(--danger)'
          }[t.status] || 'var(--fg-muted)';
          // Bouton « Lancer » pour les tâches assignées (automatisation Claude)
          var launchBtn = (t.status === 'assigned' && t.assignedProfile)
            ? '<button class="btn sched-task-btn" data-action="sched-execute-task" data-project="' + escapeHtml(p.id) + '" data-task="' + escapeHtml(t.id) + '">Lancer</button>'
            : '';
          // Bouton « Voir résultat » pour les tâches terminées
          var resultBtn = (t.status === 'completed' && t.result)
            ? '<button class="btn sched-task-btn" data-action="sched-view-result" data-project="' + escapeHtml(p.id) + '" data-task="' + escapeHtml(t.id) + '">Résultat</button>'
            : '';
          return '<div class="sched-job sched-job--task">' +
            '<div class="sched-job__dot sched-job__dot--mt3" data-dot-color="' + statusColor + '"></div>' +
            '<div class="sched-job__body">' +
            '<div class="sched-job__title sched-task-title">' + escapeHtml(t.id) +
            (t.assignedProfile ? ' → ' + escapeHtml(t.assignedProfile) : '') +
            ' <span class="sched-task-status" data-status-color="' + statusColor + '">' + escapeHtml(statusLabel) + '</span></div>' +
            '<div class="sched-job__meta">' +
            (t.prompt ? escapeHtml(t.prompt.slice(0, 60)) + (t.prompt.length > 60 ? '…' : '') : '') +
            '</div>' +
            '<div class="sched-job__actions sched-task-actions">' + launchBtn + resultBtn + '</div>' +
            '</div></div>';
        }).join('') : '<div class="sched-task-empty">Aucune tâche.</div>';
        var allowedText = p.allowedAccountIds && p.allowedAccountIds.length
          ? p.allowedAccountIds.map(function(id) {
              var acc = accounts.find(function(a) { return a.id === id; });
              return acc ? escapeHtml(acc.name) : escapeHtml(id);
            }).join(', ')
          : 'Tous les comptes';
        return '<div class="sched-job">' +
          '<div class="sched-job__dot sched-job__dot--accent sched-job__dot--mt5"></div>' +
          '<div class="sched-job__body">' +
          '<div class="sched-job__title">' + escapeHtml(p.name) +
          ' <span class="sched-subtitle sched-subtitle--inline">(' + escapeHtml(p.id) + ')</span></div>' +
          '<div class="sched-job__meta">' + tasks.length + ' tâche(s) · Comptes autorisés : ' + allowedText + '</div>' +
          '<div class="sched-job__actions">' +
          '<button class="btn" data-action="sched-add-task" data-project="' + escapeHtml(p.id) + '">Nouvelle tâche</button>' +
          '<button class="btn" data-action="sched-assign-task" data-project="' + escapeHtml(p.id) + '">Assigner</button>' +
          '<button class="btn" data-action="sched-delete-project" data-project="' + escapeHtml(p.id) + '">Supprimer</button>' +
          '</div>' +
          taskHtml +
          '</div></div>';
      }).join('') +
      '<div class="sched-project-actions"><button class="btn" data-action="sched-create-project">Créer un projet</button></div>';
      applyDataColors(list); // lot 9 : couleurs dynamiques (job dots, status colors)
    }

    // --- Automatisation Claude (lot 18/09/2026, points 7-8, 10-13) ---
    // Seul Claude est supporté pour l'instant (point 10).
    window.schedDiagnoseClaude = async function(profile) {
      try {
        var res = await ipcRenderer.invoke('scheduler:diagnose-claude', profile);
        if (res && res.error) { showToast('Diagnostic Claude : ' + res.error, 'error'); return; }
        if (res) {
          var parts = [];
          if (res.continueButton && res.continueButton.found) parts.push('« Continuer »');
          if (res.downloadButton && res.downloadButton.found) parts.push('« Télécharger »');
          if (res.newChatButton && res.newChatButton.found) parts.push('« Nouveau »');
          if (res.chatInput && res.chatInput.found) parts.push('zone de chat');
          if (res.fileUpload && res.fileUpload.found) parts.push('upload fichier');
          if (res.quotaMessage && res.quotaMessage.detected) parts.push('QUOTA: ' + res.quotaMessage.time);
          if (res.popups && res.popups.count > 0) parts.push(res.popups.count + ' popup(s)');
          showToast('Claude (« ' + profile + ' ») : ' + (parts.length ? parts.join(', ') : 'aucun élément détecté'));
        }
      } catch (e) { showToast('Diagnostic impossible : ' + e.message, 'error'); }
    };

    window.schedRunClaudeJob = async function(profile, prompt, sourceZipPath) {
      try {
        var res = await ipcRenderer.invoke('scheduler:run-claude-job', profile, prompt, sourceZipPath);
        if (res && res.error) {
          if (res.error === 'quota_exhausted') {
            showToast('Quota gratuit épuisé jusqu\'à ' + res.quotaTime + ' pour ce profil.', 'error');
          } else {
            showToast('Job Claude échoué : ' + res.error, 'error');
          }
          return;
        }
        if (res && res.ok) {
          showToast('Prompt envoyé à Claude via ' + res.method + ' (« ' + profile + ' »)');
        }
      } catch (e) { showToast('Job Claude impossible : ' + e.message, 'error'); }
    };

    window.schedCollectResponse = async function(profile) {
      try {
        var res = await ipcRenderer.invoke('scheduler:collect-claude-response', profile);
        if (res && res.error) { showToast('Collecte impossible : ' + res.error, 'error'); return; }
        if (res && res.ok && res.response) {
          showToast('Réponse collectée : ' + res.response.length + ' caractères (« ' + profile + ' »)');
          console.log('[claude] Réponse collectée (« ' + profile + ' »):', res.response);
        } else {
          showToast('Aucune réponse trouvée pour le moment.', 'warning');
        }
      } catch (e) { showToast('Collecte impossible : ' + e.message, 'error'); }
    };

    // --- Gestion des projets (CRUD) ---
    window.schedCreateProject = async function() {
      var name = prompt('Nom du projet :', 'Projet ' + Date.now());
      if (!name) return;
      try {
        // Pour l'instant, tous les comptes sont autorisés (liste vide = tous)
        var res = await ipcRenderer.invoke('scheduler:create-project', name, []);
        if (res && res.error) { showToast(res.error, 'error'); return; }
        showToast('Projet « ' + name + ' » créé');
        refreshScheduler();
      } catch (e) { showToast('Création impossible : ' + e.message, 'error'); }
    };

    window.schedDeleteProject = async function(projectId) {
      try {
        var res = await ipcRenderer.invoke('scheduler:delete-project', projectId);
        if (res && res.error) { showToast(res.error, 'error'); return; }
        showToast('Projet supprimé');
        refreshScheduler();
      } catch (e) { showToast('Suppression impossible : ' + e.message, 'error'); }
    };

    window.schedAddTask = async function(projectId) {
      var taskPrompt = window.prompt('Prompt de la tâche :', '');
      if (!taskPrompt) return;
      try {
        var res = await ipcRenderer.invoke('scheduler:create-task', projectId, taskPrompt, null);
        if (res && res.error) { showToast(res.error, 'error'); return; }
        showToast('Tâche créée dans le projet');
        refreshScheduler();
      } catch (e) { showToast('Création impossible : ' + e.message, 'error'); }
    };

    window.schedAssignTask = async function(projectId) {
      // Récupère les comptes assignables (verts) pour ce projet
      var openAccountIds = tabs.map(function(t) { return t.accId; });
      try {
        var res = await ipcRenderer.invoke('scheduler:get-assignable-accounts', projectId, openAccountIds);
        if (res && res.error) { showToast(res.error, 'error'); return; }
        if (!res || !res.length) {
          showToast('Aucun compte vert disponible pour ce projet.', 'warning');
          return;
        }
        var names = res.map(function(a) { return a.name + ' (' + a.profile + ')'; });
        var choice = prompt('Comptes verts disponibles :\n' + names.map(function(n, i) { return (i+1) + '. ' + n; }).join('\n') + '\n\nNuméro du compte :', '1');
        if (!choice) return;
        var idx = parseInt(choice, 10) - 1;
        if (isNaN(idx) || idx < 0 || idx >= res.length) { showToast('Choix invalide', 'error'); return; }
        var account = res[idx];
        // Demande quelle tâche assigner
        var state = await ipcRenderer.invoke('scheduler:get-state');
        var project = state.projects.find(function(p) { return p.id === projectId; });
        if (!project || !project.tasks || !project.tasks.length) {
          showToast('Aucune tâche dans ce projet.', 'warning');
          return;
        }
        var taskNames = project.tasks.map(function(t) { return t.id + (t.status !== 'pending' ? ' (' + t.status + ')' : ''); });
        var taskChoice = prompt('Tâches du projet :\n' + taskNames.map(function(n, i) { return (i+1) + '. ' + n; }).join('\n') + '\n\nNuméro de la tâche :', '1');
        if (!taskChoice) return;
        var taskIdx = parseInt(taskChoice, 10) - 1;
        if (isNaN(taskIdx) || taskIdx < 0 || taskIdx >= project.tasks.length) { showToast('Choix invalide', 'error'); return; }
        var task = project.tasks[taskIdx];
        var assignRes = await ipcRenderer.invoke('scheduler:assign-task', projectId, task.id, account.id, openAccountIds);
        if (assignRes && assignRes.error) { showToast(assignRes.error, 'error'); return; }
        showToast('Tâche ' + task.id + ' assignée à « ' + account.name + ' »');
        refreshScheduler();
      } catch (e) { showToast('Assignation impossible : ' + e.message, 'error'); }
    };

    // Exécute une tâche assignée : crée un job et lance l'automatisation Claude
    window.schedExecuteTask = async function(projectId, taskId) {
      try {
        showToast('Lancement de l\'automatisation Claude...', 'info');
        var res = await ipcRenderer.invoke('scheduler:execute-task', projectId, taskId);
        if (res && res.error) { showToast(res.error, 'error'); return; }
        if (res && !res.ok) { showToast(res.reason || 'Lancement impossible', 'warning'); return; }
        showToast('Tâche lancée — suivi dans le journal d\'activité');
        refreshScheduler();
      } catch (e) { showToast('Exécution impossible : ' + e.message, 'error'); }
    };

    // Affiche le résultat d'une tâche terminée
    window.schedViewResult = async function(projectId, taskId) {
      var state = await ipcRenderer.invoke('scheduler:get-state');
      var project = state.projects.find(function(p) { return p.id === projectId; });
      if (!project) return;
      var task = project.tasks.find(function(t) { return t.id === taskId; });
      if (!task || !task.result) { showToast('Aucun résultat disponible', 'warning'); return; }
      // Afficher dans une fenêtre modale simple
      var modal = document.getElementById('confirmModal');
      var titleEl = modal.querySelector('.modal-card__title');
      var bodyEl = modal.querySelector('.modal-card__body');
      var okBtn = modal.querySelector('[data-confirm]');
      if (titleEl) titleEl.textContent = 'Résultat — ' + task.id;
      if (bodyEl) bodyEl.innerHTML = '<pre class="sched-result-pre">' + escapeHtml(task.result) + '</pre>';
      modal.classList.add('open');
      modal.dataset.confirmAction = 'close-result';
    };

    // Délégation d'événements pour les actions projets/tâches
    document.getElementById('schedProjectsList').addEventListener('click', function(e) {
      var btn = e.target.closest('[data-action]');
      if (!btn) return;
      var action = btn.getAttribute('data-action');
      var projectId = btn.getAttribute('data-project');
      var taskId = btn.getAttribute('data-task');
      if (action === 'sched-create-project') schedCreateProject();
      else if (action === 'sched-delete-project') schedDeleteProject(projectId);
      else if (action === 'sched-add-task') schedAddTask(projectId);
      else if (action === 'sched-assign-task') schedAssignTask(projectId);
      else if (action === 'sched-execute-task') schedExecuteTask(projectId, taskId);
      else if (action === 'sched-view-result') schedViewResult(projectId, taskId);
    });

    // Pousse un premier instantané des comptes au démarrage : sans ça, main.js
    // n'a aucune info sur les profils tant que l'utilisateur ne modifie pas un
    // compte (saveAccounts n'aurait pas encore été rappelée).
    try { ipcRenderer.invoke('scheduler:sync-accounts', accounts).catch(() => {}); } catch (_) { /* ignore */ }

    // Récupération des données (chantier C) : si ai_accounts était illisible au
    // démarrage, on propose de restaurer la sauvegarde plutôt que de perdre en
    // silence les comptes de l'utilisateur.
    if (dataCorrupt) showRecoveryUI();

    // Construit et affiche la modale de récupération. Restaure depuis
    // ai_accounts_backup si un backup valide existe, sinon informe simplement.
    // (Fonction déclarée -> hoistée, l'appel ci-dessus la voit.)
    function showRecoveryUI() {
      const b = readJSON(BACKUP_KEY);
      const hasBackup = b.status === 'ok' && Array.isArray(b.data);

      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay open';
      const box = document.createElement('div');
      box.className = 'modal';

      const title = document.createElement('div');
      title.className = 'modal__title';
      title.textContent = 'Données de comptes illisibles';

      const desc = document.createElement('div');
      desc.className = 'modal__desc';
      // textContent (pas innerHTML) : aucune donnée n'est interprétée en HTML.
      desc.textContent = hasBackup
        ? `La liste de comptes enregistrée est corrompue. Une sauvegarde de ${b.data.length} compte(s) a été trouvée. La restaurer ?`
        : "La liste de comptes enregistrée est corrompue et aucune sauvegarde n'est disponible. L'application démarre avec une liste vide ; vos données actuelles ne seront pas écrasées tant que vous ne créez ou ne modifiez pas de compte.";

      const actions = document.createElement('div');
      actions.className = 'modal__actions';
      const close = () => overlay.remove();

      if (hasBackup) {
        const cancel = document.createElement('button');
        cancel.className = 'btn';
        cancel.textContent = 'Ignorer';
        cancel.addEventListener('click', close);

        const restore = document.createElement('button');
        restore.className = 'btn btn--primary';
        restore.textContent = 'Restaurer la sauvegarde';
        restore.addEventListener('click', () => {
          accounts = b.data;
          migrateOldAccounts();   // complète/répare les comptes restaurés
          saveAccounts(accounts); // saveAccounts préserve le backup (valeur actuelle illisible)
          renderAccounts();
          close();
          showToast('Comptes restaurés depuis la sauvegarde');
        });
        actions.appendChild(cancel);
        actions.appendChild(restore);
      } else {
        const ok = document.createElement('button');
        ok.className = 'btn btn--primary';
        ok.textContent = 'Compris';
        ok.addEventListener('click', close);
        actions.appendChild(ok);
      }

      box.appendChild(title);
      box.appendChild(desc);
      box.appendChild(actions);
      overlay.appendChild(box);
      document.body.appendChild(overlay);
    }
  }

// ---------------------------------------------------------------------------
// Délégation des actions UI statiques (lot CSP, 18/09/2026)
// ---------------------------------------------------------------------------
// Les anciens attributs inline onclick="fn()" / oninput="fn()" ont été
// convertis en data-action="ui-fn" / data-input-action="fn" : une CSP
// stricte (script-src 'self') interdit les gestionnaires inline. Même
// mécanisme de délégation que le panneau Ordonnanceur (data-action
// "sched-*"), mais au niveau document : ce listener n'exécute QUE les
// actions « ui-* » de la table ci-dessous — les actions sched-* des
// conteneurs spécialisés ne passent jamais par ici. Résolution par nom au
// moment du clic (liste blanche explicite, jamais de chaîne arbitraire).
const UI_ACTIONS = {
  'ui-toggleDashboard': 'toggleDashboard',
  'ui-toggleAllCards': 'toggleAllCards',
  'ui-toggleExplorer': 'toggleExplorer',
  'ui-toggleIdePanel': 'toggleIdePanel',
  'ui-toggleDevTools': 'toggleDevTools',
  'ui-openPalette': 'openPalette',
  'ui-openModal': 'openModal',
  'ui-openHelpModal': 'openHelpModal',
  'ui-openServicesModal': 'openServicesModal',
  'ui-closeServicesModal': 'closeServicesModal',
  'ui-saveServicesModal': 'saveServicesModal',
  'ui-openSchedulerModal': 'openSchedulerModal',
  'ui-openSettingsModal': 'openSettingsModal',
  'ui-exportAccountsToFile': 'exportAccountsToFile',
  'ui-importAccountsFromFile': 'importAccountsFromFile',
  'ui-selectLocalFolder': 'selectLocalFolder',
  'ui-closeModal': 'closeModal',
  'ui-saveAccount': 'saveAccount',
  'ui-closeDeleteModal': 'closeDeleteModal',
  'ui-confirmDelete': 'confirmDelete',
  'ui-closeImportConfirm': 'closeImportConfirm',
  'ui-confirmImport': 'confirmImport',
  'ui-closeDisconnectModal': 'closeDisconnectModal',
  'ui-confirmDisconnect': 'confirmDisconnect',
  'ui-closeHelpModal': 'closeHelpModal',
  'ui-closeSchedulerModal': 'closeSchedulerModal',
  'ui-closeSettingsModal': 'closeSettingsModal',
  'ui-saveSettings': 'saveSettings'
};
const INPUT_ACTIONS = {
  'filterPalette': 'filterPalette',
  'onFileSearch': 'onFileSearch'
};
document.addEventListener('click', function(e) {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const name = UI_ACTIONS[el.getAttribute('data-action')];
  if (name && typeof window[name] === 'function') window[name]();
});
document.addEventListener('input', function(e) {
  const el = e.target.closest('[data-input-action]');
  if (!el) return;
  const name = INPUT_ACTIONS[el.getAttribute('data-input-action')];
  if (name && typeof window[name] === 'function') window[name]();
});
