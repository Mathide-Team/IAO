# CLAUDE.md — règles de travail sur ce dépôt

Instructions destinées à Claude (ou à toute IA) travaillant sur **IAO**.
Contexte complet et historique : `docs/PROJECT_CONTEXT.md`. Backlog : `FEATURES.md`.

---

## 1. Le projet en dix lignes

Application **Electron** (Windows + Linux) qui sert de poste de travail multi-comptes pour
9 services d'IA web (Claude, ChatGPT, Gemini, Z.ai, Perplexity, Grok, Leonardo, Suno, Meshy).
Chaque compte a sa **partition Electron** (`persist:profil_N`) donc ses propres cookies ;
chaque couple (compte, service) s'ouvre dans un **onglet** contenant une `<webview>`.
S'y ajoutent un suivi de cooldown 24 h, un explorateur de fichiers et un éditeur Monaco.

- **JS vanilla**, pas de framework, pas de bundler, pas de TypeScript. Tests automatisés limités aux
  fonctions pures (`node --test`, voir `test/`) — rien sur le DOM/UI ni sur `main.js` lui-même.
- Tout le front (HTML + CSS + JS) tient dans **`index.html`** (~2080 lignes, fonction `initApp()`).
- **`main.js`** : fenêtre, `userData` fixé sur `ai-manager`, durcissement navigation/popups
  (`lib/popup-guard.js`), 4 handlers IPC fichiers, initialisation de l'**ordonnanceur IA**
  (`scheduler/`, voir `docs/PROJECT_CONTEXT.md` §7bis).
- Seule dépendance runtime : `monaco-editor`, chargé **en local** depuis `node_modules`.

## 2. Arborescence

```
install.sh        Installeur Linux (RACINE)      assets/icons.js   Icônes SVG inline + hydrateIcons()
install.bat       Installeur Windows (RACINE)    lib/              Fonctions pures (escapeHtml, popup-guard,
                                                  activity-status, tab-actions, file-search,
                                                  cooldown-notify) — testées
index.html        Toute l'app                    scheduler/        Ordonnanceur IA (core pur + orchestration Electron)
main.js           Process principal Electron     test/             Tests node --test
package.json      Scripts + config packaging     assets/fonts/     WOFF2 locaux
scripts/          prune-locales.js (post-build)  build/            Icônes PNG 16 → 1024
                                                  installer/        Modèle .desktop
                                                  docs/             PROJECT_CONTEXT, notices, notice de distribution
```

## 3. Commandes

| But | Commande |
| --- | --- |
| Lancer en dev | `npm start` (Linux : `npm run start:linux-dev`) |
| Lancer avec journal détaillé | `npm start -- --debug` (ou `IAO_DEBUG=1 npm start`) — journal : `<userData>/logs/iao.log` |
| Lancer les tests | `npm test` (= `node --test`) + `npm run test:electron` et `npm run test:electron:ui` (harnais réels, bloquants en CI) ; `npm run dist:linux && npm run test:electron:smoke` (binaire packagé) |
| Build Windows | `npm run dist` |
| Build Linux (packager) | `npm run dist:linux` |
| Paquet `.deb` | `npm run dist:linux:deb` |
| Installer sous Linux | `./install.sh` (ou `sudo ./install.sh --system`) |
| Installer sous Windows | `install.bat` (ou `install.bat /system`, `/desktop`) |
| Désinstaller | `./install.sh --uninstall` — `install.bat /uninstall` |

Il n'existe **pas** de `npm build` : la commande est `npm run dist` (ou `dist:linux`).

## 4. Invariants — à ne jamais casser

1. **`escapeHtml()` sur toute donnée utilisateur** injectée en `innerHTML` (nom, e-mail, profil, nom de fichier).
   Le renderer tourne en `nodeIntegration: true` : une injection HTML y équivaut à une exécution de code.
2. **Aucun `onclick` généré** contenant une donnée. Les listes cliquables passent par la **délégation
   d'événements** sur un conteneur stable (`data-action` / `data-acc` / `data-svc` / `data-path`).
   Les `onclick` statiques codés en dur, sans donnée, sont tolérés.
3. **Toute écriture de comptes passe par `saveAccounts()`** — jamais `localStorage.setItem('ai_accounts', …)`
   en direct (le backup `ai_accounts_backup` en dépend). Toute lecture JSON passe par `readJSON()`.
4. **Unicité du champ `profile`** entre comptes : deux comptes qui partagent un profil partagent leur
   partition Electron, donc leurs cookies. Vérifié dans `saveAccount()` / `openModal()`.
5. **Chemins relatifs** dans `index.html` (polices, Monaco) : l'app tourne aussi packagée. Monaco est
   résolu via un chemin absolu calculé depuis l'emplacement d'`index.html` — ne pas « simplifier ».
