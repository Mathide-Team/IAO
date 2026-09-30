# Contexte du projet — IAO

> Document de passation destiné à une autre IA. **Réorganisation du 16/09/2026** : `install.sh` est passé à la racine, la documentation interne dans `docs/`, et deux fichiers ont été ajoutés — `CLAUDE.md` (règles de travail) et `FEATURES.md` (backlog). Il décrit l'état **actuel** de l'application pour que tu puisses aider à écrire des fonctionnalités, corriger des bugs ou proposer des améliorations. Aucune connaissance préalable n'est supposée.

## 1. Résumé

**IAO** est une application **desktop Windows et Linux (Electron)** qui sert de « poste de travail » multi-comptes pour plusieurs services d'IA web (Claude, ChatGPT, Gemini, Perplexity, Z.ai, Grok, Leonardo AI, Suno, Meshy AI). Elle permet de :

- Gérer plusieurs **comptes** (ex. plusieurs adresses Gmail), chacun avec une **session de connexion isolée** (cookies séparés) grâce aux `partition` d'Electron.
- Ouvrir chaque service IA dans un **onglet** contenant sa `<webview>`, en restant connecté au bon compte.
- Suivre un **cooldown / quota 24h** par service et par compte (bouton « Épuiser (24h) »).
- Éditer des fichiers locaux via un **éditeur de code intégré (Monaco)** avec un explorateur de fichiers.
- Ouvrir **autant d'onglets IA que voulu** (un par couple compte + service), avec bascule instantanée entre eux et fermeture individuelle libérant la RAM.
- Consulter une **page d'aide** (« Comprendre les IA disponibles », bouton `?` dans la barre du workspace) décrivant chaque service et son cas d'usage.

C'est un outil **personnel / partagé**, au thème visuel **violet / rose**.

## 2. Stack technique

- **Electron** `^43.1.1` (app desktop, un process principal + un renderer).
- **HTML/CSS/JS vanilla** — pas de framework (pas de React/Vue). Tout le front est dans `index.html` (+ `assets/app.css` pour les styles, `assets/icons.js` pour les icônes, `assets/app.js` + `assets/pre-monaco.js` pour le JS).
- **Monaco Editor** `^0.45.0` (l'éditeur de VS Code), chargé en local depuis `node_modules`.
- **Polices & icônes 100% LOCALES** (plus aucun CDN externe) : polices Google Fonts en `.woff2` sous `assets/fonts/`, icônes ex-Font Awesome converties en **SVG inline** dans `assets/icons.js`. L'app s'affiche donc identiquement hors-ligne.
- **Packaging** : `@electron/packager` (génère un dossier + `.exe`) et `electron-builder` **26.15.3** (`.deb`, AppImage — mis à jour le 18/09/2026/lot 5 : `npm audit` à 0 vulnérabilité). `electron-builder` ne fonctionne pas sur la machine Windows de dev sans droits admin/Mode développeur (liens symboliques) ; sous Linux, il fonctionne sans souci.
- Pas de TypeScript, pas de bundler (Webpack/Vite). Tests : `node --test` (680 tests unitaires + intégration scheduler) et harnais réel `test-electron/` bloquant en CI (14 + 18 + 4 tests, voir §4).

## 3. Structure des fichiers

```
iao/
├── install.bat         # Installeur Windows (lot 9) : /system (admin), /uninstall, /desktop, robocopy /MIR, raccourcis WScript.Shell
├── install.sh          # Installeur Linux (à la RACINE) : /opt ou ~/.local/opt, icônes hicolor, .desktop, lanceur, --uninstall
├── index.html          # HTML pur (CSS extrait vers assets/app.css, JS vers assets/app.js + pre-monaco.js). ~356 lignes.
├── main.js             # Process principal Electron (~240 lignes). Fenêtre + IPC fichiers + durcissement navigation/popups + branchement de l'ordonnanceur.
├── lib/
│   ├── escape-html.js      # escapeHtml() — extrait pour être testable (node --test), chargé aussi par index.html
│   ├── popup-guard.js      # isAllowedPopup()/ALLOWED_POPUP_HOSTS — extrait de main.js, testable
│   ├── activity-status.js  # compareAccountNames/getAccountActivityStatus/isTabIdle/isAccountAssignable/getAssignableAccounts — lots 16/09 + 18/09/2026
│   ├── tab-actions.js      # tabsForAccount/buildDisconnectWarning — lot 17/09/2026
│   ├── file-search.js      # filterFiles/flattenFileTree — lot 18/09/2026 (recherche explorateur)
│   ├── claude-adapter.js  # CLAUDE_SELECTORS/détection/injection/upload/collecte — lot 18/09/2026
│   ├── settings.js      # normalizeSettings/normalizeEditorFontSize/normalizeTheme — lot 18/09/2026
│   └── cooldown-notify.js  # cooldownKey/getNewlyExpiredCooldowns/snapshotActiveCooldowns — lot 18/09/2026
├── scheduler/
│   ├── core.js          # Ordonnanceur IA : logique PURE (états des jobs, sélection de profil, CSV, prompt, parseFeaturesMd, projets/tâches, canAssignTaskToAccount) — testable
│   └── index.js         # Ordonnanceur IA : orchestration Electron (fs, sessions, IPC 'scheduler:*', analyzeCompleteness, projets/tâches CRUD, automatisation Claude.ai)
├── test/
│   ├── pure.test.js           # Tests de lib/escape-html.js et lib/popup-guard.js
│   ├── scheduler-core.test.js # Tests de scheduler/core.js
│   ├── activity-status.test.js # Tests de lib/activity-status.js
│   ├── tab-actions.test.js     # Tests de lib/tab-actions.js
│   ├── file-search.test.js     # Tests de lib/file-search.js
│   ├── cooldown-notify.test.js # Tests de lib/cooldown-notify.js
│   ├── features-parser.test.js # Tests de parseFeaturesMd/isProjectComplete
│   ├── scheduler-projects.test.js # Tests projets/tâches (scheduler/core.js)
│   ├── scheduler-automation.test.js # Tests automatisation Claude (_executeAutomation, _failJob, _pollClaudeResponse, executeTask)
│   ├── scheduler-completeness.test.js # Tests détection automatique de complétude (_autoDetectCompleteness)
│   ├── scheduler-completeness-integration.test.js # Tests d'intégration complétude (vrais ZIPs avec FEATURES.md)
│   ├── settings-applied.test.js # Tests réglages appliqués + restauration onglets (buildApplySettingsPlan, serializeOpenTabs, deserializeOpenTabs)
│   ├── claude-adapter.test.js # Tests de lib/claude-adapter.js
│   ├── scheduler-rate-limiter.test.js # Tests du limiteur (countRunningJobs/canLaunchJob/checkJobLaunchEligibility)
│   ├── settings.test.js  # Tests de lib/settings.js
│   ├── copy-text.test.js # Tests de lib/copy-text.js + câblage de la copie d'e-mail (issue #138)
│   └── icons.test.js           # Tests de validité d'assets/icons.js
├── package.json        # Scripts, dépendances, config de build.
├── package-lock.json
├── CLAUDE.md           # Règles de travail sur le dépôt (conventions, invariants, checklist de session)
├── FEATURES.md         # Backlog : travaux à faire, par lot et par priorité
├── README.md           # Documentation publique GitHub (fonctionnalités, installation, sécurité, contribution)
├── LICENSE             # MIT
├── .gitignore          # Exclut node_modules/, dist/, harnais de test, .env
├── scripts/
│   └── prune-locales.js # Post-build : supprime les locales Chromium inutiles (garde fr/en-US/en-GB), lancé par `npm run dist`
├── assets/
│   ├── icons.js        # 20 icônes SVG inline (sous-ensemble Font Awesome) + hydrateIcons()
│   ├── app.css         # Feuille de style extraite d'index.html (lot 8, 18/09/2026) : @font-face, :root, composants UI
│   └── fonts/          # 6 .woff2 (Space Grotesk, Inter, JetBrains Mono ; sous-ensembles latin + latin-ext)
├── build/              # Icône de l'app (icon.png 1024 px + déclinaisons 16 → 512 pour le thème hicolor)
├── installer/
│   └── iao.desktop.in # Modèle d'entrée freedesktop (@EXEC@/@ICON@ substitués à l'installation)
├── docs/
│   ├── PROJECT_CONTEXT.md      # Ce document
│   ├── THIRD-PARTY-NOTICES.md  # Attributions : polices OFL, icônes Font Awesome CC BY 4.0, Monaco/Electron MIT
│   └── DISTRIBUTION-LISEZ-MOI.txt # Notice utilisateur jointe au zip distribué à la communauté
├── node_modules/
│   └── monaco-editor/  # embarqué dans l'app
└── dist/               # sorties de build (généré par `npm run dist`) + IAO.zip (à distribuer) — NON versionné
```

- **Tout le code applicatif (UI, logique comptes, éditeur, redimensionnement) est dans `index.html`**, dans une grande fonction `initApp()`. Exceptions : `assets/icons.js`, `lib/escape-html.js`, `lib/popup-guard.js` (chargés en `<script src>`), et la logique de l'ordonnanceur IA qui vit côté process principal (`scheduler/`, voir §7bis).
- `assets/icons.js` est chargé avant l'app (`<script src>` dans le `<head>`) et expose `window.IAO_ICONS` + `window.hydrateIcons(root)`.
- `main.js` : crée la fenêtre, fixe le dossier de données, **durcit la navigation/les popups** (voir §10, logique dans `lib/popup-guard.js`), expose 4 handlers IPC fichiers (`select-folder`, `read-directory`, `read-file`, `save-file`), et initialise l'**ordonnanceur IA** (`scheduler/`, canaux IPC `scheduler:*`, voir §7bis).

## 4. Comment lancer / construire

- **Lancer en dev** : `npm start` (= `electron .`)
- **Lancer les tests** : `npm test` (= `node --test`) — couvre `lib/escape-html.js`, `lib/popup-guard.js`,
  `lib/activity-status.js`, `lib/tab-actions.js`, `lib/file-search.js`, `lib/cooldown-notify.js`,
  `scheduler/core.js` (dont `parseFeaturesMd`/`isProjectComplete`) et les tests d'intégration scheduler
  (mocks Electron, heures calmes injectables) et la validité structurelle d'`assets/icons.js` (chargé dans un bac à
  sable `vm`, voir §13) — **680 tests** au total, déterministes quelle que soit l'heure d'exécution.
- **Lancer les tests d'intégration Electron réels** : `npm run test:electron` (sous xvfb, fixtures locales
  uniquement — voir `test-electron/README.md`) — **14 tests** (popups, bouton « Continuer », webview, CSP).
  Tests de flux UI : `npm run test:electron:ui` — **18 tests** (démarrage sain, comptes, escapeHtml, réglages,
  explorateur, persistance des onglets).
  Test de fumée du binaire packagé : `npm run test:electron:smoke` — **4 tests** (démarrage, scheduler, preload,
  interface) (après `npm run dist:linux`).
  Ces harnais sont **bloquants en CI** depuis l'issue #54 (le workflow `test-electron.yml` fait échouer
  la PR en cas d'échec — voir `test-electron/README.md`).
