# test-electron/ — harnais de tests d'intégration Electron réel

Lot du 18/09/2026 (« Teste le zip livré avec un build Electron local complet »).
Ces tests exécutent la **vraie application** (main.js + index.html) dans un
**vrai Chromium/Electron v43**, sous un serveur X virtuel (xvfb) — sans
affichage, sans accès réseau.

## Contrainte forte : fixtures locales uniquement

`docs/PROJECT_CONTEXT.md` (limitations délibérées) interdit tout accès réseau
réel aux services IA. Toutes les pages « IA » du harnais sont donc des fichiers
locaux dans `fixtures/` :

| Fixture | Rôle |
|---------|------|
| `fixtures/claude-mock.html` | Imitation du DOM de Claude.ai (popup + bouton close, bouton « Continuer », zone de chat ProseMirror, bouton envoyer, réponse assistant) reproduisant les sélecteurs de `lib/claude-adapter.js`. Les clics sont tracés via `data-clicked`. |
| `fixtures/guest.html` | Page minimaliste chargée dans une `<webview>` (partition `persist:`) pour tester la politique popups du guest. |

## Scripts

| Script | Ce qu'il teste | Commande |
|--------|----------------|----------|
| `popups-continue.js` | Intégration popups + bouton « Continuer » + CSP (14 tests) | `npm run test:electron` |
| `ui-flows.js` | Flux UI : démarrage sain (preload, icônes), comptes, escapeHtml, réglages, explorateur, restauration et persistance des onglets (18 tests) | `npm run test:electron:ui` |
| `smoke-packaged.js` | Fumée du binaire packagé : démarrage, scheduler, preload et interface chargés d'après `logs/iao.log`, arrêt propre (4 tests) | `npm run test:electron:smoke` (après `npm run dist:linux`) |

**Bloquant en CI depuis l'issue #54** : le workflow `test-electron.yml` exécute les
trois scripts, et chacun sort avec le code 1 au moindre échec. « Harnais Electron
(xvfb) » est un check requis sur `dev` et `main`. `ui-flows.js` coupe tout accès
réseau (`webRequest` annule le http/https dans toutes les sessions) : les webviews
des services restent vides.

Ces scripts ne sont PAS découverts par `node --test` (dossier `test-electron/`,
pas `test/`) : ils doivent être lancés explicitement. Ils ne sont PAS embarqués
dans les builds packagés (`--ignore="^/test-electron$"` côté electron-packager,
`!test-electron/**` côté electron-builder).

## Mesure de couverture de `assets/app.js` (informative)

`IAO_COVERAGE=1 npm run test:electron:ui` démarre la couverture V8 du renderer (CDP
`Profiler.startPreciseCoverage`, via `v8-coverage.js`) avant le rechargement de la page, puis affiche
une ligne `COV assets/app.js : lignes … fonctions …` en fin de run. `IAO_COVERAGE_OUT=<fichier.json>`
écrit le détail (lignes non exécutées comprises). Sans `IAO_COVERAGE`, rien ne change. Cette mesure
n'est **jamais bloquante** : `assets/app.js` est exclu de l'objectif 100 % (voir CLAUDE.md §11).

## Contenu de `popups-continue.js`

**Phase A — adaptateur sur fixture locale** (BrowserWindow + Chromium réel) :

- A1. `buildClaudeDetectionScript()` : bouton « Continuer », popups, zone de
  chat, bouton envoyer, bloc réponse détectés ; pas de faux quota.
- A2. `buildPopupDismissScript()` : la popup est réellement fermée dans le DOM,
  re-détection à zéro.
- A3. `buildContinueActionScript()` : clic réel sur « Continuer » (vérifié par
  `data-clicked`).
- A4. `planClaudeAutomationStep()` : orchestration complète — popup fermée
  d'abord, puis action « Continuer » (délais nuls via `rng`/`minDelayMs: 0`).

**Phase B — application réelle** (`require('../main.js')` tel quel, fenêtre et
userData seedés : 2 jobs `COMPLETED`, 1 compte éligible) :

- B1. La fenêtre charge `index.html` et l'IPC `scheduler:get-state` renvoie
  les jobs seedés.
- B2. La fenêtre hôte ne peut PAS ouvrir de popup (`setWindowOpenHandler`
  deny-all) — aucune webContents créée.
- B3. La fenêtre hôte ne peut PAS naviguer vers le web (`will-navigate`
  bloqué, URL restée `file://`).
- B4. Une `<webview>` (partition `persist:profil_electron_test`) est chargée
  et enregistrée auprès du scheduler par `did-attach-webview`
  (diagnostic IPC exécuté dans la webview).
- B5. Popups du guest : `about:` et `https` hors liste refusées (aucune
  webContents) ; le lien web hors liste part vers le navigateur système
  (`shell.openExternal` stubbé dans le harnais) ; contrôle croisé de
  `isAllowedPopup`.
- B6. Bouton « Continuer le projet » : `job_001` COMPLETED → RESUME_REQUIRED
  avec le profil du compte éligible (compte synchronisé via le vrai canal
  IPC `scheduler:sync-accounts`).
- B7. Bouton « Continuer le projet » sans profil éligible restant :
  `job_002` → WAITING_FOR_PROFILE.
- B8. Clic réel sur le bouton Éditeur via `[data-action="ui-toggleIdePanel"]`
  (vérifie la conversion en délégation globale, lot CSP) → panneau ouvert.
- B9. Monaco s'initialise sous CSP : `.monaco-editor` présent + `window.monaco`
  défini (workers via `blob:`).
- B10. Zéro violation CSP sur toute la phase B : listener `console-message`
  attaché à chaque webContents dès sa création, motifs « Content Security
  Policy » / « Refused to execute|load|create ».

Garde-fou : timeout global de 240 s (B9 peut attendre le chargement AMD de
Monaco).

## Contenu de `smoke-packaged.js`

1. Le binaire `dist/IAO-linux-x64/IAO` lancé sous xvfb
   (HOME et XDG_CONFIG_HOME isolés) reste vivant (pas de crash au boot).
2. `main.js` s'exécute : « Ordonnanceur démarré » journalisé (console et/ou
   `activity.json` du userData isolé).
3. Terminaison propre sur SIGTERM.

Variable d'environnement `SMOKE_APP_BINARY` (lot 5, 18/09/2026) : chemin d'un
binaire alternatif à tester — extraction AppImage (`./app.AppImage
--appimage-extract` puis `squashfs-root/iao`), `.deb` décompressé
(`dpkg-deb -x`), etc. Sans la variable, le build electron-packager
`dist/IAO-linux-x64/IAO` est utilisé.

## Pièges rencontrés (à lire avant de modifier le harnais)

- **Ne pas fermer la dernière fenêtre avant `require('../main.js')`** : sans
  handler `window-all-closed` enregistré, Electron quitte l'app quand toutes
  les fenêtres sont fermées (le harnais garderait une fenêtre fixture ouverte).
- **`app.setAppPath()` avant `require('../main.js')`** : le harnais étant le
  point d'entrée, la racine de l'app serait `test-electron/` et
  `win.loadFile('index.html')` échouerait (ERR_FILE_NOT_FOUND).
- **`module.require('electron')` dans le renderer, pas `require`** : après le
  chargement de la page, le loader AMD de Monaco REMPLACE le `require` de
  Node (« Synchronous require cannot resolve module 'electron' »).
- **`shell.openExternal` est stubbé** par le harnais pour qu'un lien web hors
  liste n'ouvre pas le vrai navigateur système pendant le test.
