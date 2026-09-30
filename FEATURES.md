# FEATURES.md — travaux à faire

Backlog de **IAO**. Une ligne = un lot livrable indépendamment. Convention : `\[ \]` à faire, `\[~\]` en cours, `\[x\]` fait (déplacer alors la ligne vers « Fait » en bas, et reporter le détail dans `docs/PROJECT\_CONTEXT.md`).

Priorités : **P0** bloquant / sécurité — **P1** important — **P2** confort — **P3** idée.


## P0 — Sécurité et fiabilité

- [ ] 



- [ ] 

- **Tester réellement les flux d'authentification des 9 services.** `ALLOWED\_POPUP\_HOSTS` (`main.js`) n'a jamais été validé en conditions réelles pour **Leonardo AI,** **Suno et Meshy AI**. Procédure : profil neuf, connexion complète sur chaque service, y compris les connexions tierces (Google, Discord pour Suno via Clerk, Apple, Microsoft, GitHub). Toute popup refusée apparaît dans la console avec son host → l'ajouter à la liste blanche.

- [ ] 

- **Tester `install.bat` sur une machine Windows réelle.** **Créé (lot 9), corrigé et validé statiquement (lot 10, 18/09/2026)** : `install.bat` implémente `/system` (admin), `/uninstall`, `/desktop`, `/no-desktop`, `/help`, `robocopy /MIR`, raccourcis via `WScript.Shell` (Bureau optionnel), auto-build si dist absent (`npm install` + `npm run dist:win`), chemins `%LOCALAPPDATA%\Programs\IAO` et `%ProgramFiles%\IAO`. Validation statique : parenthèses équilibrées, `^(` `^)` échappés dans echo, labels/goto cohérents, robocopy /MIR présent, VBScript structuré. 4 tests statiques dans `test/csp-static.test.js`. **Non testé sur machine Windows réelle** (développement sous Ubuntu, wine non disponible). À vérifier sur Windows : exécution réelle, auto-build, copie robocopy /MIR, raccourcis WScript.Shell, `/system` admin, `/uninstall` préserve `%APPDATA%\ai-manager`.

- [ ] 

- **Migrer vers `contextIsolation: true` + `preload` + IPC typée.** *(chantier lourd)* C'est la principale dette de sécurité : la page hôte a aujourd'hui un accès complet à Node/OS (`nodeIntegration: true`, `contextIsolation: false`). Étapes : écrire `preload.js` exposant une API minimale via `contextBridge` (`selectFolder`, `readDirectory`, `readFile`, `saveFile`), remplacer les appels `ipcRenderer` directs d'`index.html`, vérifier que Monaco se charge encore (chemin `node\_modules` calculé côté renderer → à passer par le preload ou par un protocole custom). À traiter **seul**, avec un build de vérification.

## P1 — Structure et maintenabilité

- [x] **Découper `index.html` + migrer les styles inline vers des classes CSS (lot 8 + lot 9, 18/09/2026).** CSS extrait vers `assets/app.css` (lot 8), chargé par `<link>` (sans bundler). `index.html` passe de 768 à 356 lignes. **Lot 9** : tous les attributs `style="..."` inline (50 dans index.html, + dans app.js) migrés vers des classes CSS utilitaires dans `assets/app.css`. Couleurs dynamiques via `data-*-color` + `applyDataColors()`. CSP conserve `style-src 'self' 'unsafe-inline'` car Monaco Editor crée des éléments avec `style="..."` en interne (limitation non contournable). Notre propre code n'utilise plus aucun style inline. Reste au backlog : séparer `app.js` en `accounts.js` / `tabs.js` / `editor.js` / `scheduler-ui.js`.

### Ordonnanceur IA — proposition externe intégrée au backlog (16/09/2026)

Objectif : détecter automatiquement les ZIP livrés par les services IA dans les onglets, et reprendre un projet inachevé en choisissant le profil le plus ancien plutôt que de sursolliciter toujours le même compte. Le **lot E (fondations)** est fait — voir « Fait » plus bas et `docs/PROJECT\_CONTEXT.md`. Reste à faire :

- [x] 