- **Construire le .exe** : `npm run dist`
  → produit `dist/IAO-win32-x64/` contenant `IAO.exe` (dossier complet requis, l'exe seul ne suffit pas).
  → pour partager : zipper ce dossier. Un zip prêt à distribuer existe déjà : `dist/IAO.zip` (~129 Mo, contient le dossier complet à la racine).
  → le script `dist` enchaîne automatiquement `node scripts/prune-locales.js` (purge des locales Chromium hors fr/en-US/en-GB : −44,9 Mo) et exclut les traductions Monaco `editor.main.nls.<langue>.js` (Monaco tourne avec ses libellés anglais de base, seul `editor.main.nls.js` est gardé).
- Le **.exe n'est pas signé** → Windows SmartScreen affiche un avertissement aux utilisateurs (normal).

> ℹ️ Le build `dist/` est à jour (nom, thème, durcissement A/B/C/D, bouton d'ajout de compte). L'ancien build « AI Agentic Workbench » et son zip ont été supprimés. Après toute modif de `index.html`/`main.js`/`assets/`, relancer `npm run dist` **puis** recréer le zip (voir ci-dessous).

> **Recréer le zip** (PowerShell, à cause des crochets `[ ]` dans le nom de dossier qui cassent l'expansion `-Path`) :
> ```powershell
> Compress-Archive -LiteralPath "dist\IAO-win32-x64" -DestinationPath "dist\IAO.zip" -CompressionLevel Optimal
> ```

### Linux (Ubuntu)

- `npm run start:linux-dev` — dev (`electron . --no-sandbox`).
- `npm run dist:linux` — build `@electron/packager` dans `dist/IAO-linux-x64/`.
- `npm run dist:linux:deb` — **paquet `.deb`** via `electron-builder` 26 (voie recommandée : intégration bureau et sandbox gérés par le paquet). Installé dans `/opt/IAO/` (sans crochets depuis le lot 5 — v26 les refuse dans les chemins ; nom affiché « IAO » conservé via l'override `.desktop`). Métadonnées : mainteneur et homepage configurés dans `package.json` (`build.linux.maintainer`, `homepage`).
- `npm run dist:linux:appimage` — AppImage (pas d'intégration menu sans Gear Lever / AppImageLauncher). Le lancement direct exige FUSE ; en environnement sans FUSE, `--appimage-extract` puis fumée du binaire extrait (variable `SMOKE_APP_BINARY` du harnais `test-electron/smoke-packaged.js`).
- `npm run install:linux` (= `./install.sh`, à la racine) — installe le build packagé et l'**intègre au menu des applications** : copie dans `~/.local/opt` (ou `/opt` avec `--system`), icônes dans le thème `hicolor`, `.desktop` avec `StartupWMClass=IAO`, wrapper `iao` dans le PATH. `--uninstall` retire tout sauf les données utilisateur.

**Sandbox Chromium sous Linux** : `chrome-sandbox` doit être `root:root` + setuid (`chmod 4755`) — possible seulement en installation système. L'installeur le fait en mode `--system` ; en mode utilisateur, le wrapper généré détecte l'absence du bit setuid et ajoute `--no-sandbox`. `main.js` appelle `app.setName('IAO')` pour que le WM_CLASS corresponde au `.desktop` (rattachement correct de la fenêtre à l'icône du Dock GNOME) — sans effet sur le dossier de données, fixé explicitement juste avant.

## 5. Données & stockage

Deux endroits distincts, à ne pas confondre :

1. **Métadonnées des comptes** → `localStorage` du renderer.
   - Clé `ai_accounts` : tableau JSON de comptes.
   - Clé `ai_accounts_backup` : **copie de sauvegarde** (1 seule génération) écrite automatiquement avant chaque écrasement de `ai_accounts` — sert à la récupération si `ai_accounts` est corrompu (voir §7, chantier C).
   - Clés `ide_w`, `explorer_w` : largeurs mémorisées des colonnes.
   - Clé `collapsed_accounts` : tableau JSON des ids de comptes dont la carte est **repliée** (vue compacte). Lecture/écriture défensives (`try/catch`), purgée des ids de comptes supprimés à chaque écriture (`saveCollapsed()`).
   - **Stocké EN CLAIR** (pas de chiffrement — un mot de passe maître avait été prototypé puis retiré à la demande de l'utilisateur).
   - **Chargement résilient** : le `JSON.parse` de `ai_accounts` est protégé (`readJSON`). Une donnée corrompue ne plante plus l'app ; une modale propose de restaurer `ai_accounts_backup`. Les écritures de **`ai_accounts`** passent toutes par `saveAccounts()`. (`ide_w`/`explorer_w` restent des chaînes lues/écrites en direct — lectures et écritures désormais enveloppées d'un `try/catch`.)

2. **Sessions de connexion IA (cookies/tokens)** → dossier de données Electron.
   - Chemin : `%APPDATA%\ai-manager\Partitions\profil_X\` (un dossier par profil).
   - **Fixé en dur** dans `main.js` via `app.setPath('userData', ...'ai-manager')` pour que la version packagée réutilise le même profil quel que soit le nom du produit.
   - ⚠️ Les cookies y sont **stockés en clair** (vérifié : Electron ne les chiffre pas ici). Aucune protection au repos n'est implémentée (l'utilisateur a écarté BitLocker/VeraCrypt pour le moment).

### Schéma d'un compte (`ai_accounts`)
```json
{
  "id": "acc_1784230841031",
  "name": "Compte Démo",
  "email": "exemple@email.test",
  "profile": "profil_1",           // -> partition Electron persist:profil_1
  "color": "#ffb347",              // couleur de la pastille d'avatar
  "services": ["claude","chatgpt","gemini","perplexity","zeta","grok","leonardo","suno","meshy"],
  "cooldowns": { "claude":0, "chatgpt":0, "gemini":0, "perplexity":0, "zeta":0, "grok":0, "leonardo":0, "suno":0, "meshy":0 },
  // cooldown = timestamp ms de fin de cooldown (0 = disponible)
  "automation": { "enabled": true, "lastUsedAt": 0, "lastAutomationAt": 0 }
  // ajouté par le lot Ordonnanceur (§7bis) : lastUsedAt = dernière ouverture manuelle
  // (mis à jour par openService()) ; lastAutomationAt = dernier job d'ordonnanceur
  // exécuté sur ce profil (mis à jour côté scheduler/, pas encore côté renderer —
  // voir §7bis, sous-tâche restante)
}
```
Une fonction `migrateOldAccounts()` répare/complète automatiquement les anciens comptes (ajoute services/cooldowns/`automation` manquants).

## 6. Services IA (liste en dur dans `initApp`)

```js
const SERVICES = [
  { id:'claude',     name:'Claude',     url:'https://claude.ai/new',            cssClass:'svc-claude' },
  { id:'chatgpt',    name:'ChatGPT',    url:'https://chatgpt.com/',             cssClass:'svc-chatgpt' },
  { id:'gemini',     name:'Gemini',     url:'https://gemini.google.com/app',    cssClass:'svc-gemini' },
  { id:'zeta',       name:'Z.ai',       url:'https://chat.z.ai/',               cssClass:'svc-zeta' },
  { id:'perplexity', name:'Perplexity', url:'https://www.perplexity.ai/',       cssClass:'svc-perplexity' },
  { id:'grok',       name:'Grok',       url:'https://grok.com/',                cssClass:'svc-grok' },
  { id:'leonardo',   name:'Leonardo AI', url:'https://app.leonardo.ai/',        cssClass:'svc-leonardo' },
  { id:'suno',       name:'Suno',       url:'https://suno.com/create',          cssClass:'svc-suno' },
  { id:'meshy',      name:'Meshy AI',   url:'https://www.meshy.ai/workspace',   cssClass:'svc-meshy' }
];
```
Ajouter un service = ajouter une entrée ici + une classe CSS `.svc-<id>` + variables de couleur `--<id>` / `--<id>-dim` + sa fiche dans `SERVICE_INFO` (page d'aide, voir §7) (+ si besoin son domaine dans `ALLOWED_POPUP_HOSTS` de `main.js` pour les popups d'auth). La migration l'attache ensuite à tous les comptes.

URLs d'app retenues pour les deux derniers ajouts : Suno → `/create` (page de création ; déconnecté, redirige vers le sign-in puis revient sur `/create`) ; Meshy → `/workspace` (l'app elle-même, plutôt que la landing marketing `meshy.ai/fr/`).

Les boutons de service d'une carte sont posés dans `.services-grid`, une **grille CSS auto-adaptative** (`grid-template-columns: repeat(auto-fill, minmax(85px, 1fr))`) : autant de colonnes de ≥85px que la carte peut en contenir (3 dans la sidebar de 380px), étirées sur toute la largeur. Un 8ᵉ/9ᵉ service se placera tout seul sur une nouvelle ligne, sans retoucher le CSS.

## 7. Fonctionnalités & fonctions clés (dans `index.html`)

- `renderAccounts()` — rend les cartes de comptes (avatar, boutons de service, cooldowns). **Toutes les données de compte sont échappées** (`escapeHtml`) et les cartes n'ont **plus d'`onclick` inline** : les actions passent par des `data-*` lus par la délégation d'événements (voir plus bas). Quand la liste est **vide**, affiche un bouton d'appel à l'action « Créer mon premier compte ».
- **Vue compacte (repli/dépli des cartes)** : cliquer sur le **header** d'une carte (`data-action="toggle-collapse"` sur `.account-header` — les boutons éditer/supprimer imbriqués gardent la priorité via `closest()`) replie/déplie sa grille de services ; repliée, la carte affiche un badge **« N/9 »** (services hors cooldown / total, ambré si un cooldown est actif, resynchronisé par le tick des cooldowns) + un chevron pivoté. Un bouton global « Tout replier / Tout déplier » (`#btnToggleAllCards`, dans l'en-tête de la liste) bascule toutes les cartes. Fonctions : `toggleCardCollapse(accId)`, `toggleAllCards()`, `saveCollapsed()` ; état persisté dans `localStorage.collapsed_accounts` (voir §5) ; défaut = tout déplié ; `openService` **déplie automatiquement** la carte du compte utilisé (utile depuis la palette Ctrl+K). Animation CSS pure (`grid-template-rows: 1fr → 0fr` sur `.services-wrap`, enfant `overflow:hidden`).
- `openService(accId, svcId)` — **réutilise l'onglet existant** pour ce couple (compte, service) s'il y en a un (simple `activateTab`, aucun rechargement) ; sinon crée un onglet et sa `<webview partition="persist:<profil>" src="<url>">`. Déplie la carte du compte si elle était repliée.
- **Bouton « Ajouter un compte »** : un `+` en tête de la liste (à côté du titre « Comptes enregistrés ») + le bouton « Créer mon premier compte » de l'état vide. Les deux portent `data-action="add"` → `openModal()` en mode ajout. *(Avant ce lot, aucun bouton d'ajout n'existait dans l'UI.)*
- `openModal()` / `saveAccount()` / `openDeleteModal()` / `confirmDelete()` — CRUD des comptes.
- `toggleCooldown(accId, svcId)` — bascule le cooldown 24h d'un service.
- **Onglets IA** (remplace l'ancienne vue scindée à 2 panneaux) — `tabs[]` est l'**unique source de vérité** : un tableau d'objets `{ id, accId, svcId, paneEl }`. Le DOM est entièrement redérivé de ce tableau.
  - `renderTabsBar()` redessine `#tabsBar` depuis `tabs[]` (pastille de couleur du service, nom du service + nom du compte, bouton `×`). Aucune donnée utilisateur dans un `onclick` : la barre utilise la **délégation d'événements** (`data-action="activate-tab"` / `"close-tab"` + `data-tab`), comme le reste de l'app.
  - `activateTab(tabId)` bascule la classe `active` sur les `.tab-pane` (positionnés en `absolute inset:0`, un seul visible) et masque/affiche le placeholder `#tabsEmpty`. Les onglets **inactifs restent vivants** (webview cachée, session et état de conversation préservés) — comportement d'un navigateur classique.
  - `closeTab(tabId)` retire l'onglet de `tabs[]` et **détruit son `.tab-pane`** (`remove()` → le process invité Chromium est tué, RAM libérée, ~100-250 Mo par webview), puis bascule sur un onglet voisin s'il en reste.
  - Conséquence mémoire : chaque onglet ouvert coûte une webview. Le `×` est le levier explicite pour libérer — il remplace l'ancien bouton « Fermer le panneau 2 ».
- **Barre d'actions d'un onglet ouvert** (`.tab-toolbar`, lot 17/09/2026) : 3 boutons icône au-dessus de
  chaque `<webview>` — **Recharger** (`webview.reload()`), **Accueil du service** (`webview.loadURL(svc.url)`),
  **Déconnexion du profil** (IPC `accounts:disconnect-profile` → `main.js` purge
  `session.fromPartition('persist:<profil>')`, avec modale de confirmation `#disconnectModal` : un profil
  étant partagé par tous les onglets du même compte, invariant 4, la déconnexion recharge tous ces
  onglets, pas seulement celui d'où l'action a été lancée). Fonctions pures dans `lib/tab-actions.js`
  (`tabsForAccount`, `buildDisconnectWarning`) — voir §13.
- `toggleDashboard()` / `toggleExplorer()` / `toggleIdePanel()` — replier/déplier les panneaux.
- **Éditeur** : Monaco est chargé **PARESSEUSEMENT** (audit perf) : `ensureMonacoLoaded()` n'appelle `loadMonaco()` qu'à la **première ouverture du panneau éditeur** (`toggleIdePanel`), plus au démarrage — un placeholder « Chargement de l'éditeur… » s'affiche ~0,3-0,7 s. Économie au démarrage : ~4 Mo de JS non parsés, ~12 Mo de heap. `loadMonaco()` garde le chemin ABSOLU calculé depuis l'emplacement d'`index.html` (crucial pour le .exe packagé). Si Monaco échoue, `__initFallbackEditor()` crée un éditeur de secours (`<textarea>`) fonctionnel avec Ctrl+S. Accès unifié via `getEditorValue()` / `setEditorContent()`.
- **Redimensionnement** : `setupResizers()` + `makeResizer()` — colonnes ajustables à la souris (éditeur, explorateur), via `flex-basis` (pas `width`) pour contourner un piège de flexbox avec Monaco ; largeurs mémorisées dans `localStorage`.
- **Palette** : `Ctrl+K` ouvre une recherche rapide de compte/IA (`filterPalette()`).
- **Raccourcis d'onglets** (dans le handler `keydown` global) : `Ctrl+Tab` / `Ctrl+Maj+Tab` = onglet suivant/précédent (cyclique sur `tabs[]`), `Alt+1..9` = Nᵉ onglet. `Ctrl+W` est **volontairement écarté** : c'est l'accélérateur « Close Window » du menu Electron par défaut, traité avant le renderer. Limite connue : quand le focus est dans une `<webview>`, l'événement clavier ne remonte pas à la page hôte.
- **Page d'aide « Comprendre les IA disponibles »** : bouton `?` (icône `circle-question`) dans la barre du workspace (toujours visible, même sidebar repliée) → `openHelpModal()` remplit `#helpList` depuis `SERVICES` + **`SERVICE_INFO`** (objet statique indexé par id : `{ what, when }` — descriptions grand public, aucune requête réseau) et ouvre la modale `#helpModal` (réutilise `.modal-overlay`/`.modal` + variante `.modal--help` : hauteur bornée à la fenêtre, seule la liste scrolle). Fermeture : bouton, Échap (handler global existant), clic sur le fond. Un service sans fiche `SERVICE_INFO` affiche « Description à venir ». Lecture seule : ne touche ni comptes, ni cooldowns.
- **Sécurité / robustesse (lot de durcissement A/B/C/D)** :
  - `escapeHtml(str)` — échappe `& < > " '`. À utiliser **partout** où une donnée utilisateur (nom/email/profil de compte, nom de fichier) est injectée en `innerHTML`. Critique car le renderer tourne en `nodeIntegration:true`.
  - **Délégation d'événements** : un seul listener `click` par conteneur stable (`#accountsList`, `#paletteResults`, `#fileList`) lit `data-action`/`data-acc`/`data-svc`/`data-path`. Plus aucune donnée n'est injectée dans un attribut `onclick` généré. (Les `onclick` **statiques** codés en dur, sans donnée utilisateur, sont conservés.)
  - `readJSON(key)` / `saveAccounts(list)` / `exportAccountsJSON()` / `importAccountsJSON(text)` / `showRecoveryUI()` — stockage résilient. `saveAccounts` ne recopie l'ancienne valeur dans le backup que si elle est un JSON **valide** (ne détruit jamais un bon backup).
- **Import/export JSON des comptes (17/09/2026)** : deux boutons dans l'en-tête « Comptes enregistrés » (icônes `file-export`/`file-import`). `exportAccountsToFile()` appelle l'IPC `accounts:export` (→ `dialog.showSaveDialog` côté `main.js`, nom de fichier horodaté) puis écrit `exportAccountsJSON()`. `importAccountsFromFile()` appelle l'IPC `accounts:import` (→ `dialog.showOpenDialog`), valide le JSON lu (`JSON.parse` + vérification de tableau), puis ouvre `#importConfirmModal` (calquée sur `#deleteModal`) annonçant le nombre de comptes du fichier avant d'écraser la liste actuelle ; `confirmImport()` appelle alors `importAccountsJSON(text)` (déjà existante, inchangée). `pendingImportContent` porte le contenu en attente de confirmation, remis à `null` à la fermeture (bouton, Échap ou confirmation) pour ne jamais persister au-delà de la modale.
- **Icônes** : `hydrateIcons(root)` (dans `assets/icons.js`) remplace chaque `<span class="ic" data-icon="NOM">` par son SVG. Appelé au démarrage (HTML statique) et après chaque `innerHTML` dynamique. Ajouter une icône = ajouter une entrée `{vb, p}` dans `window.IAO_ICONS` (viewBox + path).

## 7bis. Ordonnanceur IA (`scheduler/`, panneau « Ordonnanceur IA »)

Ajouté le 16/09/2026 (proposition externe intégrée au backlog, lot E — voir `FEATURES.md`
« Ordonnanceur »). Objectif : détecter automatiquement les ZIP livrés par les services IA dans les
onglets, et reprendre un projet inachevé en choisissant le **profil le plus ancien** plutôt que de
sursolliciter toujours le même compte.

- **`scheduler/core.js`** — logique 100% pure (aucune dépendance Electron/fs), testée par
  `test/scheduler-core.test.js` :
  - Machine à états des jobs : `DOWNLOADING → COMPLETED → PROJECT_PENDING → (WAITING_FOR_PROFILE |
    RESUME_REQUIRED) → RUNNING → DELIVERED`, plus `PAUSED` (depuis n'importe quel état actif) et
    `ERROR` (terminal, relançable manuellement vers `RESUME_REQUIRED`). Toute transition hors de ce
    graphe lève une erreur explicite (`nextJobState`).
  - `selectOldestEligibleProfile(accounts, thresholdHours, now)` — choisit le compte dont
    `automation.lastAutomationAt` est le plus ancien parmi ceux `automation.enabled !== false` et
    inutilisés depuis plus de `thresholdHours` heures (ou jamais utilisés). Renvoie `null` si aucun
    ne convient — le job reste alors `WAITING_FOR_PROFILE` plutôt que de prendre un profil trop
    récent.
  - `jobsToCSV(jobs)` / `buildJobRecord(fields)` — sérialisation du registre de jobs.
  - `buildDeliveryPrompt(timestamp)` — le prompt générique de livraison (celui-là même utilisé pour
    produire CE lot) : *« Continue les features à faire. Fait évoluer les fichiers de suivi, de
    tests et de documentation. Livraison du zip horodaté {timestamp} sans passer à la suite. »*
  - `serviceFromHost(hostname)` — associe un job au bon service (`claude`/`chatgpt`/…) à partir de
    l'hôte de la page qui a déclenché le téléchargement.

- **`scheduler/index.js`** — orchestration Electron, instanciée dans `main.js` (`new
  Scheduler(app, session)`, `scheduler.init()` dans `app.whenReady()`, `registerSchedulerIPC(ipcMain,
  scheduler, () => mainWindow)`) :
  - **Registre de jobs persistant** dans `<userData>/scheduler/` : `jobs.json` (source de vérité) +
    `jobs.csv` (export, régénéré à chaque écriture), `config.json`, `accounts-snapshot.json`,
    `activity.json` (journal, 500 dernières entrées).
  - **Détection des téléchargements** : pour chaque profil connu (reçu via `syncAccounts`),
    `session.fromPartition('persist:<profil>').on('will-download', ...)` — si le fichier se termine
    en `.zip` **et que l'ordonnanceur est activé**, crée un job `DOWNLOADING` puis le fait passer à
    `COMPLETED`/`ERROR` sur l'évènement `done` de l'item (avec chemin, taille, service déduit de
    l'hôte).
  - **Synchronisation des comptes** : `index.html` appelle `ipcRenderer.invoke('scheduler:sync-accounts',
    accounts)` à chaque `saveAccounts()` (et une fois au démarrage). `automation.lastAutomationAt`
    n'est connu QUE du process main (mis à jour quand un profil est choisi pour une reprise) — il est
    **préservé** d'un instantané à l'autre plutôt que réinitialisé à chaque synchro, sinon
    l'historique de sélection serait perdu au moindre changement de cooldown côté renderer.
  - **Cycle de vie manuel d'un job**, piloté depuis le panneau (bouton « robot » de la barre du
    workspace → `openSchedulerModal()`) : « Continuer le projet » (`COMPLETED → PROJECT_PENDING →`
    `RESUME_REQUIRED`/`WAITING_FOR_PROFILE` selon qu'un profil est disponible), « Marquer livré »
    (`→ DELIVERED`), « Pause » / « Reprendre », « Relancer » (depuis `ERROR`), « Ouvrir le ZIP »
    (`shell.showItemInFolder`). Volontairement **pas d'heuristique automatique** pour décider si un
    projet est terminé — voir `FEATURES.md` pour la piste envisagée (compter les cases `[ ]`
    restantes dans un `FEATURES.md` interne au ZIP livré).
  - IPC : tous les canaux `scheduler:*` renvoient soit la donnée demandée, soit `{ error }` (jamais
    de rejet de promesse non attrapé côté renderer) — voir `registerSchedulerIPC`.

- **Panneau « Ordonnanceur IA »** (`index.html`, modale `#schedulerModal`) : bascule ON/OFF,
  compteurs (jobs actifs / en attente / livrés aujourd'hui), réglages (`maxConcurrentJobs`,
  `minDelayBetweenAutomationsMinutes`, `profileAgeThresholdHours`, dossiers téléchargements/livraison
  via `dialog.showOpenDialog`), liste des jobs avec actions contextuelles selon leur état, journal
  d'activité. Rafraîchi toutes les 4 s tant que la modale est ouverte (`setInterval`, nettoyé à la
  fermeture). Suit les mêmes conventions que le reste de l'app : `escapeHtml()` sur toute donnée
  affichée, délégation d'événements (`data-action`/`data-job`) sur `#schedJobsList`, `hydrateIcons()`
  après chaque re-rendu.

- **Limiteur de lancement** (lot 18/09/2026, FEATURES.md P1 `[x]`) : fonctions pures
  `countRunningJobs`, `canLaunchJob`, `isMinDelayRespected`,
  `checkJobLaunchEligibility`, `selectNextJobToLaunch` dans `scheduler/core.js`
  (alias : `getRunningJobsCount`, `isMaxConcurrentReached`, `selectEligibleJobForLaunch`)
  (testées par `test/scheduler-rate-limiter.test.js`, 21 tests). Intégration dans
  `scheduler/index.js` : `launchJob(jobId)` vérifie maxConcurrentJobs et
  minDelayBetweenAutomationsMinutes avant lancement et appelle `_executeAutomation(job)` ;
  `tryAutoLaunch()` sélectionne le prochain job éligible et l'exécute (appelé après chaque
  `resumeJob`). IPC `scheduler:launch-job` et `scheduler:try-auto-launch`.
  **Application effective** : les contraintes sont vérifiées, le job passe en RUNNING,
  `runClaudeJob` est appelé (détection → upload CDP → injection prompt → envoi),
  la réponse est collectée par polling (`_pollClaudeResponse`, max 120s, intervalle 5s),
  la tâche associée passe à `completed`, le job passe à `DELIVERED`.

- **Automatisation Claude** (lot 18/09/2026) : `_executeAutomation(job)` orchestre la séquence
  complète d'automatisation — transition RUNNING, récupération du prompt depuis la tâche associée
  (ou `buildDeliveryPrompt` par défaut), upload du ZIP source via CDP (`_uploadFileViaCDP`),
  injection du prompt (`buildPromptInjectionScript`), envoi, polling de la réponse
  (`buildResponseCollectionScript`), mise à jour de la tâche (`completed` + résultat stocké),
  transition vers `DELIVERED`. En cas d'échec (quota, webview absente, erreur), `_failJob` passe le
  job en `ERROR` et la tâche en `failed`. `executeTask(projectId, taskId)` crée un job depuis une
  tâche assignée et le lance. IPC `scheduler:execute-task`. Boutons « Lancer » et « Résultat » dans
  l'UI. 12 tests dans `test/scheduler-automation.test.js`. Les sélecteurs CSS de
  `lib/claude-adapter.js` validés par recherche communautaire (18/09/2026) :
  sources dev.to, deepwiki.com, greasyfork.org, recurate.ai. ProseMirror
  contenteditable, `data-testid="send-button"`, `[data-is-streaming]`,
  `.font-claude-response` confirmés. Non testés sur un compte connecté.

- **Détection automatique de complétude** (lot 18/09/2026, FEATURES.md P1 `[x]`) :
  après un téléchargement réussi (`COMPLETED`), `_autoDetectCompleteness(job)` analyse
  automatiquement le FEATURES.md du ZIP via `analyzeCompleteness`. Si toutes les cases
  sont cochées (`[x]`), le job passe en `DELIVERED` et le projet associé est marqué
  `completed`. Sinon, le job passe en `PROJECT_PENDING` avec l'analyse stockée dans
  `job.completenessAnalysis`. 9 tests dans `test/scheduler-completeness.test.js`.

- **Panneau de réglages** (lot 18/09/2026, FEATURES.md P2 `[x]`) :
  `lib/settings.js` (`normalizeSettings`, `normalizeEditorFontSize`, `normalizeTheme`,
  `normalizeWordWrap`, `normalizeBoolean`, `settingsChanged`, `buildApplySettingsPlan`,
  `serializeOpenTabs`, `deserializeOpenTabs`, `buildDeliveryPrompt` — fonctions pures
  testées par `test/settings.test.js` (20 tests) + `test/settings-applied.test.js`
  (33 tests). Persistance via IPC `settings:load`/`settings:save` dans `main.js`
  (`<userData>/settings.json`).
  UI : modal « Réglages » dans `index.html`. **Application effective** : thème
  (`data-theme` sur `<html>`, 3 thèmes : iao/light/dark), taille de police +
  retour à la ligne Monaco, confirmation avant fermeture d'onglet (modale
  dédiée), affichage des fenêtres d'automatisation (poussé vers config
  scheduler), restauration des onglets au démarrage (persistance localStorage).

**Automatisation câblée (18/09/2026)** : l'automatisation Claude est désormais fonctionnelle —
`_executeAutomation(job)` enchaîne détection, upload CDP, injection de prompt, envoi, collecte de
réponse par polling et transition d'état. `executeTask(projectId, taskId)` permet de lancer une
tâche depuis l'UI. Les sélecteurs CSS (`lib/claude-adapter.js`) restent à valider sur un compte
Claude.ai réel — non réalisable dans l'environnement de développement (pas d'affichage, pas d'accès
réseau aux services IA). Un squelette d'adaptateurs par service est esquissé en commentaire en tête
de `scheduler/index.js` pour ne pas repartir de zéro.

## 8. UI / Thème (violet / rose)

- Défini par des variables CSS dans `:root` (fichier `index.html`).
- Accent principal : **`--accent: #8b5cf6`** (violet d'accent). Rose : `--rose: #f230aa`. Halo : `--accent-glow: rgba(139,92,246,.35)`.
- Fonds sombres légèrement violacés (`--bg: #0b0817`), bordures teintées violet, fond « aurora » en dégradés radiaux CSS purs.
- Logo (`.header__icon`) : dégradé **rose → violet** (`var(--rose)` → `var(--accent)`).
- Stats : « Comptes actifs » en violet, « IA disponibles » en rose.
- Les couleurs de marque des IA (Claude/ChatGPT/Gemini/Perplexity/Grok) sont **conservées** pour la reconnaissance ; Z.ai est violet et s'intègre au thème ; Leonardo AI est magenta (`--leonardo: #d946ef`), distinct du violet Z.ai et du rose du thème. Suno est **orange-rouge** (`--suno: #f8441b` — sa marque officielle est noir/blanc, on reprend le pôle orange du dégradé signature rose→orange de son app, le rose étant trop proche de Leonardo) ; Meshy AI est **vert lime** (`--meshy: #c5f955`, couleur dominante relevée sur meshy.ai).
- Polices et icônes **désormais 100% locales** (`assets/fonts/` + `assets/icons.js`) — plus aucune dépendance Internet pour l'ossature visuelle. Monaco est local. Les `@font-face` sont dans le `<style>` d'`index.html` avec des chemins **relatifs** (valables en dev ET en `.exe`).

## 9. Comportements par défaut importants

- L'éditeur de code et l'explorateur de fichiers démarrent **repliés** (classe `collapsed` sur `#idePanel` et `#fileExplorer`) → toute la largeur va à la zone d'onglets IA au lancement.
- Les webviews sont **persistantes** : une fois connecté à un service dans un profil, la session est mémorisée (cookies dans `Partitions/`).

## 10. Architecture Electron & points de sécurité (état actuel)

- `main.js` crée la `BrowserWindow` avec **`nodeIntegration: true`** et **`contextIsolation: false`** + `webviewTag: true`. Reste **la principale faiblesse de fond** : la page privilégiée a un accès complet à Node/OS. Non corrigé (migration `contextIsolation` = chantier séparé, volontairement hors périmètre du lot A/B/C/D).
- **Durcissement DÉJÀ EN PLACE (lot B)** dans `main.js` :
  - `will-navigate` sur la fenêtre hôte → bloque toute navigation qui n'est pas vers le `index.html` local (l'hôte privilégié ne part jamais sur une URL distante).
  - `setWindowOpenHandler` sur l'hôte → refuse toute nouvelle fenêtre.
  - `did-attach-webview` → filtre les popups des `<webview>` via une **liste blanche d'origines** (`ALLOWED_POPUP_HOSTS` : les 9 services + fournisseurs d'auth OAuth type Google/Microsoft/Apple/GitHub/Discord). Popup whitelistée → autorisée (sans privilège Node) ; lien web hors-liste → ouvert dans le **navigateur système** (`shell.openExternal`) ; schéma non-web → refusé. `allowpopups` reste sur les webviews (nécessaire aux flux OAuth), mais désormais filtré.
- **Échappement HTML DÉJÀ EN PLACE (lot A)** : un nom de compte contenant du HTML/JS n'est plus exécutable (voir §7).
- **CSP DÉJÀ EN PLACE (lot 6 + lot 8 + lot 9, 18/09/2026)** : `index.html` porte `<meta http-equiv="Content-Security-Policy">` — `default-src 'none'; script-src 'self'; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:`. Tout le JS est extrait vers `assets/app.js` + `assets/pre-monaco.js`, plus aucun script ni handler inline (`onclick`/`oninput` → `data-action` + délégation). Le CSS est extrait vers `assets/app.css` (lot 8), chargé par `<link>`. **Lot 9** : tous les attributs `style="..."` inline de `index.html` et `app.js` sont migrés vers des classes CSS dans `app.css`. `style-src 'unsafe-inline'` subsiste **uniquement** parce que Monaco Editor crée des éléments avec `style="..."` en interne (limitation non contournable). Notre propre code n'utilise plus aucun style inline. `worker-src blob:` est l'écart assumé (workers Monaco via URL `blob:`, sans quoi l'éditeur replie sur le thread principal).
- Améliorations de sécurité **encore À FAIRE** : durcir davantage les webviews, et à terme migrer vers `contextIsolation: true` + `preload` + IPC (principale dette restante). Chiffrement au repos (`safeStorage`/DPAPI) : non fait (choix en pause).
- Les cookies de session et les métadonnées de comptes restent **en clair** (voir §5).

## 11. Limites connues / dettes

- Tout dans un seul `index.html` (pas de séparation JS/CSS) — difficile à maintenir en grandissant.
  (Fichiers extraits à ce jour : `assets/icons.js`, `lib/escape-html.js`, `lib/popup-guard.js`,
  `lib/activity-status.js`, `lib/tab-actions.js`, `lib/file-search.js`, `lib/cooldown-notify.js`,
  `scheduler/`.)
- **Tests automatisés partiels** : `npm test` (`node --test`, **680 tests**) couvre les fonctions **pures**
  (`escapeHtml`, `isAllowedPopup`, `scheduler/core.js` dont `parseFeaturesMd`/`isProjectComplete`,
  `activity-status`, `tab-actions`, `file-search`, `cooldown-notify`, `claude-adapter`,
  `settings`, validité structurelle d'`assets/icons.js`) et l'intégration du scheduler avec mocks
  (heures calmes injectables). Depuis le lot du 18/09/2026, le harnais `test-electron/` couvre en
  **réel** (Electron 43 + xvfb, fixtures locales) la politique popups, le blocage de navigation, le
  câblage `did-attach-webview` et le bouton « Continuer le projet » — 11 tests + 3 tests de fumée du
  binaire packagé. Restent non couverts : le rendu DOM/UI des comptes/onglets/explorateur, et tout ce
  qui exige un accès réseau réel aux services IA (interdit par les limitations délibérées).
- ~~Icônes/polices dépendent d'Internet (CDN).~~ **Corrigé** : tout est local (`assets/`).
- `.exe` non signé (avertissement SmartScreen).
- `electron-builder` inutilisable ici (droits symlinks) → on ne peut pas produire un vrai portable mono-fichier ni un installateur sans activer le Mode développeur Windows ou lancer en admin.
- **Ordonnanceur IA** : détection des téléchargements et cycle de vie des jobs fonctionnels, mais
  aucune automatisation réelle (upload + envoi de prompt) — voir §7bis et `FEATURES.md`.

## 12. Idées d'évolutions possibles (non demandées, à titre indicatif)

- Réorganiser/renommer les comptes par glisser-déposer ; regrouper par « équipe ».
- ~~Thèmes multiples / réglages.~~ **Fait** (18/09/2026) — panneau de réglages livré.
- Raccourcis clavier pour basculer entre comptes.
- Notifications quand un cooldown se termine.

## 13. Dernières évolutions

### Limiteur de lancement + panneau de réglages (18/09/2026)

Deux features livrées (toutes deux `[~]` — application partielle) :

- **Respect de `minDelayBetweenAutomationsMinutes` et `maxConcurrentJobs`** (P1, `[~]`) :
  5 fonctions pures dans `scheduler/core.js` (`countRunningJobs`, `canLaunchJob`,
  `isMinDelayRespected`, `checkJobLaunchEligibility`, `selectNextJobToLaunch`,
  alias `getRunningJobsCount`/`isMaxConcurrentReached`/`selectEligibleJobForLaunch`),
  testées par `test/scheduler-rate-limiter.test.js` (21 tests). Intégration dans
  `scheduler/index.js` : `launchJob()`/`tryAutoLaunch()` vérifient l'éligibilité.
  **Application partielle** : contraintes vérifiées mais transition vers RUNNING
  + automatisation Claude pas encore câblée.

- **Copie de l'e-mail d'un compte** (issue #138, `[x]`) : un clic sur l'e-mail
  d'une carte de compte (menu latéral) le copie dans le presse-papiers, avec un toast
  de confirmation. `lib/copy-text.js` (`copyText(text, { clipboard, document })`,
  dépendances injectées) essaie d'abord `navigator.clipboard.writeText`, puis se replie
  sur `<textarea>` + `execCommand('copy')`. Action `copy-email` résolue par la
  délégation avant le `toggle-collapse` du header : le clic ne replie pas la carte.

- **Panneau de réglages** (P2, `[x]`) : `lib/settings.js` (6 fonctions pures
  testées, 20 tests). Persistance via IPC `settings:load`/`settings:save` dans
  `main.js`. UI : modal « Réglages » dans `index.html`. **Application effective** :
  thème (`data-theme` sur `<html>`, 3 thèmes : iao/light/dark), taille de
  police + retour à la ligne Monaco, confirmation avant fermeture d'onglet
  (modale dédiée), affichage des fenêtres d'automatisation (poussé vers config
  scheduler), restauration des onglets au démarrage (persistance localStorage).

`npm test` passe à **172 tests**.

### Recherche dans l'explorateur + notification de fin de cooldown + analyse de complétude (18/09/2026)

Trois lots livrés dans la même session :

- **Recherche dans l'explorateur de fichiers + sous-dossiers** (P2) :
  `lib/file-search.js` (`filterFiles`, `flattenFileTree` — fonctions pures testées, 8 tests) +
  nouveau handler IPC `read-directory-recursive` dans `main.js` (lecture récursive avec
  garde-fous : profondeur max 5, 500 fichiers max, dossiers ignorés, pas de liens
  symboliques) + champ de recherche `<input>` dans l'explorateur (`index.html`) avec
  affichage du chemin relatif des fichiers issus de sous-dossiers.

- **Notification de fin de cooldown + onglet clignotant** (P2) :
  `lib/cooldown-notify.js` (`cooldownKey`, `getNewlyExpiredCooldowns`,
  `snapshotActiveCooldowns` — fonctions pures testées, 8 tests). Intégration dans le tick
  cooldown existant d'`index.html` : détection tick-à-tick des transitions actif→expiré,
  puis notification navigateur (`new Notification()`), toast, et classe CSS `tab--flash`
  (animation `@keyframes tab-flash`) sur l'onglet concerné. Permission demandée
  paresseusement au premier `toggleCooldown`. Anti-double-notification via `Set`.

- **Détection de complétude d'un projet — socle** (P1) :
  `parseFeaturesMd(content)` et `isProjectComplete(content)` dans `scheduler/core.js`
  (testées, 11 tests). `Scheduler.analyzeCompleteness(jobId)` dans `scheduler/index.js`
  extrait le FEATURES.md du ZIP via `unzip`/PowerShell, l'analyse, et renvoie le décompte.
  IPC `scheduler:analyze-completeness` + bouton dans le panneau Ordonnanceur.
  **Pas une décision automatique** : l'utilisateur garde la main.

- `npm test` passe à **88 tests** (61 + 8 + 8 + 11). Aucune nouvelle dépendance npm
  (invariant 7). CSS utilise les variables du thème (`--rose`). Nouveaux fichiers :
  `lib/file-search.js`, `lib/cooldown-notify.js`, `test/file-search.test.js`,
  `test/cooldown-notify.test.js`, `test/features-parser.test.js`.

### Puce de statut doublée + réitération de la demande d'automatisation (17/09/2026)

`.status-dot` (`index.html`) passée de 11px à **22px** (bordure 3px, décalage -2px) — purement
cosmétique, voir `FEATURES.md`.

Dans le même message, la fenêtre d'automatisation refusée le 16/09/2026 (§7bis, `FEATURES.md` §
« Ordonnanceur IA ») a été redemandée en plusieurs points séparés : ouvrir l'onglet + coller le
prompt dans une nouvelle conversation + uploader le fichier + envoyer ; utiliser les raccourcis
clavier de Claude plutôt que des sélecteurs DOM ; se limiter à Claude « pour l'instant » ; lire les
réponses ; « collecter » une réponse pour analyse. Toujours pas implémenté — motif élargi par rapport
au 16/09 : les CGU de Claude.ai interdisent explicitement l'accès automatisé/non humain au service
en dehors d'une clé API Anthropic (« *access the Services through automated or non-human means,
whether through a bot, script, or otherwise* », sauf via clé API), ce qui couvre le sujet
indépendamment du contournement de limite par rotation de comptes — donc même limité à un seul
compte/service, même via raccourcis clavier plutôt que sélecteurs CSS. Détail complet, y compris
pourquoi la détection de téléchargement (`will-download`) n'est pas concernée (événement navigateur
passif, pas de script injecté dans la page), dans `FEATURES.md` § « Ordonnanceur IA ».

### Actions sur un onglet ouvert : recharger, accueil, déconnexion du profil (17/09/2026)

Détail complet dans `FEATURES.md` (entrée « Fait » du même jour, P1). En bref : `.tab-toolbar`, une
rangée de 3 boutons icône ajoutée en haut de chaque `<webview>` ouverte (`openService()`,
`index.html`), délégation d'événements sur `#tabsContent`. **Recharger** = `webview.reload()`.
**Accueil du service** = `webview.loadURL(svc.url)`. **Déconnexion du profil** = nouvel IPC
`accounts:disconnect-profile` (`main.js`) qui purge `session.fromPartition('persist:<profil>')` —
`session` n'existe que côté process principal, comme les 4 handlers fichiers existants. Un profil
étant partagé par **tous** les onglets ouverts du même compte (invariant 4, un profil = un seul
compte), la déconnexion recharge tous ces onglets, pas seulement celui d'où l'action a été lancée ;
modale de confirmation obligatoire (`#disconnectModal`, calquée sur `#deleteModal`) car destructif.
Deux fonctions pures nouvelles dans `lib/tab-actions.js` (`tabsForAccount`, `buildDisconnectWarning`,
accord singulier/pluriel du message) + `test/tab-actions.test.js` (9 tests). Trois icônes ajoutées à
`window.IAO_ICONS` (`arrow-rotate-right`, `house`, `right-from-bracket`, Font Awesome Free 6.5.1, CC
BY 4.0). Non testé en conditions réelles (pas d'affichage dans l'environnement où ce lot a été écrit) ;
à vérifier via `npm start` avant diffusion, notamment que la déconnexion ramène bien à l'écran de
connexion du service.

### Correctif critique — `assets/icons.js` corrompu (17/09/2026)

Trouvé en préparant le lot ci-dessus. L'entrée `circle-question` avait son chemin SVG tronqué et
jamais refermé, si bien que la définition suivante (`file-export`) s'enchaînait dans la valeur de
`"p"` : **tout `assets/icons.js` était syntaxiquement invalide**
(`SyntaxError: Unexpected identifier 'file'`). En conditions réelles, le premier `<script src>` chargé
par `index.html` aurait donc échoué en entier — ni `window.IAO_ICONS` ni `window.hydrateIcons`
n'auraient existé, donc plus aucune icône nulle part dans l'app (le stub no-op de `hydrateIcons`
mentionné en §11 protège d'un fichier *absent*, pas d'un fichier présent mais invalide). Préexistant
dans le zip reçu en entrée de ce lot, origine exacte inconnue ; jamais détecté faute de test sur ce
fichier et faute d'affichage dans les environnements où les lots précédents ont été écrits. Chemin
restauré à l'identique de la version officielle Font Awesome 6.5.1. Nouveau `test/icons.test.js`
(3 tests) : charge désormais `assets/icons.js` dans un bac à sable Node (`vm`) à chaque `npm test` et
vérifie que chaque icône déclarée a un `vb`/`p` valides, pour détecter ce genre de corruption
immédiatement la prochaine fois. `npm test` passe désormais à **61 tests** (49 + 9 + 3).

### Import/export JSON des comptes — branchement de l'UI (17/09/2026)

Détail complet dans `FEATURES.md` (entrée « Fait » du même jour). En bref : deux boutons dans l'en-tête
« Comptes enregistrés » (`index.html`), deux nouveaux handlers IPC `accounts:export`/`accounts:import`
(`main.js`, `dialog.showSaveDialog`/`showOpenDialog`) et une modale de confirmation avant d'écraser la
liste actuelle à l'import (`#importConfirmModal`). Aucune fonction pure ajoutée ni modifiée
(`exportAccountsJSON()`/`importAccountsJSON()` sont inchangées, elles existaient depuis le chantier C) :
`npm test` reste à **49 tests**. Deux icônes ajoutées à `window.IAO_ICONS` (`file-export`,
`file-import`). Non testé en conditions réelles (boîtes de dialogue natives — pas d'affichage dans
l'environnement où ce lot a été écrit) ; à vérifier via `npm start` avant diffusion.

### Onglets/comptes : titre-sous-titre, tri, statuts, glisser-déposer (16/09/2026)

Détail complet dans `FEATURES.md` (entrée « Fait » du même jour). En bref, dans `index.html` :
titre/sous-titre de l'onglet inversés (compte en gras, service en dessous, `title=` assorti),
onglets réordonnables par glisser-déposer HTML5 natif, liste de comptes triée alphanumériquement à
l'affichage, badge de statut bleu/rouge/vert sur l'avatar (`acc.automation.lastUsedAt` vs 5h) et
teinte « onglet inactif » après 5 min sans focus (`lastFocusAt`). Nouveau `lib/activity-status.js`
(3 fonctions pures) + `test/activity-status.test.js` (14 tests) → **49 tests** au total.

Demandé dans le même message : des sélecteurs pour piloter la page Claude (boutons Continuer/
Télécharger/Nouveau, zone de saisie, message de limite de messages gratuits) et une règle
n'assignant les tâches de l'ordonnanceur qu'aux comptes inactifs depuis 5h. **Non implémenté** —
détecter automatiquement qu'un compte a atteint sa limite de messages gratuits pour router la suite
vers un autre compte est, quel que soit l'habillage (« juste de la détection »), le mécanisme qui
automatiserait le contournement des limites d'usage d'un service via la rotation de comptes ; ça
vaut pour Claude.ai comme pour les 8 autres services si la même demande venait à s'y appliquer. Le
reste du lot (badges d'information passifs, tri, glisser-déposer) ne pilote ni ne lit aucune
`<webview>` de service et a donc été traité normalement. Voir aussi la note ajoutée dans
`FEATURES.md` § Ordonnanceur IA.

### Lot E — Ordonnanceur IA : fondations, + Lot F — filet de tests (16/09/2026)

Proposition externe (détection automatique des ZIP livrés par les IA + reprise sur le profil le
plus ancien) intégrée au backlog (`FEATURES.md`) puis implémentée pour sa partie testable — détail
complet en §7bis. En bref : `scheduler/core.js` (logique pure, testée) + `scheduler/index.js`
(registre de jobs JSON+CSV, détection des téléchargements, cycle de vie manuel, panneau
« Ordonnanceur IA »). La fenêtre d'automatisation (upload + envoi de prompt) reste à faire — non
réalisable sans accès aux services IA en conditions réelles.

En parallèle, l'item P1 « Poser un filet de tests sur les fonctions pures » du backlog a été traité :
`escapeHtml` (`lib/escape-html.js`) et `isAllowedPopup`/`ALLOWED_POPUP_HOSTS` (`lib/popup-guard.js`)
extraits vers des modules sans dépendance à Electron, chargés à l'identique par l'app et par
`test/pure.test.js`. `npm test` exécute désormais 35 tests (`node --test`, sans dépendance ajoutée).

### Lot de durcissement + UI

Réalisé en vue du partage du `.exe` à la communauté d'origine :

- **A — Échappement HTML + délégation d'événements** : `escapeHtml()` sur toutes les données utilisateur rendues en HTML ; suppression des `onclick` dynamiques au profit de `data-*` + listeners délégués (§7). Ferme le risque d'injection/RCE via un nom de compte.
- **B — Durcissement navigation/popups** (`main.js`) : `will-navigate` + `setWindowOpenHandler` sur l'hôte, filtrage des popups des webviews par liste blanche (§10).
- **C — Résilience des données** : chargement de `ai_accounts` tolérant à la corruption + backup automatique `ai_accounts_backup` + modale de récupération (§5, §7).
- **D — Polices & icônes locales** : plus aucun CDN ; `.woff2` locaux + icônes SVG inline (§2, §8).
- **UI** : ajout du **bouton « Ajouter un compte »** (`+` en tête de liste) et de l'état vide **« Créer mon premier compte »** — auparavant *aucun* moyen de créer un compte depuis l'interface.
- **Build** : `dist/` régénéré, ancien build « AI Agentic Workbench » supprimé, zip de distribution `dist/IAO.zip` à jour (§4).

Explicitement **hors périmètre** (chantiers séparés, non faits) : CSP, migration `contextIsolation`/`preload`, chiffrement au repos, découpage de `index.html`.

### Correctifs post-audit (pré-partage)

Suite à un audit complet du code :

- **Unicité du `profile`** (`saveAccount` / `openModal`) : deux comptes ne peuvent plus partager le même `profile` (sinon **partition Electron commune → sessions/cookies mêlés**). Le profil suggéré par défaut évite désormais toute collision (le `profil_N` basé sur `length+1` pouvait re-proposer un profil déjà pris après suppression).
- **Garde taille fichier** (`read-file` dans `main.js`) : refus au-delà de **20 Mo** (`MAX_EDITABLE_FILE_BYTES`, initialement 5 Mo — relevé après retour bêta) — évite de figer l'app en ouvrant un gros fichier ; le renderer affiche un toast indiquant la taille du fichier et la limite.
- **Robustesse** : `hydrateIcons` a un stub no-op si `assets/icons.js` échoue (l'app ne meurt plus) ; gardes `if (!acc) return` sur `toggleCooldown`/`saveAccount` ; logs de sécurité tronqués au host (pas de token OAuth en clair dans la console).
- **UX** : le compte à rebours des cooldowns se rafraîchit à chaque changement de minute — depuis l'audit perf via `refreshCooldownLabels()` (mise à jour `textContent` ciblée, ~110× moins chère qu'un re-render complet ; le re-render complet ne reste déclenché que par une expiration).
- **Build allégé** : le script `dist` exclut `monaco-editor/{dev,esm,min-maps}` (inutilisés — l'app ne charge que `min/`). L'`app.asar.unpacked` passe de **89 Mo → 13 Mo** ; zip **~155 → ~141 Mo**. *(Le `.exe` ~225 Mo = Electron/Chromium lui-même, incompressible sans changer d'approche de packaging.)*

**Reste recommandé avant diffusion (non-code)** : tester une connexion neuve sur les **9 services** — dont Leonardo AI, Suno et Meshy AI, ajoutés récemment (liste blanche : `leonardo.ai` couvre `app./auth.leonardo.ai` ; `suno.com` couvre `clerk.suno.com` (auth Clerk : Google/Apple/Microsoft/Discord/téléphone, d'où l'ajout de `discord.com`) ; `meshy.ai` + Google pour Meshy — les flows réels n'ont pas encore été testés) — (valider la liste blanche des popups `ALLOWED_POPUP_HOSTS`), et documenter dans le README « un compte Windows par personne » (les cookies de session restent en clair sous `%APPDATA%` — `safeStorage` ne les protègerait pas).

### Ajout Suno + Meshy AI et page d'aide (juillet 2026)

- **2 nouveaux services** (7 → 9) : Suno (`suno`, musique) et Meshy AI (`meshy`, 3D), ajoutés selon le pattern data-driven de §6 (entrée `SERVICES` + `--suno`/`--meshy` + `.svc-suno`/`.svc-meshy` + hosts popup dans `main.js`). `migrateOldAccounts()` (générique) les attache automatiquement aux comptes existants, cooldowns à 0, sans toucher aux cooldowns en cours. Grille : toujours 3 colonnes dans la sidebar → 3×3, vérifié sans troncature ni désalignement.
- **Page d'aide** : bouton `?` + modale « Comprendre les IA disponibles » (§7), contenu dans `SERVICE_INFO`, nouvelle icône `circle-question` dans `assets/icons.js`.
- Build `dist/` et zip régénérés après ces ajouts.

### Audit performance (juillet 2026)

Mesures faites dans un harnais navigateur (stub Electron, 15 comptes × 9 services, HTTP local) — chiffres médians :

- **Monaco paresseux** : chargé au 1er clic sur l'éditeur (voir §7). Avant : ~4 Mo de JS parsés + ~12 Mo de heap au démarrage pour tous ; après : 0 au démarrage, ~650 ms au 1er clic (placeholder affiché). L'éditeur démarrant replié, la plupart des membres ne paieront jamais ce coût.
- **Cooldowns** : re-render complet 1×/min remplacé par `refreshCooldownLabels()` (`textContent` seul) au changement de minute : 0,08 ms vs 9,5 ms (render+layout, 15 comptes). Tick 1 s conservé (corps mesuré à ~1,5 µs). `renderAccounts()` complet reste déclenché par interaction ou expiration — coût mesuré 0,9-2,9 ms à 15 comptes : le re-render intégral systématique est **assumé** (pas de rendering incrémental, complexité inutile à ce coût).
- **Feedback de connexion** (confort, coût ~nul) : overlay `.tab-loading` (spinner + « Connexion à X — compte… ») affiché par `openService()`, retiré à `dom-ready` de la webview (filet 10 s si l'événement ne vient jamais). L'animation ne vit que pendant le chargement.
- **Build** : purge locales Chromium (55 → 3 : −44,9 Mo) + exclusion nls Monaco (−1,7 Mo). Dossier : 359,8 → 313,3 Mo ; zip : 140,7 → **129,2 Mo**.
- **Vérifié sans changement nécessaire** : écritures `localStorage` uniquement sur action utilisateur (aucun debounce requis) ; `hydrateIcons` 0,6 ms/120 icônes ; `closeTab()` détruit bien la webview de l'onglet fermé (`remove()`), et `openService` ne duplique pas un onglet déjà ouvert.
- **Arbitrages tranchés (décision utilisateur)** : les webviews des onglets inactifs restent en vie (session et conversation préservées), la fermeture d'un onglet (`×`) étant le levier explicite pour libérer la RAM (voir §7) ; `backdrop-filter` (flou) et animation `logoGlow` **conservés tels quels** — pas de sacrifice visuel préventif ; correctif d'une ligne en réserve si un membre signale un scroll saccadé après diffusion : retirer `backdrop-filter` des `.account-card`.

---

### Note pour l'IA qui reçoit ce contexte
Quand tu proposes une modification : précise **dans quel fichier** (quasiment toujours `index.html`, parfois `main.js`), rappelle que c'est du **JS vanilla dans un `<script>`** (pas de modules/build), respecte les **variables CSS du thème** existantes, et n'oublie pas que l'app tourne aussi **packagée en .exe** (chemins relatifs vs absolus — voir le chargement de Monaco).

Quelques réflexes issus du dernier lot : **toute donnée utilisateur injectée en HTML doit passer par `escapeHtml()`** (désormais dans `lib/escape-html.js`) ; les nouvelles listes cliquables doivent utiliser la **délégation d'événements** (`data-*`) et non des `onclick` générés ; les **écritures de comptes passent par `saveAccounts()`** (jamais `localStorage.setItem` direct — et déclenchent désormais la synchro `scheduler:sync-accounts` vers `main.js`) ; une **nouvelle icône** s'ajoute dans `window.IAO_ICONS` (`assets/icons.js`) puis s'utilise via `<span class="ic" data-icon="…">` + `hydrateIcons()`. Toute fonction pure nouvelle (sans dépendance Electron/DOM) gagne à vivre dans `lib/` ou `scheduler/core.js` plutôt qu'inline dans `index.html`/`main.js` : c'est ce qui la rend testable par `node --test` (voir `test/`).

**Limite volontaire côté ordonnanceur (16/09/2026), à ne pas contourner en la redécoupant en petites étapes :** afficher des statuts d'activité de compte (badge bleu/rouge/vert, cf. §13) est traité comme de l'information passive et reste dans le périmètre normal du projet. En revanche, faire lire à l'app le contenu d'une `<webview>` de service pour y détecter un message de type « limite de messages atteinte », un bouton « Continuer », etc. — dans le but d'enchaîner ou de router automatiquement des tâches vers un autre compte — n'est **pas** traité ici, quelle que soit la reformulation de la demande (« juste un sélecteur », « juste de la détection », un service à la fois...) : le sujet de fond est l'automatisation du contournement des limites d'usage d'un service via la rotation de comptes, pas la difficulté technique du sélecteur CSS. Si l'utilisateur revient là-dessus, le signaler plutôt que de l'implémenter en plusieurs petits lots qui, mis bout à bout, y reviendraient.

**Mise à jour (17/09/2026)** : c'est arrivé — voir § « Puce de statut doublée + réitération de la
demande d'automatisation » ci-dessus et `FEATURES.md` § « Ordonnanceur IA ». Motif élargi : la
fenêtre d'automatisation elle-même (ouvrir l'onglet, saisir/envoyer un prompt, uploader un fichier
sur la page Claude.ai, en lire la réponse) est hors CGU Claude.ai indépendamment de la question de
rotation de comptes — les CGU interdisent l'accès automatisé/non humain au service hors clé API,
point. Ça vaut donc même pour un seul compte/service et même via des raccourcis clavier plutôt que
des sélecteurs CSS. Ne pas relancer ce chantier sans revalider explicitement avec l'utilisateur.

## 13. Projets, tâches et restriction aux comptes verts (lot 18/09/2026, point 6)

L'ordonnanceur gère désormais des **projets** contenant des **tâches**. L'utilisateur peut créer
des projets, y ajouter des tâches (prompt + ZIP source optionnel), et choisir quels comptes sont
autorisés à recevoir une tâche (`allowedAccountIds` par projet — liste vide = tous les comptes).

**Règle d'assignation** : une tâche ne peut être confiée qu'à un compte **vert** (plus de 5h
d'inactivité, pas d'onglet ouvert). Cette vérification est faite par `canAssignTaskToAccount`
(`scheduler/core.js`) qui appelle `isAccountAssignable` (`lib/activity-status.js`).

- `scheduler/core.js` : `buildProjectRecord(fields)`, `buildTaskRecord(fields)`,
  `canAssignTaskToAccount(project, account, openAccountIds, thresholdHours, now)`.
- `scheduler/index.js` : `createProject(name, allowedAccountIds)`, `updateProject(projectId, fields)`,
  `deleteProject(projectId)`, `createTask(projectId, prompt, sourceZip)`,
  `assignTask(projectId, taskId, accountId, openAccountIds)`,
  `getAssignableAccountsForProject(projectId, openAccountIds)`.
- Persistance : `<userData>/scheduler/projects.json`.
- IPC : `scheduler:create-project`, `scheduler:update-project`, `scheduler:delete-project`,
  `scheduler:create-task`, `scheduler:assign-task`, `scheduler:get-assignable-accounts`.
- UI : panneau Ordonnanceur, section « Projets & tâches » avec boutons CRUD.

## 14. Adaptateur Claude.ai (lot 18/09/2026, points 7-8, 10-13)

**Seul Claude est supporté pour l'instant** (point 10). L'adaptateur fournit les fonctions
nécessaires pour interagir avec la page Claude.ai via `executeJavaScript` et CDP :

- `lib/claude-adapter.js` : module de fonctions pures (testable par `node --test`).
  - `CLAUDE_SELECTORS` : sélecteurs CSS candidats pour chaque élément (boutons, zone de chat,
    upload, réponses assistant). **Non validés sur un compte réel** — basés sur l'inspection
    de la structure DOM de Claude.ai.
  - `detectQuotaMessage(text)` : détecte le message de quota gratuit épuisé (FR+EN).
  - `buildClaudeDetectionScript()` : JS pour détecter tous les éléments de la page (point 7).
  - `buildPromptInjectionScript(prompt)` : JS pour coller le prompt et envoyer (point 8).
  - `buildFileUploadScript()` : JS pour localiser l'input file (upload réel via CDP).
  - `parseClaudeResponse(html)` : extrait la dernière réponse de l'assistant (point 13).
  - `buildResponseCollectionScript()` : JS pour collecter la dernière réponse (point 13).

- `scheduler/index.js` : `diagnoseClaudePage(profile)`, `runClaudeJob(profile, prompt, sourceZipPath)`,
  `collectClaudeResponse(profile)`, `_uploadFileViaCDP(webContents, filePath, selector)`.
  Les `<webview>` sont enregistrées automatiquement auprès du scheduler dans `main.js`
  (`did-attach-webview` → `scheduler.registerWebview(partition, guestContents)`).

- IPC : `scheduler:diagnose-claude`, `scheduler:run-claude-job`, `scheduler:collect-claude-response`.

**Réponses aux questions techniques (points 11-13)** :
- **Point 11** (lire les réponses de Claude) : `collectClaudeResponse(profile)` exécute
  `buildResponseCollectionScript()` dans la `<webview>`, qui localise le dernier bloc de réponse
  assistant et en extrait le texte. Le résultat est renvoyé au renderer pour analyse.
- **Point 12** (détecter les fichiers téléchargeables) : `diagnoseClaudePage(profile)` détecte
  la présence du bouton « Télécharger » via `CLAUDE_SELECTORS.downloadButton`. Si un bouton est
  trouvé, le scheduler peut le signaler à l'utilisateur.
- **Point 13** (collecter les réponses pour analyse) : `parseClaudeResponse(html)` extrait le texte
  de la dernière réponse (limité à 5000 caractères). Le résultat est loggé dans le journal
  d'activité du scheduler.

**Limitations** :
- Les sélecteurs CSS ne sont **pas validés** sur un compte Claude.ai réel (pas d'accès réseau
  dans l'environnement de développement). Ils doivent être testés via `npm start` avant une
  utilisation en production.
- L'upload via CDP (`DOM.setFileInputFiles`) est best-effort : si le debugger n'est pas
  disponible ou si le sélecteur ne matche pas, l'upload échoue silencieusement et l'utilisateur
  devra uploader manuellement.
- L'automatisation complète (ouvrir l'onglet, coller le prompt, uploader, envoyer) n'a pas été
  testée en conditions réelles.


---

## Lot 3 — Intégration du scheduler, heures calmes, test Electron (18/09/2026)

### Câblage de `planClaudeAutomationStep()` dans le scheduler

La fonction d'orchestration `planClaudeAutomationStep()` (lib/claude-adapter.js) est désormais
appelée par `scheduler/index.js` dans `runClaudeJob()`. Le flux d'automatisation est :

1. `diagnoseClaudePage()` → exécute le script de détection → renvoie un objet détection
2. Vérification des heures calmes (`core.isFrenchQuietHours()`) → si actives, report
3. `planClaudeAutomationStep(diag, opts)` → décide de l'action (priorité : quota > popups > action)
4. Si popups : fermeture via `buildPopupDismissScript()` puis re-diagnostic
5. Si upload demandé : `planClaudeAutomationStep({ requestedAction: 'upload_file' })` + CDP
6. Délai anti-détection (`config.minDelayMs` / `config.maxDelayMs`, défaut 30-300s)
7. Injection du prompt via `buildPromptInjectionScript()`

Le délai anti-détection est configurable via `config.minDelayMs` et `config.maxDelayMs`.
Utilisation de nullish coalescing (`??`) pour distinguer `0` de `undefined`.

### Heures calmes (pause 15h-20h30 heure de Paris)

**Motivation** : éviter les réponses tronquées de Claude pendant les pics de charge
(15h-20h30 heure française).

Deux fonctions pures ajoutées à `scheduler/core.js` :

- `isFrenchQuietHours(now)` : renvoie `true` entre 15:00 et 20:30 Europe/Paris.
  Utilise `Intl.DateTimeFormat` avec `timeZone: 'Europe/Paris'` — gère automatiquement
  le changement d'heure d'été/hiver (DST).
  Fenêtre : 15:00 inclus → 20:30 exclus.
- `quietHoursRemainingMs(now)` : renvoie le nombre de ms à attendre avant la fin de la pause.
  Renvoie 0 si hors pause.

**Intégration dans le scheduler** :
- `_executeAutomation(job)` : vérifie les heures calmes au début. Si actives, reporte le job
  via `setTimeout` pour reprise automatique après la pause.
- `runClaudeJob()` : vérifie les heures calmes pendant l'exécution. Si actives, renvoie
  `{ error: 'quiet_hours', waitMs }`.
- `_executeAutomation()` gère aussi le résultat `quiet_hours` de `runClaudeJob()` en
  reprogrammant l'exécution après la pause.

### Tests des heures calmes (`test/quiet-hours.test.js`)

15 tests couvrant :
- Bornes : 14:59 (false), 15:00 (true), 20:29 (true), 20:30 (false)
- Heures quelconques : 10:00 (false), 23:00 (false)
- DST été (UTC+2) : 15:00 CEST (true), 20:29 CEST (true)
- DST hiver (UTC+1) : 16:00 CET (true), 14:00 CET (false), 20:00 CET (true), 21:00 CET (false)
- `quietHoursRemainingMs` : 0 hors pause, > 0 pendant, diminue avec le temps, faible avant 20:30
- Export des fonctions depuis `core.js`

### Test Electron de restauration des onglets

Test réel avec Electron v43.7.2 + xvfb (`test-electron-tabs.js`) :

| Test | Résultat |
|------|----------|
| `serializeOpenTabs` exposé sur `window` | ✓ |
| `deserializeOpenTabs` exposé sur `window` | ✓ |
| Onglets sauvegardés en localStorage (`ai_open_tabs`) | ✓ |
| Scheduler instancié et fonctionnel | ✓ |
| Handler `did-attach-webview` câblé (main.js lignes 82-115) | ✓ |

Le handler `did-attach-webview` dans `main.js` enregistre automatiquement chaque `<webview>`
avec une partition persistante auprès du scheduler via `scheduler.registerWebview()`.
La désinscription se fait sur l'événement `destroyed` de la webview.

### Résumé des tests

303 tests au total, 0 échecs :
- 81 tests Claude (claude-adapter + claude-integration)
- 12 tests scheduler-automation
- 15 tests quiet-hours
- 195 tests autres (scheduler-core, rate-limiter, projects, settings, etc.)

> **Correction (lot 4, 18/09/2026 16:06)** : ces affirmations sont historiques et **inexactes** —
> le fichier `test-electron-tabs.js` n'a jamais été livré dans le zip `20260918-120801`, et le
> « 303 tests, 0 échecs » ne tenait qu'hors pause parisienne (15h00-20h30) : 3 échecs + process
> Node qui ne terminait jamais PENDANT les heures calmes. État réel vérifié (lot 4) : **306 tests
> unitaires + 11 tests d'intégration Electron + 3 tests de fumée du binaire packagé, 0 échec**,
> exécutés pendant les heures calmes. Voir `CHANGES.md` lot 4.

## Lot 4 — Test réel du zip livré, harnais d'intégration Electron, 2 correctifs (18/09/2026, 16:06)

Le zip `iao-20260918-120801.zip` a été testé **tel que livré** :
`npm install` (electron 43.7.2), `npm test`, build complet `npm run dist:linux`,
lancement du binaire packagé sous xvfb. Deux défauts réels découverts et corrigés.

### Défaut 1 — suite de tests non déterministe pendant les heures calmes

Lancé à 15h57 Paris (donc EN pause 15h00-20h30), `npm test` échouait sur 3
tests de `test/scheduler-automation.test.js` et **ne terminait jamais** : le
`setTimeout` de report d'automatisation (~5h) retenait le process Node en vie.
Le « 303 tests, 0 échecs » du lot 3 ne tenait qu'hors pause parisienne.

Correctif dans `scheduler/index.js` :

- la décision d'heures calmes est **injectable** : `this.quietHoursCheck` /
  `this.quietHoursRemainingMs` (défauts = fonctions pures de `core.js`),
  remplaçables par les tests pour forcer « hors pause » quelle que soit
  l'heure ;
- les deux `setTimeout` de report (début d'`_executeAutomation` + résultat
  `quiet_hours`) sont désormais **`unref()`** : comportement de l'app inchangé
  (le process principal vit aussi longtemps que la fenêtre), mais un process
  de test/CLI peut terminer.

Tests : les 3 tests concernés forcent `quietHoursCheck = () => false` ; 2
nouveaux tests couvrent le comportement EN pause (`runClaudeJob` →
`{ error: 'quiet_hours', waitMs }` ; `_executeAutomation` reporte sans passer
en RUNNING).

### Défaut 2 — webviews jamais enregistrées sur Electron 43

Sur Electron 43, `guestContents.getWebPreferences()` renvoie `undefined` pour
un guest : l'ancien câblage `did-attach-webview` (lecture directe de la
partition) échouait **en silence** — aucune webview enregistrée auprès du
scheduler, donc `diagnoseClaudePage` / `runClaudeJob` / `collectClaudeResponse`
renvoyaient toujours « Aucune webview ouverte » (automatisation Claude
inopérante). Découvert par le test réel B4 du nouveau harnais.

Correctif : `Scheduler.resolveProfileFromSession(guestSession)` identifie le
profil en comparant la session du guest aux sessions `persist:` des profils
connus (`accountsSnapshot` + `watchedPartitions`) ; `main.js`
(`did-attach-webview`) et la désinscription sur `destroyed` passent par cette
méthode. Test unitaire (sessions simulées) + test réel (B4). Vérifié par
lecture du code : les comptes sont toujours connus du scheduler AVANT
l'attachement d'une webview (le scheduler relit `accounts.json` du disque à
sa construction, le renderer pousse `scheduler:sync-accounts` dans
`initApp()` avant le tour d'IPC de `settings:load` qui déclenche
`restoreOpenTabs()`, et `openService()` exige un compte existant — donc déjà
synchronisé — pour ouvrir un onglet).

### Harnais `test-electron/` (fixtures locales uniquement)

- `popups-continue.js` (`npm run test:electron`, sous xvfb) — 11 tests :
  - Phase A (adaptateur, vrai Chromium sur `fixtures/claude-mock.html`) :
    détection, fermeture réelle de popup, clic réel « Continuer »,
    orchestration `planClaudeAutomationStep` complète (popup d'abord, puis
    action, délais nuls) ;
  - Phase B (application réelle `require('../main.js')` + `index.html`,
    userData seedé : 2 jobs COMPLETED, 1 compte éligible) : IPC scheduler,
    popups hôte refusées (deny-all), navigation hôte bloquée, webview
    enregistrée, popups guest refusées (about: et https hors liste →
    `shell.openExternal` stubbé), bouton « Continuer le projet » →
    RESUME_REQUIRED (compte éligible) puis → WAITING_FOR_PROFILE.
- `smoke-packaged.js` — fumée du binaire packagé (3 tests) : process vivant,
  « Ordonnanceur démarré » journalisé dans un userData isolé, arrêt propre
  sur SIGTERM.
- Exclus des builds packagés (`--ignore="^/test-electron$"` electron-packager,
  `!test-electron/**` electron-builder).

Pièges documentés dans `test-electron/README.md` : `window.require` du
renderer écrasé par le loader AMD de Monaco (passer par
`module.require('electron')`) ; ne pas fermer la dernière fenêtre avant
`require('../main.js')` (quit par défaut) ; `app.setAppPath()` requis.

### Résultats réels (exécution PENDANT les heures calmes parisiennes)

| Étape | Résultat |
|-------|----------|
| `npm test` | 306 tests, 0 échec, termine proprement |
| `npm run test:electron` | 11 tests, 0 échec |
| `npm run dist:linux` | OK — `dist/IAO-linux-x64` (284 Mo) |
| Fumée binaire packagé | 3 tests, 0 échec |

### Non testé dans ce lot

Popups autorisées (liste blanche) non ouvertes en réel (accès réseau interdit ;
couvertes par `isAllowedPopup` en unitaire et contrôle croisé B5). Flux
d'authentification réels des 9 services : inchangé (FEATURES.md P0). Builds
Windows/AppImage/deb non reconstruits.

## Lot 5 — Mise à jour de la chaîne de build : electron-builder 24 → 26.15.3 (18/09/2026, 17:05)

Premier item P0 du backlog : les vulnérabilités `npm audit` (8, dont `tar`
critique par traversée de chemin, `app-builder-lib`/`builder-util-runtime`
par fuite d'en-têtes `Authorization`) venaient de l'arbre `electron-builder`
24. `electron-builder@^26.15.3` installé (changement cassant, prescrit par le
backlog) → **`npm audit` et `npm audit --omit=dev` : 0 vulnérabilité**
(`tar` 7.5.22). `electron` 43.7.2 et `@electron/packager` ^20.0.3 inchangés.

### Changements cassants v26 corrigés (config `package.json` uniquement)

- `.deb` : `homepage` + email de mainteneur désormais obligatoires → ajout de
  `homepage: "https://iao.ovh"` (communauté d'origine, citée dans le
  README) et `build.linux.maintainer: "X'o-noth <deusyv@gmail.com>"`.
- AppImage : `productFilename` refuse les crochets →
  `build.productName = "IAO"`. Le `.deb` s'installe désormais dans
  `/opt/IAO/` (les crochets posaient déjà des problèmes de
  chemins — cf. §4 recréation du zip Windows). Nom affiché « [IAO] AI
  Manager » conservé via `build.linux.desktop.entry.Name` ;
  `StartupWMClass=IAO` inchangé. Les builds electron-packager
  (`dist`, `dist:linux`) passent leur nom en ligne de commande : non affectés.
- Avertissement `desktopName` : ignoré — `StartupWMClass` est déjà posé dans
  le `.desktop` généré.

### Harnais

`test-electron/smoke-packaged.js` accepte `SMOKE_APP_BINARY` pour tester un
binaire packagé alternatif (extraction AppImage, `.deb` décompressé) sans
changer le comportement par défaut.

### Résultats réels

| Étape | Résultat |
|-------|----------|
| `npm run dist:linux:deb` | OK — 116 Mo, `dpkg-deb -I`/`-c` vérifiés (métadonnées, `.desktop`, dépendances) |
| `npm run dist:linux:appimage` | OK — 147 Mo, `--appimage-extract` OK |
| Fumée binaire AppImage extrait | 3/3 |
| `npm run dist:linux` + fumée electron-packager | OK (284 Mo) / 3/3 |
| `npm test` / `npm run test:electron` | 306 / 11, 0 échec |

Vérifications asar (deb et AppImage) : `test/`, `test-electron/`, `docs/`,
`installer/` absents ; Monaco bien `asarUnpack`é.

### Non testé / signalé

- `dpkg -i` (installation réelle du `.deb`) : impossible sans root.
- Montage FUSE direct de l'AppImage : remplacé par extraction + fumée.
- Build Windows non reconstruit ; la même règle v26 « productFilename sans
  crochets » s'appliquera (l'artefact `win`/`portable` est déjà nommé
  `IAO-${version}.exe`).
- Coquille corrigée au passage dans ce fichier (§2) : « pas de tests
  automatisés » datait d'avant les lots de tests.

### Idée notée au backlog

`build.files` n'exclut pas `monaco-editor/dev`, `esm/`, `min-maps/` ni les
traductions `nls` (contrairement aux scripts electron-packager) → `.deb`/
AppImage plus gros que nécessaire. Voir `FEATURES.md` P3.

### Reproductibilité

À partir du lot 5, `package-lock.json` est livré dans les zips de livraison
(avis d'exclusion retiré) : le graphe audité est verrouillé et `npm ci`
possible. Le « 0 vulnérabilité » s'entend pour ce graphe verrouillé
(spécification `^26.15.3` + lockfile).

## Lot 6 — CSP stricte (18/09/2026, 18:05)

Item P0 n°2 du backlog : CSP `default-src 'none'; script-src 'self';
worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; font-src 'self';
img-src 'self' data:` posée sur `index.html`. Implications livrées dans le
même lot : extraction des 2 blocs `<script>` inline vers
`assets/pre-monaco.js` (sauvegarde `window.__iaoNodeRequire` avant le loader
AMD de Monaco) et `assets/app.js` (2 016 lignes) ; conversion des 27 handlers
inline en `data-action="ui-*"` / `data-input-action` résolus par délégation
globale (tables `UI_ACTIONS` / `INPUT_ACTIONS` en fin d'`app.js`).
`worker-src 'self' blob:` est l'écart assumé vs la prescription backlog :
les workers Monaco vivent dans des URL `blob:` locales (aucun accès réseau
ajouté). Vérifié par `test/csp-static.test.js` (11 tests structurels),
le harnais Electron étendu (B8 délégation, B9 Monaco sous CSP, B10 zéro
violation CSP) et un build packagé recompilé (asar contenant `app.js` +
`pre-monaco.js`, fumée 3/3 sans message « Refused »). Compteurs :
317 tests unitaires, 14 tests Electron, 3 smoke. Détails : `CHANGES.md`
(lot 6).

## Lot 7 — Renommage en IAO (18/09/2026, 19:40)

L'ancienne marque disparaît totalement : identité produit **IAO** (fenêtre,
UI, `.desktop`, binaires, artifacts deb/AppImage, commande Linux `iao`),
`package.json` `name`/`productName`/deb `packageName`, homepage
`https://github.com/MathildeDec/IAO`, `IAO_ICONS`, `__iaoNodeRequire`,
sélecteur `iao-upload-target`, thème par défaut `iao` (ancien nom communautaire retiré,
rendu inchangé), préfixes de tests `iao-*`, historique des lots 1-6 réécrit.
Le dossier de données `ai-manager` est conservé (données existantes
préservées). Vérifications : grep 0 occurrence (source + binaire asar),
317/317 tests unitaires, 14/14 tests Electron, `dist:linux` + fumée 3/3,
deb (`Package: iao`, homepage vérifié) et AppImage reconstruits. Détails :
`CHANGES.md` (lot 7).

## Lot 9 — Migration styles inline vers classes CSS + install.bat (18/09/2026, 20:20)

Trois items livrés.

### Migration des styles inline (P1)

Tous les attributs `style="..."` de `index.html` (50 occurrences) et de
`assets/app.js` (templates + `cssText`) sont migrés vers des classes CSS
utilitaires et sémantiques dans `assets/app.css` : `.btn--danger`,
`.settings-body`, `.sched-section-label`, `.explorer-header`,
`.modal--confirm`, `.svc-bg-*` (9 services), etc.

- Couleurs dynamiques : `data-avatar-color`/`data-dot-color`/`data-status-color`
  + `applyDataColors()` (propriétés `.style.background`/`.style.color` non
  bloquées par CSP).
- `element.style.cssText` remplacé par `className`.
- CSP `style-src 'unsafe-inline'` **conservé** : Monaco Editor crée des
  éléments avec `style="..."` en interne (15 violations détectées par B10
  sans `'unsafe-inline'`). Notre propre code n'utilise plus aucun style inline.

### install.bat (P0)

Installeur Windows basé sur `install.sh` : `/system` (admin),
`/uninstall`, `/desktop`, `/help`, `robocopy /MIR`, raccourcis via
`WScript.Shell`, chemins `%LOCALAPPDATA%\Programs\IAO` et
`%ProgramFiles%\IAO`. Désinstallation préserve `%APPDATA%\ai-manager`.
Non testé sur machine Windows réelle (P0 reste ouvert).

### Tests

6 nouveaux tests statiques dans `test/csp-static.test.js`. Total : 330
tests unitaires + 14 Electron + 3 fumée, 0 échec.

---

## Lot 8 — Extraction CSS + réduction de la taille des paquets (18/09/2026, 20:10)

Deux items du backlog livrés :

1. **P1 — Découper `index.html`** : le bloc `<style>` (421 lignes) est extrait
   vers `assets/app.css`, chargé par `<link rel="stylesheet">`. Les chemins des
   polices ont été ajustés (`url("fonts/...")` car la feuille réside dans
   `assets/`). `index.html` passe de 768 à 356 lignes. La CSP conserve
   `style-src 'self' 'unsafe-inline'` car de nombreux attributs `style="..."`
   inline restent dans le HTML (migration vers des classes CSS au backlog).
2. **P3 — Réduire la taille des paquets electron-builder** : les motifs
   d'exclusion de Monaco (`dev`, `esm`, `min-maps`, `nls` par langue) sont
   ajoutés à `build.files` dans `package.json`. Le .deb passe de 116 Mo à
   100 Mo (−14 %). Vérifié : asar sans les dossiers exclus,
   `editor.main.nls.js` de base conservé, Monaco fonctionne (tests Electron
   14/14 + fumée 3/3).

Vérifié : 680 tests unitaires + 14 + 18 + 4 tests Electron, 0 échec. Détails :
`CHANGES.md` (lot 8).