6. **Pas de CDN, pas de requête réseau** pour l'ossature de l'app : polices et icônes sont locales et
   doivent le rester (l'app doit s'afficher à l'identique hors ligne).
7. **Pas de nouvelle dépendance npm** sans validation explicite.
8. Une **nouvelle icône** s'ajoute dans `window.IAO_ICONS` (`assets/icons.js`), puis s'utilise via
   `<span class="ic" data-icon="…">` + `hydrateIcons(root)` après chaque `innerHTML` dynamique.
9. **`install.bat` reste en CRLF et en ASCII sans accents** : un `.bat` en LF casse les `goto`, et la
   console Windows n'est pas en UTF-8 par défaut. Toute modification doit conserver ces deux contraintes.
10. Les **couleurs viennent des variables CSS** du thème par défaut (`--accent: #8b5cf6`, `--rose: #f230aa`).
   Pas de valeur hexadécimale en dur hors de la définition d'un nouveau service.
11. **Toute fonction pure nouvelle (sans dépendance Electron/DOM) va dans `lib/` ou
   `scheduler/core.js`**, jamais inline dans `index.html`/`main.js` — c'est ce qui la rend testable
   par `node --test` sans lancer Electron. Ajouter le fichier de test correspondant dans `test/` dans
   le même lot.
12. **`preload.js` est sandboxé** (Electron ≥ 20 avec `nodeIntegration: false`) : il ne peut
   `require()` que `electron`, `events`, `timers` et `url`. Un `require('path')` (ou tout autre
   module Node) empêche le preload de s'exécuter, `window.iaoAPI` n'existe pas et **toute
   l'interface reste vide** (issue #52). Vérifié par `test/preload-sandbox.test.js`.

## 5. Ajouter un service IA (pattern data-driven)

1. Entrée dans `SERVICES` (`index.html`) : `{ id, name, url, cssClass: 'svc-<id>' }`.
2. Variables CSS `--<id>` / `--<id>-dim` + classe `.svc-<id>`.
3. Fiche `SERVICE_INFO[<id>] = { what, when }` (page d'aide `?`).
4. Domaine ajouté à `ALLOWED_POPUP_HOSTS` dans `main.js` si l'authentification ouvre une popup.
5. `migrateOldAccounts()` l'attache automatiquement aux comptes existants — rien d'autre à faire.

## 6. Méthode de travail attendue

- **Un lot = un sujet.** Pas de refactor opportuniste glissé dans une correction.
- Préciser **dans quel fichier** porte chaque modification (quasi toujours `index.html`, parfois `main.js`).
- Livrer le **diff ou le fichier complet**, jamais un extrait ambigu du type « ajoute ça quelque part ».
- Mettre à jour `docs/PROJECT_CONTEXT.md` (section concernée) et **cocher la ligne correspondante de
  `FEATURES.md`** dans le même lot.
- Signaler explicitement ce qui n'a **pas** pu être testé (aucun test automatisé dans le dépôt).

## 7. Checklist avant de rendre un lot

- [ ] Toute donnée utilisateur rendue en HTML passe par `escapeHtml()`.
- [ ] Aucun `onclick` généré avec une donnée ; délégation d'événements utilisée.
- [ ] Écritures de comptes via `saveAccounts()`, lectures via `readJSON()`.
- [ ] Aucun appel réseau ni CDN ajouté ; aucune dépendance ajoutée.
- [ ] `hydrateIcons()` rappelé après chaque `innerHTML` contenant des icônes.
- [ ] Aucun `<script>` inline ni attribut `on*=` inline dans `index.html` (CSP `script-src 'self'` : tout nouveau JS va dans `assets/app.js`, tout nouveau handler passe par `data-action` + `UI_ACTIONS` ; cohérence vérifiée par `test/csp-static.test.js`).
- [ ] `npm test` passe (toute fonction pure nouvelle/modifiée a son test dans `test/`).
- [ ] `npm run test:electron` et `npm run test:electron:ui` passent (bloquants en CI, issue #54) — en particulier si le lot touche `main.js`, la politique popups/navigation, le câblage webview/scheduler ou l'UI du panneau Ordonnanceur (harnais réel sous xvfb, fixtures locales — voir `test-electron/README.md`).
- [ ] Testé en dev (`npm start`) **et** raisonné pour le cas packagé (chemins).
- [ ] `docs/PROJECT_CONTEXT.md` et `FEATURES.md` mis à jour.

## 8. Hors périmètre sauf demande explicite

Migration `contextIsolation: true` + `preload`, découpage d'`index.html` en modules, chiffrement au
repos (`safeStorage`), CSP, signature des binaires. Ces chantiers sont listés dans `FEATURES.md` avec
leur impact — ils ne se traitent pas en passant.

## 9. Outils disponibles pour l'IA qui travaille ici

Si un serveur MCP **Context7** est disponible dans l'environnement (`resolve-library-id` /
`query-docs`), l'interroger au besoin pour vérifier une API récente d'une dépendance du projet
(Electron, `electron-packager`, Monaco Editor…) plutôt que de se fier uniquement à des connaissances
d'entraînement potentiellement datées — utile en particulier pour les API Electron sujettes à
changement (`session`, `webContents.debugger`, `dialog`). Ne pas en dépendre pour la logique propre
au projet (elle n'existe que dans ce dépôt) ; l'utiliser en complément, pas en remplacement de la
lecture du code existant.


## 10. Lot 3 — Scheduler câblé, heures calmes, test Electron (18/09/2026)

### Câblage de planClaudeAutomationStep()

La fonction `planClaudeAutomationStep()` (lib/claude-adapter.js) est désormais appelée par
`scheduler/index.js` dans `runClaudeJob()`. Le flux est :

1. `diagnoseClaudePage()` exécute le script de détection → renvoie un objet détection
2. Vérification des heures calmes (`core.isFrenchQuietHours()`) → si actives, report
3. `planClaudeAutomationStep(diag, opts)` décide de l'action (priorité : quota > popups > action)
4. Si popups : fermeture via `buildPopupDismissScript()` puis re-diagnostic
5. Si upload : `planClaudeAutomationStep({ requestedAction: 'upload_file' })` + CDP
6. Délai anti-détection (`config.minDelayMs` / `config.maxDelayMs`, défaut 30-300s)
7. Injection du prompt via `buildPromptInjectionScript()`

Le délai anti-détection est configurable via `config.minDelayMs` et `config.maxDelayMs`
(nullish coalescing `??` pour distinguer 0 de undefined).

### Heures calmes (pause 15h-20h30 Paris)

Deux fonctions pures dans `scheduler/core.js` :

- `isFrenchQuietHours(now)` : true entre 15:00 et 20:30 Europe/Paris (Intl.DateTimeFormat gère DST)
- `quietHoursRemainingMs(now)` : ms restantes avant la fin de la pause

Intégration :
- `_executeAutomation()` : si heures calmes, reporte le job (setTimeout pour reprise auto)
- `runClaudeJob()` : si heures calmes détectées pendant l'exécution, renvoie `{ error: 'quiet_hours', waitMs }`
- `_executeAutomation()` gère aussi `quiet_hours` dans le résultat de `runClaudeJob()`

### Test Electron de restauration des onglets

Test réel avec Electron v43.7.2 + xvfb (test-electron-tabs.js) :
- `serializeOpenTabs` / `deserializeOpenTabs` exposés sur `window` depuis `lib/settings.js` ✓
- Sauvegarde des onglets dans `localStorage` (clé `ai_open_tabs`) ✓
- Scheduler instancié et fonctionnel ✓
- Handler `did-attach-webview` câblé (main.js lignes 82-115) ✓

### Tests

303 tests au total, 0 échecs :
- 81 tests Claude (claude-adapter + claude-integration)
- 12 tests scheduler-automation
- 15 tests quiet-hours
- 195 tests autres (scheduler-core, rate-limiter, projects, settings, etc.)

## 11. Couverture de `assets/app.js` — décision (issue #100, parent #55)

`assets/app.js` (~2300 lignes de DOM, exécuté dans le renderer) est **exclu de l'objectif « 100 % »
et du seuil bloquant** de `npm run test:coverage` (qui ne mesure que `node --test`). Il n'est couvert
que fonctionnellement, par les harnais Electron (`test-electron/`), qui restent bloquants.

- **Pourquoi l'exclusion** : la couverture V8 mesurée (`Profiler.startPreciseCoverage`) donne
  **≈ 40 % des lignes et ≈ 34 % des fonctions** avec les 18 tests de `ui-flows.js` (29/09/2026).
  Atteindre 100 % impose de piloter chaque écran (ordonnanceur, éditeur Monaco, glisser-déposer,
  services IA sans réseau) : des dizaines de scénarios fragiles pour peu de valeur, alors que la
  logique testable a l'obligation d'être extraite dans `lib/` (invariant 11), où le 100 % s'applique.
- **Mesure conservée, informative** : `IAO_COVERAGE=1 npm run test:electron:ui` affiche la couverture
  V8 de `assets/app.js` (`IAO_COVERAGE_OUT=<fichier.json>` pour le détail, dont les lignes non
  exécutées). Ne change jamais le code de sortie du harnais. Calcul : `test-electron/v8-coverage.js`,
  testé par `test/v8-coverage.test.js`.
- **Règle** : ne pas faire baisser le pourcentage mesuré sans raison ; toute logique pure nouvelle
  va dans `lib/` avec son test, pas dans `assets/app.js`.