- **Fenêtre d'automatisation dédiée + moteur d'adaptateurs par service.** `createAutomationWindow(profile, service, job)` : ouvrir une fenêtre (visible seulement si « Afficher les automatisations » est coché), uploader le ZIP source via CDP (`webContents.debugger` → `DOM.getDocument` + `DOM.querySelector` + `DOM.setFileInputFiles` — un `\<input type="file"\>` ne peut PAS recevoir de fichier via un simple `executeJavaScript`, c'est une restriction navigateur volontaire), puis saisir/envoyer le prompt générique (`scheduler/core.js\#buildDeliveryPrompt`, déjà écrit et testé) via `executeJavaScript`. Nécessite un jeu de sélecteurs CSS **par service**, à valider un par un sur un compte de test réel — non réalisable dans l'environnement où ce backlog a été rédigé (pas d'affichage, pas d'accès réseau aux services IA). Squelette d'adaptateurs déjà esquissé en commentaire dans `scheduler/index.js`. **Socle implémenté (18/09/2026)** : lib/claude-adapter.js fournit les sélecteurs candidats, les scripts de détection/injection/upload/collecte, et la détection du message de quota. Seul Claude est supporté pour l'instant (point 10). Sélecteurs validés par recherche communautaire (18/09/2026) : sources dev.to, deepwiki.com, greasyfork.org, recurate.ai — ProseMirror contenteditable, data-testid="send-button", data-is-streaming, .font-claude-response confirmés. Non testés sur un compte connecté (pas d'accès réseau aux services IA depuis l'environnement de développement). **Automatisation câblée (18/09/2026)** : `_executeAutomation(job)` orchestre la séquence complète — transition RUNNING → détection → upload CDP → injection prompt → envoi → polling réponse (max 120s) → collecte → transition DELIVERED. `executeTask(projectId, taskId)` crée un job depuis une tâche et le lance. IPC `scheduler:execute-task`. Bouton « Lancer » dans l'UI pour les tâches assignées. Bouton « Résultat » pour visualiser la réponse collectée. 12 tests dans `test/scheduler-automation.test.js`.

- [x] 

- **UI « projets/tâches » avec restriction d'assignation aux comptes inactifs depuis 5h.** Demandé le 16/09/2026, **implémenté le 18/09/2026** : buildProjectRecord/buildTaskRecord/canAssignTaskToAccount dans scheduler/core.js (purs, testés), gestion CRUD dans scheduler/index.js, IPC dédiés, UI dans le panneau Ordonnanceur (index.html). L'assignation refuse les comptes non verts (rouge/bleu).

- [x]

- **Détection de complétude d'un projet.** Socle implémenté (18/09/2026) : `parseFeaturesMd`/`isProjectComplete` dans `scheduler/core.js` (testés), `Scheduler.analyzeCompleteness(jobId)` extrait le FEATURES.md du ZIP et compte les cases. IPC `scheduler:analyze-completeness` + bouton dans le panneau. **Détection automatique implémentée (18/09/2026)** : après un téléchargement réussi (`COMPLETED`), `_autoDetectCompleteness(job)` analyse automatiquement le FEATURES.md du ZIP. Si toutes les cases sont cochées (`[x]`, plus aucune `[ ]` ou `[~]`), le job passe en `DELIVERED` et le projet est marqué `completed`. Sinon, le job passe en `PROJECT_PENDING` avec l'analyse stockée. 9 tests dans `test/scheduler-completeness.test.js`. Aujourd'hui, après un téléchargement (`COMPLETED`), c'est l'utilisateur qui décide manuellement (« Continuer le projet » vs « Marquer livré ») depuis le panneau Ordonnanceur — volontairement pas d'heuristique auto-devinée (le risque de faux positif/négatif silencieux semblait pire que de demander une confirmation). Piste pour automatiser : ouvrir le ZIP livré, chercher un `FEATURES.md` interne et compter les cases `\[ \]` restantes.

- [x]

- **Respect de `minDelayBetweenAutomationsMinutes` et `maxConcurrentJobs`** (18/09/2026). Fonctions pures dans `scheduler/core.js` : `countRunningJobs`, `canLaunchJob`, `isMinDelayRespected`, `checkJobLaunchEligibility`, `selectNextJobToLaunch` — testées par `test/scheduler-rate-limiter.test.js` (21 tests). Intégration dans `scheduler/index.js` : `launchJob(jobId)` vérifie les contraintes, `tryAutoLaunch()` sélectionne le prochain job éligible (appelé après chaque `resumeJob`). IPC `scheduler:launch-job` et `scheduler:try-auto-launch`. **Application effective** : les contraintes sont vérifiées, le job passe en RUNNING, l'automatisation Claude est exécutée (voir section automatisation).

- [x] 

- **Poser un filet de tests sur les fonctions pures (16/09/2026)** — voir « Fait ».

## P2 — Confort d'usage

- [ ] **Étendre le harnais `test-electron/` aux autres flux UI.** Le socle est en place (lot du 18/09/2026 : `popups-continue.js` + `smoke-packaged.js`, fixtures locales, `npm run test:electron`). Prochaines cibles : restauration des onglets au démarrage (`restoreOpenTabs` — réclamée testée au lot 3 via `test-electron-tabs.js`, mais ce fichier n'a jamais été livré dans le zip), rendu du panneau comptes (`renderAccounts`), explorateur de fichiers + recherche, modales réglages. Pièges documentés dans `test-electron/README.md` (`module.require('electron')` dans le renderer, pas de fermeture de la dernière fenêtre avant `require('../main.js')`, `app.setAppPath()`).

- [ ] **Réorganiser les comptes par glisser-déposer**, et/ou les regrouper (« perso », « travail »).

- [x] **Panneau de réglages** (18/09/2026) — `lib/settings.js` (`normalizeSettings`, `normalizeEditorFontSize`, `normalizeTheme`, `normalizeWordWrap`, `normalizeBoolean`, `settingsChanged` — fonctions pures testées par `test/settings.test.js`, 20 tests). Persistance via IPC `settings:load`/`settings:save` dans `main.js` (`<userData>/settings.json`). UI : modal « Réglages » dans `index.html`. **Application effective** : thème (`data-theme` sur `<html>`, 3 thèmes : iao/light/dark), taille de police + retour à la ligne Monaco, confirmation avant fermeture d'onglet (modale dédiée), affichage des fenêtres d'automatisation (poussé vers config scheduler), restauration des onglets au démarrage (persistance localStorage).

## P3 — Distribution

- [x] **Réduire la taille des paquets electron-builder (.deb/AppImage).** Les motifs d'exclusion de `dist`/`dist:linux` (electron-packager) sont désormais reproduits dans `build.files` (electron-builder) : `monaco-editor/dev`, `esm/`, `min-maps/`, traductions `nls` spécifiques à une langue (le `editor.main.nls.js` de base est conservé), `CHANGELOG`/`ThirdPartyNotices`/`README`. Vérifié (lot 8, 18/09/2026) : le .deb passe de 116 Mo à 100 Mo (−14 %), l'AppImage de 147 Mo à 127 Mo (−14 %), les dossiers exclus sont absents de l'asar, Monaco fonctionne toujours (fumée 3/3 + tests Electron 14/14 dont Monaco sous CSP).


- [ ] **Signer les binaires.** Windows : certificat de signature de code (supprime l'avertissement SmartScreen). Linux : dépôt APT signé, ou au minimum publication des sommes SHA-256 à côté des releases.

- [ ] **Publier les builds via GitHub Releases** avec un fichier de sommes de contrôle, plutôt qu'un zip transmis à la main.

- [ ] **Chiffrement au repos des sessions et des métadonnées** (`safeStorage` / DPAPI côté Windows). *Décision en pause côté utilisateur* : documenté comme limite assumée dans le README (« une session utilisateur = une personne »).


## Fait

- **Thème clair : barre latérale, en-tête et onglets lisibles (suite #139, 30/09/2026)**
  Ces trois panneaux gardaient un fond sombre codé en dur (`rgba(11, 8, 23, …)`). En thème
  clair, devenu le rendu par défaut pour un bureau clair depuis #139, le nom du compte actif
  s'affichait en sombre sur fond sombre. Ajout de `--bg-panel` et `--bg-panel-soft` dans
  chaque thème ; le rendu IAO ne change pas. +3 tests (`test/theme-panels.test.js`).

- **Puce de statut déplacée sur chaque bouton d'IA (issue #137, 30/09/2026)**
  La puce bleu/rouge/vert quitte l'avatar du compte et se place dans le coin de chaque
  bouton d'IA : 9 puces par compte, une par couple (compte, service). Règles inchangées
  (bleu = onglet ouvert, rouge = ouvert il y a moins de 5h, vert sinon), calculées par
  `getServiceActivityStatus()` (`lib/activity-status.js`). `openService()` trace
  `acc.automation.lastUsedBySvc[svcId]` en plus de `lastUsedAt` : l'ordonnanceur garde
  l'horodatage par compte. Tests : `test/activity-status.test.js` (+5).

- **Thème du bureau (issue #139, 30/09/2026)**
  Nouveau thème `system` (défaut des nouveaux réglages) : l'app suit le thème clair ou sombre
  du bureau (`prefers-color-scheme`, relayé par Electron `nativeTheme`) et bascule en direct
  quand le bureau change. `resolveTheme()` pure dans `lib/settings.js`. Les réglages déjà
  enregistrés (`iao`, `light`, `dark`) sont conservés. Tests : `test/theme-system.test.js`.

- **Clic sur l'e-mail d'un compte : copie dans le presse-papiers (issue #138, 30/09/2026)**
  `lib/copy-text.js` (clipboard API, repli `execCommand('copy')`), action `copy-email`
  sur l'e-mail de chaque carte (curseur « copie », soulignement au survol), toast de
  confirmation. Tests : `test/copy-text.test.js` (7 tests).

- **Retrait du bouton « Épuiser (24h) » (issue #136, 30/09/2026)**
  Le bouton sous chaque service des cartes de compte est supprimé, avec son action
  `toggle-cooldown`, `toggleCooldown`, `formatCooldown`, `refreshCooldownLabels` et le CSS
  `.cooldown-btn`. Les cooldowns déjà enregistrés restent estompés puis expirent
  normalement (tick 1 s inchangé). Test statique : `test/cooldown-button-removed.test.js`.

- **CI : seuil de couverture bloquant (issue #101, 30/09/2026)**
  `test:coverage` : lignes 100 %, branches 97 %, fonctions 98 % (planchers sous la mesure
  98,00 % / 98,46 %, 100 % inatteignable, voir CLAUDE.md § 10 bis). `test/coverage-inventory.test.js`
  charge chaque module pur pour qu'un test supprimé fasse échouer le seuil. Vérifié : sans
  `test/file-search.test.js` ou `test/main-harness.test.js`, le seuil échoue.

- **Dossier temporaire unique pour l'analyse de ZIP sous Windows (30/09/2026)**
  `analyzeCompleteness` (stratégie PowerShell) utilisait `'iao-zip-' + Date.now()` : deux
  analyses dans la même milliseconde partageaient le dossier, et un `FEATURES.md` resté
  d'un nettoyage raté était relu à tort (test intermittent « archive sans FEATURES.md »).
  Passage à `fs.mkdtempSync`, et nettoyage même quand PowerShell échoue. +2 tests.

- **CI : les tests en échec ne passent plus en vert (30/09/2026)**
  `ci.yml` exécutait `npm run test:coverage | tee` sans `pipefail` : le code de sortie
  était celui de `tee`, et un test en échec (`csvEscape gère null et undefined`,
  introduit par #130) est passé inaperçu. Ajout de `set -o pipefail` et correction
  de l'assertion (`started_at` est toujours renseigné par `buildJobRecord`).

- **Validation Windows install.bat + corrections (18/09/2026, 20:38)**
  Lot 10. Corrections suite à validation statique :
  1. **install.bat corrigé** : auto-build si `dist\IAO-win32-x64` absent (`npm install` + `npm run dist:win`), parenthèses échappées `^(` `^)` dans echo, logique `/desktop` cohérente (Bureau optionnel, pas par défaut), `/no-desktop` ajouté, `DESKTOP_SHORTCUT` désormais utilisé.
  2. **Attributs `class` dupliqués** : 9 occurrences dans `index.html` et 5 dans `app.js` fusionnées (ex: `class="btn" class="btn--danger"` → `class="btn btn--danger"`). Nouveau test statique détectant les doublons sur un même élément HTML.
  3. **Validation statique install.bat** : script Python vérifiant parenthèses équilibrées, caractères spéciaux échappés, labels/goto cohérents, robocopy /MIR, structure VBScript.
  4 nouveaux tests statiques. Total : 332 tests unitaires + 14 Electron + 3 fumée, 0 échec.

- **Migration styles inline vers classes CSS + install.bat (18/09/2026, 20:20)**
  Lot 9. Trois items livrés :
  1. **P1 — Migrer les attributs `style="..."` inline vers des classes CSS** : tous les attributs `style="..."` de `index.html` (50 occurrences) et de `assets/app.js` (templates + `cssText`) sont migrés vers des classes CSS utilitaires et sémantiques dans `assets/app.css` (`.btn--danger`, `.settings-body`, `.sched-section-label`, `.explorer-header`, `.modal--confirm`, etc.). Les couleurs dynamiques utilisent `data-*-color` + `applyDataColors()` (propriétés `.style.background`/`.style.color` non bloquées par CSP). La CSP conserve `style-src 'self' 'unsafe-inline'` car Monaco Editor crée des éléments avec `style="..."` en interne (limitation connue, non contournable sans patcher Monaco). Notre propre code n'utilise plus aucun style inline.
  2. **P0 — Créer `install.bat`** : installeur Windows basé sur `install.sh`. Options `/system` (admin), `/uninstall`, `/desktop`, `/help`. `robocopy /MIR` pour la copie, raccourcis via `WScript.Shell` (Bureau + Menu Démarrer), chemins `%LOCALAPPDATA%\Programs\IAO` (user) et `%ProgramFiles%\IAO` (system). La désinstallation préserve `%APPDATA%\ai-manager`. Non testé sur machine Windows réelle (P0 reste ouvert).
  3. **Tests** : 6 nouveaux tests statiques dans `test/csp-static.test.js` (absence de `style=` dans index.html, absence de `cssText` dans app.js, présence de `applyDataColors`, présence des classes utilitaires, existence et contenu de `install.bat`).
  Vérifié : 330 tests unitaires + 14 tests Electron + 3 fumée, 0 échec.

- **Extraction CSS + réduction de la taille des paquets (18/09/2026, 20:10)**
  Lot 8, voir `CHANGES.md`. Deux items du backlog livrés :
  1. **P1 — Découper `index.html`** : le bloc `<style>` (421 lignes) est extrait
     vers `assets/app.css`, chargé par `<link rel="stylesheet">`. Les chemins des
     polices ont été ajustés (`url("fonts/...")` car la feuille réside dans
     `assets/`). `index.html` passe de 768 à 356 lignes. La CSP conserve
     `style-src 'self' 'unsafe-inline'` car de nombreux attributs `style="..."`
     inline restent dans le HTML (migration vers des classes CSS au backlog).
     7 nouveaux tests dans `test/csp-static.test.js`.
  2. **P3 — Réduire la taille des paquets electron-builder** : les motifs
     d'exclusion de Monaco (`dev`, `esm`, `min-maps`, `nls` par langue) sont
     ajoutés à `build.files` dans `package.json`. Le .deb passe de 116 Mo à
     100 Mo (−14 %), l'AppImage de 147 Mo à 127 Mo (−14 %). Vérifié : asar sans les dossiers exclus, `editor.main.nls.js`
     de base conservé, Monaco fonctionne (tests Electron 14/14 + fumée 3/3).
  Vérifié : 324 tests unitaires + 14 tests Electron + 3 fumée, 0 échec.

- **Renommage complet du projet en IAO (18/09/2026, 19:40)**
  Lot 7, voir `CHANGES.md`. Toute trace de l'ancienne marque est retirée du
  code, des tests, des fixtures, des docs et de l'historique (grep : 0
  occurrence ; recherche binaire dans l'asar packagé : 0). Identité produit
  IAO (fenêtre, .desktop, binaires, deb `iao`, AppImage), homepage
  `https://github.com/MathildeDec/IAO`, thème par défaut renommé `iao`
  (rendu inchangé), dossier de données utilisateur `ai-manager` conservé
  (compatibilité comptes/sessions). Vérifié : 317/317 unitaires, 14/14
  Electron, builds packager + deb + AppImage reconstruits, fumée 3/3.

- **CSP stricte sur `index.html` + extraction du JS inline (18/09/2026, 18:05)**
  Item P0 n°2 du backlog (lot 6, voir `CHANGES.md`). `index.html` passe de
  2 723 à 768 lignes : les deux blocs `<script>` inline sont extraits vers
  `assets/pre-monaco.js` (sauvegarde du `require` d'Electron avant que le
  loader AMD de Monaco ne le remplace) et `assets/app.js` (toute l'app) ;
  les 27 gestionnaires inline (`onclick`/`oninput`, + 1 `onerror` retiré)
  deviennent des `data-action="ui-*"`/`data-input-action` résolus par une
  délégation globale en fin d'`app.js` (tables `UI_ACTIONS`/`INPUT_ACTIONS`,
  résolution `window[name]()` au clic ; la délégation `sched-*` existante
  est inchangée). CSP posée : `default-src 'none'; script-src 'self';
  worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; font-src
  'self'; img-src 'self' data:` — `worker-src blob:` est l'écart assumé
  vs la prescription backlog : Monaco crée ses workers via des URL `blob:`,
  les bloquer le fait replier en thread principal. Vérifié : 317/317 tests
  unitaires (dont `test/csp-static.test.js` : CSP exacte, zéro script/handler
  inline, ordre des balises, cohérence bidirectionnelle data-action ↔
  UI_ACTIONS), harnais Electron 14/14 (B8 clic réel délégué, B9 Monaco
  initialisé sous CSP, B10 zéro violation CSP sur toute la phase B),
  build packagé recompilé + asar contenant `app.js`/`pre-monaco.js` + fumée
  3/3 sans message « Refused ». Limite : le panneau
  Éditeur/Monaco n'est pas ouvert par le smoke du build packagé (boot + arrêt
  seulement) ; Monaco sous CSP est vérifié en dev (harnais) uniquement.

- [x]

- **Mise à jour de la chaîne de build : electron-builder 24 → 26.15.3 (18/09/2026, 17:05)**
  Premier item P0 du backlog (lot 5, voir `CHANGES.md`). `npm audit` : 8
  vulnérabilités (7 hautes, 1 critique — `tar` traversée de chemin,
  `app-builder-lib`/`builder-util-runtime` fuite d'en-têtes `Authorization`)
  → **0 vulnérabilité** (`npm audit` et `npm audit --omit=dev`) après passage
  à `electron-builder@^26.15.3` (`tar` 7.5.22). `electron` et
  `@electron/packager` inchangés. Changements cassants v26 corrigés (config
  uniquement) : `homepage` + mainteneur requis pour le `.deb` (ajoutés :
  `https://iao.ovh`, `X'o-noth <deusyv@gmail.com>` — modifiable dans
  `package.json`) ; `productFilename` sans crochets pour l'AppImage →
  `build.productName = "IAO"` (dossier d'installation `.deb`
  `/opt/IAO`, nom affiché « IAO » conservé via
  l'override `.desktop`, `StartupWMClass` inchangé, builds electron-packager
  non affectés). Vérifié en réel : `.deb` 116 Mo + AppImage 147 Mo
  construits, asar sans `test/`/`docs/`/`installer/`, Monaco `asarUnpack`é,
  fumée du binaire AppImage extrait 3/3 (nouvelle variable
  `SMOKE_APP_BINARY` du harnais), electron-packager 284 Mo + fumée 3/3,
  306 tests unitaires + 11 tests d'intégration, 0 échec. Non testé :
  installation `dpkg -i` du `.deb` (pas de root), montage FUSE direct de
  l'AppImage, build Windows.

- **Test réel du zip livré + harnais d'intégration Electron (18/09/2026, 16:06)**
  Lot « teste le zip livré avec un build Electron local complet » (lot 4, voir
  `CHANGES.md`). Le zip `iao-20260918-120801.zip` a été testé tel que
  livré : `npm install`, `npm test`, `npm run dist:linux` (electron-packager,
  284 Mo) et lancement du binaire packagé sous xvfb. **Deux défauts réels
  découverts et corrigés** :

  1. `npm test` échouait (3 tests) et ne terminait jamais entre 15h00 et
     20h30 Paris (heures calmes) : le « 303 tests, 0 échecs » du lot 3 ne
     tenait qu'hors pause parisienne. Correction : décision d'heures calmes
     injectable dans le scheduler (`quietHoursCheck`/`quietHoursRemainingMs`)
     + `setTimeout` de report `unref()` + 2 nouveaux tests couvrant le
     comportement en pause.
  2. Sur Electron 43, `guestContents.getWebPreferences()` renvoie
     `undefined` pour un guest : l'enregistrement des webviews auprès du
     scheduler échouait silencieusement → toute l'automatisation Claude était
     inopérante (« Aucune webview ouverte »). Correction :
     `Scheduler.resolveProfileFromSession()` (comparaison de session) + test
     unitaire + test réel.

  **Nouveau harnais `test-electron/`** (fixtures locales uniquement, aucun
  accès réseau aux services IA) : `popups-continue.js` — 11 tests d'intégration
  des popups et du bouton « Continuer » (adaptateur sur fixture Claude mock
  dans un vrai Chromium ; application réelle main.js + index.html : popups
  hôte/guest refusées, navigation bloquée, webview enregistrée, « Continuer le
  projet » COMPLETED→RESUME_REQUIRED / →WAITING_FOR_PROFILE) ;
  `smoke-packaged.js` — fumée du binaire packagé (3 tests). Script npm
  `test:electron`. État final vérifié en réel : **306 tests unitaires + 11
  tests d'intégration + 3 tests de fumée, 0 échec**, dont l'exécution PENDANT
  les heures calmes parisiennes.

- [x]

- **Limiteur de lancement + panneau de réglages (18/09/2026)**
  Deux features livrées dans ce lot :

  1. **Respect de `minDelayBetweenAutomationsMinutes` et `maxConcurrentJobs`** (P1, `[x]`) :
     Fonctions pures dans `scheduler/core.js` : `countRunningJobs`, `canLaunchJob`,
     `isMinDelayRespected`, `checkJobLaunchEligibility`, `selectNextJobToLaunch`
     (alias : `getRunningJobsCount`, `isMaxConcurrentReached`, `selectEligibleJobForLaunch`)
     — testées par `test/scheduler-rate-limiter.test.js` (21 tests). Intégration dans
     `scheduler/index.js` : `launchJob(jobId)` vérifie les contraintes et lance l'automatisation,
     `tryAutoLaunch()` sélectionne le prochain job éligible et l'exécute (appelé après chaque
     `resumeJob`). IPC `scheduler:launch-job` et `scheduler:try-auto-launch`. **Application
     effective** : les contraintes sont vérifiées, le job passe en RUNNING, `runClaudeJob` est
     appelé (détection → upload CDP → injection prompt → envoi), la réponse est collectée par
     polling, la tâche associée passe à `completed`, le job passe à `DELIVERED`.

  2. **Panneau de réglages** (P2, `[x]`) : `lib/settings.js` (`normalizeSettings`,
     `normalizeEditorFontSize`, `normalizeTheme`, `normalizeWordWrap`,
     `normalizeBoolean`, `settingsChanged` — fonctions pures testées par
     `test/settings.test.js`, 20 tests). Persistance via IPC `settings:load`/
     `settings:save` dans `main.js` (`<userData>/settings.json`). UI : modal
     « Réglages » dans `index.html`. **Application effective** : thème
     (`data-theme` sur `<html>`, 3 thèmes : iao/light/dark), taille de
     police + retour à la ligne Monaco, confirmation avant fermeture d'onglet
     (modale dédiée), affichage des fenêtres d'automatisation (poussé vers config
     scheduler), restauration des onglets au démarrage (persistance localStorage).

  `npm test` passe à **241 tests** (172 + 12 automation).

- [x]

- **Recherche dans l'explorateur de fichiers + sous-dossiers (18/09/2026)**
  `lib/file-search.js` (`filterFiles`, `flattenFileTree` — fonctions pures testées par
  `test/file-search.test.js`, 8 tests) + nouveau handler IPC `read-directory-recursive`
  dans `main.js` (lecture récursive avec garde-fous : profondeur max 5, 500 fichiers max,
  dossiers ignorés, pas de liens symboliques) + champ de recherche `<input>` dans
  l'explorateur (`index.html`) avec affichage du chemin relatif des fichiers issus de
  sous-dossiers. Le rendu passe par `renderFileList()` (échappé, délégation d'événements
  inchangée). `npm test` passe à **88 tests** (61 + 8 + 8 + 3 + 8).

- [x]

- **Notification de fin de cooldown + onglet clignotant (18/09/2026)**
  `lib/cooldown-notify.js` (`cooldownKey`, `getNewlyExpiredCooldowns`,
  `snapshotActiveCooldowns` — fonctions pures testées par `test/cooldown-notify.test.js`,
  8 tests). Intégration dans le tick cooldown existant d'`index.html` : comparaison
  tick-à-tick du snapshot des cooldowns actifs pour détecter les transitions
  actif→expiré, puis (1) `new Notification()` navigateur si la permission a été accordée
  (demandée paresseusement au premier `toggleCooldown` — retiré par l'issue #136), (2) toast de confirmation,
  (3) classe CSS `tab--flash` (animation `@keyframes tab-flash`) posée sur l'onglet
  du couple (compte, service) concerné s'il est ouvert — l'animation s'arrête dès que
  l'onglet devient actif (`renderTabsBar()` reconstruit le DOM). Anti-double-notification
  via un `Set` de clés déjà notifiées. CSS utilise `--rose` (thème IAO). Non testé
  en conditions réelles (pas d'affichage dans l'environnement où ce lot a été écrit).

- [x]

- **Détection de complétude d'un projet — socle (18/09/2026)**
  `parseFeaturesMd(content)` et `isProjectComplete(content)` ajoutées à
  `scheduler/core.js` (logique pure, testée par `test/features-parser.test.js`, 11 tests).
  Parse un contenu Markdown de type FEATURES.md, compte les cases `[ ]`/`[x]`/`[~]`
  (ignore les blocs de code), renvoie `{ done, inProgress, pending, total }`.
  `isProjectComplete` renvoie `true` seulement si `total > 0` et plus aucune case
  `[ ]`/`[~]` restante (prudence : un FEATURES.md sans case n'est pas considéré comme
  terminé). Intégration dans l'ordonnanceur : `Scheduler.analyzeCompleteness(jobId)`
  (`scheduler/index.js`) extrait le FEATURES.md du ZIP livré via `unzip` (Linux/Mac)
  ou PowerShell `Expand-Archive` (Windows) — pas de nouvelle dépendance npm (invariant 7) —
  et renvoie le décompte. IPC `scheduler:analyze-completeness` + bouton « Analyser la
  complétude » dans le panneau Ordonnanceur (`index.html`), résultat affiché en toast.
  **Pas encore une décision automatique** : l'utilisateur garde la main (« Continuer le
  projet » vs « Marquer livré ») — voir l'entrée `[~]` correspondante dans P1 ci-dessus.

- [x] 

- **Doubler la taille de la puce de statut d'activité sur l'avatar (17/09/2026)** `.status-dot` (`index.html`) : 11px → **22px**, bordure 2px → 3px (proportionnelle), décalage `right`/`bottom` ajusté de -1px à -2px pour rester bien calée sur le bord de l'avatar 40px. Purement cosmétique — comportement/couleurs (`lib/activity-status.js`) inchangés.

- [x] 

- **Actions sur un onglet ouvert : recharger, accueil du service, déconnexion du profil (17/09/2026)** Barre d'actions (3 boutons icône) ajoutée en haut de chaque `\<webview\>` ouverte (`.tab-toolbar`, `index.html`, fonction `openService()`), avec délégation d'événements sur `\#tabsContent` (même conteneur stable que le reste de l'app) :

  - **Recharger** — `webview.reload()`.

  - **Accueil du service** — `webview.loadURL(svc.url)` (l'URL déjà déclarée dans `SERVICES`, pas de nouvelle donnée).

  - **Déconnexion du profil** — purge la partition Electron du compte via un nouvel IPC `accounts:disconnect-profile` (`main.js`, `session.fromPartition('persist:\<profil\>').clearStorageData()` — `session` n'existe que côté process principal). **Modale de confirmation obligatoire** (`\#disconnectModal`, calquée sur `\#deleteModal`) : un profil est partagé par *tous* les onglets ouverts du même compte (invariant 4 — un profil = un seul compte), donc la déconnexion recharge tous ces onglets, pas seulement celui d'où l'action a été lancée ; le message de confirmation l'annonce avec le bon accord singulier/pluriel.

  - Deux fonctions pures nouvelles dans `lib/tab-actions.js` (invariant 11) : `tabsForAccount(tabs, accId)` (onglets d'un compte, réutilisée pour le décompte affiché *et* pour la boucle de rechargement après déconnexion) et `buildDisconnectWarning(opts)` (texte de la modale, accord singulier/pluriel testé).

    - `test/tab-actions.test.js` (9 tests).

  - 3 icônes ajoutées à `window.IAO\_ICONS` : `arrow-rotate-right`, `house`, `right-from-bracket` (Font Awesome Free 6.5.1, CC BY 4.0, même source que les icônes existantes).

  - **Non testé** : comme pour le lot import/export du même jour, aucun affichage dans l'environnement où ce lot a été écrit — `webview.reload()`/`loadURL()` et l'appel IPC de purge de partition n'ont pas pu être exercés en conditions réelles. À vérifier via `npm start` avant diffusion, en particulier que la déconnexion redirige bien vers l'écran de connexion du service.

  - `npm test` passe désormais à **61 tests** (49 + 3 + 9, voir aussi l'entrée correctif ci-dessous).

- [x] 

- **Correctif critique — `assets/icons.js` corrompu, cassait tout le fichier (17/09/2026)** Trouvé en préparant le lot ci-dessus (les 3 nouvelles icônes auraient sinon été ajoutées à un fichier déjà cassé). L'entrée `circle-question` avait son chemin SVG tronqué et jamais refermé — la définition suivante (`file-export`) s'enchaînait directement dans la valeur de `"p"`, ce qui rendait **tout `assets/icons.js` syntaxiquement invalide** (`SyntaxError: Unexpected identifier 'file'`). Conséquence en conditions réelles : le `\<script src="assets/icons.js"\>` (chargé en tout premier, avant même `lib/escape-html.js`) aurait échoué silencieusement en entier — ni `window.IAO\_ICONS` ni `window.hydrateIcons` n'auraient jamais existé, donc plus aucune icône nulle part dans l'app (le stub no-op de `hydrateIcons` documenté dans `docs/PROJECT\_CONTEXT.md` §11 protège contre un fichier *absent*, pas contre un fichier présent mais syntaxiquement invalide). Préexistant dans le zip fourni en entrée de ce lot ; origine exacte inconnue (probablement une troncature lors d'une édition ou d'un export antérieur) — jamais détecté car aucun test ne validait ce fichier et aucun des environnements où les lots précédents ont été écrits n'a d'affichage pour le remarquer au lancement. Chemin restauré à l'identique de la version officielle Font Awesome 6.5.1 (CC BY 4.0, même source que les autres icônes du projet). **Nouveau filet** : `test/icons.test.js` (3 tests) charge désormais `assets/icons.js` dans un bac à sable Node (`vm`, sans navigateur) à chaque `npm test`, et vérifie que chaque icône déclarée a un `vb`/`p` valides — pour que ce genre de corruption soit détecté immédiatement la prochaine fois, sans attendre un lancement réel de l'app.

- [x] 

- **Brancher l'UI d'import/export JSON des comptes (17/09/2026)** `exportAccountsJSON()`/`importAccountsJSON(text)` existaient déjà (chantier C) — seule l'UI manquait. Deux boutons ajoutés dans l'en-tête « Comptes enregistrés » (`index.html`, icônes `file-export`/`file-import` nouvellement ajoutées à `window.IAO\_ICONS`). `main.js` expose deux handlers IPC dédiés, `accounts:export` (`dialog.showSaveDialog`, nom de fichier horodaté `iao-comptes-\<horodatage\>.json`) et `accounts:import` (`dialog.showOpenDialog`, filtre `.json`) — seul le process principal a accès au système de fichiers, comme pour `read-file`/`save-file`. L'import affiche une **modale de confirmation explicite** (`\#importConfirmModal`, calquée sur `\#deleteModal`) annonçant le nombre de comptes lus dans le fichier avant d'écraser la liste actuelle ; le JSON est validé (`JSON.parse` + vérification de tableau) avant d'afficher cette modale, pour ne jamais proposer de confirmer un import qui échouerait de toute façon. Écriture exclusivement via `saveAccounts()` (`importAccountsJSON()` l'appelle déjà). Aucune fonction pure nouvelle : pas de nouveau fichier de test (cohérent avec `CLAUDE.md` §1 — rien d'automatisé sur le DOM/UI ni sur `main.js`). **Non testé** : le sélecteur de fichier natif (`dialog.showSaveDialog`/`showOpenDialog`) n'a pas pu être exercé dans l'environnement où ce lot a été écrit (pas d'affichage) ; à vérifier en dev (`npm start`) avant diffusion.

- [x] 

- **Onglets et liste de comptes : titre/sous-titre, tri, statuts, glisser-déposer (16/09/2026)** — lot demandé le 16/09/2026, en partie seulement . Réalisé :

  - `renderTabsBar()` : titre/sous-titre de l'onglet inversés — le **nom du compte** occupe désormais `.tab\_\_label` (1re ligne, `font-weight` passé à 700 pour un gras net) et le nom du service `.tab\_\_acc` (2e ligne, petite, atténuée) ; l'attribut `title` (info-bulle) suit le même ordre (« Compte — Service »).

  - Onglets réorganisables par **glisser-déposer** (HTML5 DnD natif, délégué sur `\#tabsBar`, aucune dépendance ajoutée) — ne fait que réordonner `tabs\[\]`.

  - Liste de comptes triée **alphanumériquement** pour l'affichage (`compareAccountNames`, tri "Compte 2" avant "Compte 10") ; `accounts\[\]` garde son ordre de stockage, seule la copie affichée est triée.

  - **Badge de statut** sur l'avatar de chaque compte : bleu si un onglet de ce compte est ouvert, rouge si utilisé manuellement il y a moins de 5h, vert au-delà (ou jamais ouvert) — basé sur `acc.automation.lastUsedAt` (déjà tracé par `openService()`), purement informatif.

  - Onglet teinté (ambre) après **5 min sans avoir été au premier plan** (`lastFocusAt`, mis à jour par `activateTab()`) — rappel visuel local, ne lit rien dans la `\<webview\>`.

  - Nouveau `lib/activity-status.js` (`compareAccountNames`, `getAccountActivityStatus`, `isTabIdle`)

    - `test/activity-status.test.js` (14 tests, invariant 11) — `npm test` passe désormais **49 tests** (35 + 14). `refreshAccountStatusDots()`/`refreshTabIdleClasses()` suivent le modèle de `refreshCooldownLabels()` (mise à jour ciblée, même cadence 1×/min, pas de re-render complet).


- [x] 

- **Lot E — Ordonnanceur IA : fondations (16/09/2026)** — proposition externe intégrée au backlog puis implémentée : `scheduler/core.js` (logique pure — machine à états des jobs, sélection du profil le plus ancien `\> profileAgeThresholdHours`, sérialisation CSV, prompt générique horodaté, détection du service par nom d'hôte ; 100 % couvert par `node --test`) et `scheduler/index.js` (orchestration Electron — registre de jobs persistant en JSON + export CSV dans `\<userData\>/scheduler/`, détection automatique des téléchargements `.zip` sur chaque partition de profil via `session.fromPartition(...).on('will-download', ...)`, cycle de vie manuel d'un job piloté depuis un nouveau panneau « Ordonnanceur IA » — continuer le projet / mettre en pause / reprendre / relancer / marquer livré / ouvrir le ZIP —, journal d'activité persistant). Chaque compte porte désormais un champ `automation: \{ enabled, lastUsedAt, lastAutomationAt \}` (`migrateOldAccounts()`), mis à jour à l'ouverture manuelle d'un service et synchronisé vers `main.js` à chaque `saveAccounts()`. 

- [x] 

- **Poser un filet de tests sur les fonctions pures (16/09/2026)** — `escapeHtml` (`lib/escape-html.js`) et `isAllowedPopup`/`ALLOWED\_POPUP\_HOSTS` (`lib/popup-guard.js`) extraits d'`index.html` et `main.js` vers des modules dédiés sans dépendance à Electron, requis à l'identique par l'app (`\<script src\>` / `require`) et par `test/pure.test.js`. `npm test` (`node --test`) exécute 35 tests au total avec `test/scheduler-core.test.js`.

- [x] 

- **`install.sh` : détection de `node\_modules` manquant (16/09/2026)** — le zip distribué ne contient jamais `node\_modules/` ; sans `npm install` préalable, `npm run dist:linux` échouait avec un `electron-packager: not found` peu clair. Le script installe désormais les dépendances tout seul via `npm install` (jamais en root — message explicite si lancé avec `sudo ./install.sh --system` sans build existant) avant de lancer le build.

- [x] 

- **Réorganisation du dépôt (16/09/2026)** — `install.sh` remonté à la racine (chemins et messages adaptés, `--help` rendu robuste), documentation interne regroupée dans `docs/`, ajout de `CLAUDE.md` et de ce fichier, exclusions de packaging mises à jour dans `package.json` (`docs/`, `install.sh`, `CLAUDE.md`, `FEATURES.md`) et clé `build.files` ajoutée pour `electron-builder`.

- [x] 

- **Installeur Windows `install.bat` (16/09/2026)** — pendant de `install.sh` : copie du build packagé dans `%LOCALAPPDATA%\\Programs` ou `%ProgramFiles%` avec `/system`, raccourcis menu Démarrer et Bureau, `/uninstall`, construction automatique si `dist\\` est vide, données `%APPDATA%\\ai-manager` jamais touchées. **Non testé sur une machine Windows** — voir P0.

- [x] 

- **Lot A** — échappement HTML (`escapeHtml`) + délégation d'événements partout.

- [x] 

- **Lot B** — durcissement navigation/popups dans `main.js` (`will-navigate`, `setWindowOpenHandler`, liste blanche `ALLOWED\_POPUP\_HOSTS`).

- [x] 

- **Lot C** — résilience des données : `readJSON`, backup `ai\_accounts\_backup`, modale de récupération.

- [x] 

- **Lot D** — polices et icônes 100 % locales, plus aucun CDN.

- [x] 

- **UI** — bouton « Ajouter un compte », état vide « Créer mon premier compte », vue compacte (repli/dépli des cartes), page d'aide « Comprendre les IA disponibles ».

- [x] 

- **Performance** — chargement paresseux de Monaco, `refreshCooldownLabels()` au lieu d'un re-render complet, purge des locales Chromium et des `nls` Monaco au build.

- [x] 

- **Ajouts de services** — Leonardo AI, Suno, Meshy AI (7 → 9).

- [x] 

- **Intégration bureau Linux** — `install.sh`, icônes hicolor, `.desktop` avec `StartupWMClass`, repli automatique `--no-sandbox` en installation utilisateur.



- [x]

- **Lot 3 — Scheduler câblé, heures calmes, test Electron (18/09/2026)**
  Trois livrables dans ce lot :

  1. **Câblage de `planClaudeAutomationStep()` dans le scheduler** : `runClaudeJob()`
     utilise désormais la fonction d'orchestration pour décider de l'action après détection
     (priorité : quota > popups > action demandée). Fermeture automatique des popups, délai
     anti-détection configurable (`config.minDelayMs` / `config.maxDelayMs`).

  2. **Heures calmes (pause 15h-20h30 Paris)** : `isFrenchQuietHours()` et
     `quietHoursRemainingMs()` dans `scheduler/core.js` (fonctions pures, gèrent DST).
     Intégration dans `_executeAutomation()` (report du job) et `runClaudeJob()` (retour
     `quiet_hours`). 15 tests dans `test/quiet-hours.test.js`.

  3. **Test Electron de restauration des onglets** : test réel avec Electron v43.7.2
     et xvfb. Validation de `serializeOpenTabs`/`deserializeOpenTabs` (lib/settings.js),
     sauvegarde localStorage, scheduler instancié, handler `did-attach-webview` câblé.
     303 tests au total, 0 échecs.
