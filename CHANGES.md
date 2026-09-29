# Rapport de modifications — IAO (18/09/2026)

## Correctif #52 — Démarrage : interface vide, sans icône ni diagnostic (29/09/2026)

### Cause
Depuis la migration `contextIsolation: true` (#4, PR #44), `preload.js` est **sandboxé**
(défaut Electron ≥ 20 avec `nodeIntegration: false`). Son `require('path')` levait
« module not found: path » : le preload ne s'exécutait pas, `window.iaoAPI` restait
`undefined` et `assets/app.js` plantait dès la ligne 82 (`Cannot read properties of
undefined (reading 'ipcInvoke')`). Résultat : 0 compte, 0 IA, boutons sans icône, et
aucune ligne utile dans le terminal. Reproduit en réel sous Xvfb (Electron 43.7.2).
Le harnais Electron le signalait (`NOT OK - B1`) mais il est non bloquant en CI.

### Correctifs
- `preload.js` : n'utilise plus que `electron` ; `resolveMonacoBase()` calcule l'URL
  `file://` de Monaco avec l'API `URL` standard (valable Linux, Windows et `app.asar`).
- `assets/boot-guard.js` + `lib/startup-diagnostics.js` (pur, testé) : toute erreur ou
  promesse rejetée au démarrage affiche un **bandeau visible avec icône d'alerte**, le
  détail et une piste ; `app.js` signale explicitement un preload absent.
- `main.js` : journal horodaté terminal + `<userData>/logs/iao.log` (tourné à 1 Mo) :
  version, plateforme, dossier de données, `preload-error`, `did-fail-load`,
  `render-process-gone`, fenêtre figée, warnings/erreurs de la console du renderer
  (tout en `--debug` / `IAO_DEBUG=1`), arrêt d'un onglet webview.
- `main.js` : **instance unique** (`requestSingleInstanceLock`) — une 2e instance ramène
  la fenêtre existante au premier plan au lieu de se disputer le dossier de données
  (probable origine des rafales `Failed to delete the database: Database IO error`).

### Tests
- `test/preload-sandbox.test.js` : exécute `preload.js` avec un `require` limité aux
  modules du sandbox (échoue sur l'ancien preload : 4 tests KO).
- `test/startup-diagnostics.test.js` : fonctions pures + branchements statiques.
- `npm test` : 348/348. Harnais `npm run test:electron` : 14/14 (échouait avant).

## Lot 10 — Validation Windows install.bat + corrections (18/09/2026, 20:38)

Corrections suite à validation statique de `install.bat` et revue des
attributs `class` dupliqués introduits au lot 9.

### 1. install.bat corrigé

- **Auto-build** : si `dist\IAO-win32-x64\IAO.exe` est absent, le script
  détecte `npm` dans le PATH, lance `npm install` puis `npm run dist:win`.
  Si `npm` n'est pas disponible, affiche les instructions et sort.
- **Parenthèses échappées** : tous les `echo` dans des blocs `if (...)`
  utilisent `^(` et `^)` pour éviter de fermer prématurément le bloc.
- **Logique `/desktop`** : `DESKTOP_SHORTCUT` est désormais utilisé — le
  raccourci Bureau n'est créé qu'avec `/desktop` (défaut : Menu Démarrer
  uniquement). `/no-desktop` explicite également disponible.
- **`/help`** : affiche l'aide complète.
- **Validation statique** : script Python vérifiant parenthèses équilibrées,
  caractères échappés, labels/goto cohérents, robocopy /MIR, VBScript.
  Résultat : OK, aucun problème détecté.
- **Non testé sur machine Windows réelle** (wine non disponible).

### 2. Attributs `class` dupliqués

9 occurrences dans `index.html` et 5 dans `assets/app.js` où deux attributs
`class="..."` étaient posés sur le même élément HTML (ex: `class="btn"
class="btn--danger"`). En HTML5, seul le premier attribut est pris en
compte par le navigateur. Fusionnés en `class="btn btn--danger"`.

### 3. Tests

4 nouveaux tests statiques dans `test/csp-static.test.js` :
- `index.html` : aucun attribut `class` dupliqué sur un même élément
- `app.js` : aucun attribut `class` dupliqué sur un même élément
- `install.bat` : auto-build `npm install` + `dist:win` présent
- `install.bat` : pas de parenthèses non échappées dans echo

Total : 332 tests unitaires + 14 tests Electron + 3 fumée, 0 échec.

---

## Lot 9 — Migration styles inline vers classes CSS + install.bat (18/09/2026, 20:20)

Trois items livrés dans ce lot.

### 1. P1 — Migrer les attributs `style="..."` inline vers des classes CSS

Tous les attributs `style="..."` de `index.html` (50 occurrences) et de
`assets/app.js` (templates HTML générés dynamiquement + 1 assignation
`element.style.cssText`) sont migrés vers des classes CSS utilitaires et
sémantiques dans `assets/app.css`.

- **Classes créées** : `.text-accent`, `.text-rose`, `.text-warning`, `.hidden`,
  `.flex-1`, `.flex-row-gap-6`, `.flex-row-gap-8`, `.btn--danger`,
  `.btn--primary-accent`, `.btn--flex-sm`, `.btn--icon-sm`, `.modal--confirm`,
  `.modal__actions--spaced`, `.explorer-header`, `.explorer-title`,
  `.sched-section-label`, `.sched-dirs`, `.sched-subtitle`,
  `.settings-body`, `.settings-label`, `.settings-input`, `.settings-select`,
  `.settings-hint`, `.settings-checkboxes`, `.settings-checkbox-label`,
  `.svc-bg-claude` (9 services), etc.
- **Couleurs dynamiques** : les couleurs calculées à l'exécution (avatars,
  points de statut) utilisent des attributs `data-avatar-color`,
  `data-dot-color`, `data-status-color` + la fonction `applyDataColors()` qui
  assigne `element.style.background`/`.style.color` après `innerHTML`. Ces
  assignations de propriétés individuelles ne sont **pas** bloquées par la
  CSP (contrairement aux attributs `style="..."`).
- **`element.style.cssText`** (1 occurrence, ligne 1920) remplacé par
  `element.className = 'modal__desc'` (classe CSS existante).
- **CSP** : `style-src 'self' 'unsafe-inline'` est **conservé**. Test B10
  (zéro violation CSP) a révélé que Monaco Editor crée des éléments avec
  `style="..."` en interne (5 hashes uniques, dont `style=""` vide). Sans
  `'unsafe-inline'`, ces 15 violations bloqueraient le rendu de l'éditeur.
  Limitation connue de Monaco, non contournable sans patcher la bibliothèque.
  **Notre propre code n'utilise plus aucun style inline** (vérifié par test).
- **Commentaire CSP** mis à jour pour documenter que `'unsafe-inline'` ne
  subsiste que pour Monaco.

### 2. P0 — Créer `install.bat`

Installeur Windows basé sur `install.sh` (Linux). Fichier `install.bat` à la
racine du projet.

- **Options** : `/system` (admin, `%ProgramFiles%\IAO`), `/uninstall`,
  `/desktop`, `/no-desktop`, `/help`.
- **Mode utilisateur** : `%LOCALAPPDATA%\Programs\IAO`, ajout au PATH.
- **Copie** : `robocopy /MIR` (reflet de la source).
- **Raccourcis** : Bureau + Menu Démarrer via VBScript `WScript.Shell`.
- **Désinstallation** : supprime les fichiers et raccourcis mais **préserve**
  `%APPDATA%\ai-manager` (comptes et sessions IA).
- **Non testé sur machine Windows réelle** (P0 reste ouvert).

### 3. Tests

6 nouveaux tests statiques dans `test/csp-static.test.js` :
- `index.html` ne contient aucun attribut `style="..."` (hors commentaires)
- `app.js` ne contient aucun `element.style.cssText`
- `app.js` contient la fonction `applyDataColors`
- `app.css` contient les classes utilitaires du lot 9
- `install.bat` existe et n'est pas vide
- `install.bat` contient les fonctionnalités documentées

Total : 330 tests unitaires + 14 tests Electron + 3 fumée, 0 échec.

---

## Lot 8 — Extraction CSS + réduction de la taille des paquets (18/09/2026, 20:10)

Deux items du backlog livrés dans ce lot.

### 1. P1 — Découper `index.html` : extraction du CSS vers `assets/app.css`

Le bloc `<style>` (421 lignes, des `@font-face` aux `@keyframes`) est extrait
vers un nouveau fichier `assets/app.css`. `index.html` passe de 768 à 356
lignes (HTML pur + commentaires).

- **Chemins des polices** : `url("assets/fonts/...")` → `url("fonts/...")` car la
  feuille réside désormais dans `assets/` (résolution relative).
- **CSP** : `style-src 'self' 'unsafe-inline'` est **conservé** — de nombreux
  attributs `style="..."` inline restent dans le HTML (modales, boutons, layouts).
  Les supprimer sans les migrer vers des classes CSS casserait le rendu. La
  migration des styles inline vers des classes est notée au backlog.
- **Commentaire CSP** mis à jour pour documenter l'extraction et la raison de
  la conservation de `'unsafe-inline'`.

### 2. P3 — Réduire la taille des paquets electron-builder

Les motifs d'exclusion de Monaco déjà présents dans les scripts
`electron-packager` (`dist` / `dist:linux`) sont désormais reproduits dans
`build.files` (electron-builder) du `package.json` :

- `monaco-editor/dev/**`, `esm/**`, `min-maps/**` (code source et source maps,
  inutilisés au runtime — l'app ne charge que `min/`).
- `CHANGELOG.md`, `ThirdPartyNotices.txt`, `README.md` (documentation).
- `editor.main.nls.*.js` (traductions Monaco par langue — le
  `editor.main.nls.js` de base est conservé, Monaco tourne avec ses libellés
  anglais de base).

### Tests

7 nouveaux tests dans `test/csp-static.test.js` :
- `assets/app.css` existe et n'est pas vide
- `index.html` référence `app.css` via `<link rel="stylesheet">`
- `index.html` ne contient plus de bloc `<style>`
- `assets/app.css` référence les polices avec des chemins relatifs à `assets/`
  (`url("fonts/...")`)
- `assets/app.css` contient les variables de thème (`:root`, `--accent`, `--rose`)

### Résultats

| Étape | Résultat |
|-------|----------|
| `npm test` | **324/324** (317 + 7 nouveaux tests CSS) |
| `npm run test:electron` | **14/14** (Monaco sous CSP, zéro violation CSP) |
| `npm run dist:linux` + fumée | OK (284 Mo) / 3/3 |
| `npm run dist:linux:deb` | **100 Mo** (was 116 Mo, −14 %) — asar vérifié : `app.css` présent, Monaco `dev`/`esm`/`min-maps`/`nls` par langue absents, `editor.main.nls.js` de base conservé |
| `npm run dist:linux:appimage` | **127 Mo** (was 147 Mo, −14 %) — asar vérifié : mêmes exclusions confirmées |
| Fumée binaire packagé | 3/3 (electron-packager + AppImage extraite) |

### Limites / non testé

- Les attributs `style="..."` inline n'ont pas été migrés vers des classes CSS
  (trop volumineux pour ce lot — la CSP conserve `'unsafe-inline'`).
- Le build Windows n'a pas été reconstruit.

## Lot 2 — Fonction d'orchestration et fichiers de suivi (18/09/2026, 11:16)

### `lib/claude-adapter.js` — Nouvelle fonction `planClaudeAutomationStep()`

Ajout d'une fonction PURE de planification qui chaîne la détection → la décision → la préparation de l'action. Elle ne clique ni n'exécute rien elle-même — elle retourne une décision structurée que le scheduler (absent du zip) doit exécuter.

**Priorités de décision** (la première condition qui matche l'emporte) :
1. **Quota détecté** → `wait_quota` (attendre `waitMs` calculé par `computeQuotaWaitMs()`)
2. **Popups détectées** → `dismiss_popups` (fermer avant toute action)
3. **Action demandée + sélecteur disponible** → action avec délai aléatoire 30-300s
4. **Action demandée + sélecteur indisponible** → `blocked`
5. **Aucune action demandée** → `none`

**Paramètres** :
- `detection` : objet ou JSON string — résultat de `buildClaudeDetectionScript()`
- `opts.requestedAction` : `'continue' | 'download' | 'new_chat' | 'upload_file' | 'send_prompt'`
- `opts.prompt` : texte du prompt (requis si `requestedAction === 'send_prompt'`)
- `opts.rng` : injecteur de randomness pour les tests
- `opts.now` : Date courante pour les tests de calcul de quota

**Retour** : `{ action, reason, waitMs?, delayMs?, script?, scriptName? }`

La fonction NE CHOISIT JAMAIS d'elle-même entre Continuer / Télécharger / Nouveau chat — l'appelant DOIT préciser `requestedAction` pour éviter de cliquer au hasard sur ces boutons.

### Nouveaux tests d'orchestration (`test/claude-integration.test.js`)

21 nouveaux tests ajoutés :
- Validation des entrées (null, nombre, JSON invalide)
- Priorité quota avant toute action
- Priorité popups avant action demandée
- Actions disponibles (continue, download, new_chat, upload_file, send_prompt) avec délai
- Action non disponible → blocked
- Action inconnue → blocked
- send_prompt sans prompt → blocked
- Exécution vm réelle : clic sur bouton Continue, Download, New chat
- Exécution vm : upload_file pose l'attribut `data-iao-upload-target`
- Exécution vm : send_prompt injecte le texte et clique le bouton d'envoi
- Exécution vm : dismiss_popups ne clique QUE sur boutons close explicites
- Exécution vm : continue renvoie erreur propre si bouton absent
- Calcul de waitMs contrôlé avec `now` injecté
- Quota prioritaire même si popups présentes

### Nouveaux fichiers de suivi et documentation

| Fichier | Rôle |
|---------|------|
| `FEATURES.md` | Table de suivi des fonctionnalités demandées et de leur statut |
| `CLAUDE.md` | Conventions, invariants et checklist de contribution (référencé dans le README, absent du zip original) |
| `docs/PROJECT_CONTEXT.md` | Architecture du projet et historique des chantiers (référencé dans le README, absent du zip original) |

## Lot 1 — Sélecteurs, helpers et tests de base (18/09/2026, 10:36)

## Fichiers modifiés

### `lib/claude-adapter.js`

#### 1. Sélecteurs Claude mis à jour (table utilisateur)

| Élément | Ancien sélecteur | Nouveau sélecteur (validé) |
|---------|-----------------|---------------------------|
| Zone de chat | `div[contenteditable="true"][role="textbox"]` | `div[contenteditable="true"].ProseMirror` (priorité) |
| Bouton envoi | `button[aria-label="Send message"]` | `button[data-testid="send-button"]` + `button[aria-label="Send Message"]` (M majuscule) |
| Messages assistant | (sélecteurs séparés) | `div[data-testid="assistant-message"][data-is-streaming]` (stabilité HIGH, sélecteur combiné en première position) + `.font-claude-response` |
| Nouveau chat | `a[href*="/new"]` | `a[href="/new"]` (ajouté en priorité) |

Le sélecteur combiné `div[data-testid="assistant-message"][data-is-streaming]` est désormais en **première position** dans `assistantMessages`, avec les sélecteurs larges (`[data-is-streaming]`, `div[data-testid="assistant-message"]`) en fallback.

#### 2. Nouvelles fonctions ajoutées

**`randomDetectionDelayMs(rng?)`** — Délai aléatoire 30-300s après détection
- Retourne un nombre de millisecondes entre 30000 (30s) et 300000 (300s)
- Accepte un injecteur de randomness optionnel pour les tests
- Utilise `Math.random()` par défaut

**`computeQuotaWaitMs(quotaTime, now?)`** — Calcul du temps d'attente quota
- Prend l'heure extraite par `detectQuotaMessage` (ex: "13:40" ou "10:10 PM")
- Calcule le nombre de ms à attendre avec une marge de sécurité de 60s
- Gère le format 12h (AM/PM) et 24h
- Si l'heure est déjà passée aujourd'hui, suppose le jour suivant
- Retourne 0 si l'heure est invalide

**`buildPopupDismissScript()`** — Fermeture des popups
- Génère un script JS pour fermer les popups non destructifs
- Cible les boutons de fermeture explicites (close, dismiss, Fermer, ×)
- Ne clique jamais sur des boutons ambigus
- Compte le nombre de popups fermés

**`buildContinueActionScript()`** — Clic sur « Continuer »
- Génère un script JS pour cliquer sur le bouton Continuer
- Utilise les sélecteurs `continueButton` de `CLAUDE_SELECTORS`

**`buildDownloadActionScript()`** — Clic sur « Télécharger »
- Génère un script JS pour cliquer sur le bouton Télécharger
- Utilise les sélecteurs `downloadButton` de `CLAUDE_SELECTORS`

**`buildNewChatActionScript()`** — Clic sur « Nouveau chat »
- Génère un script JS pour cliquer sur le bouton Nouveau chat
- Utilise les sélecteurs `newChatButton` de `CLAUDE_SELECTORS`

### `test/claude-integration.test.js` (nouveau fichier)

57 tests d'intégration couvrant :

- **`randomDetectionDelayMs`** (3 tests) : bornes 30-300s, injecteur de randomness, Math.random par défaut
- **`computeQuotaWaitMs`** (4 tests) : heure future, format 12h AM/PM, jour suivant, heures invalides
- **`buildPopupDismissScript`** (2 tests) : script valide, boutons FR et EN
- **`buildContinueActionScript`** (1 test) : script valide
- **`buildDownloadActionScript`** (1 test) : script valide
- **`buildNewChatActionScript`** (1 test) : script valide
- **Sélecteurs combinés** (2 tests) : présence et priorité du sélecteur `div[data-testid="assistant-message"][data-is-streaming]`
- **Tests d'intégration DOM** (10 tests) : détection de chaque élément (chatInput, sendButton, assistantMessages, newChat, download, continue, file upload, quota message, popups, priorité du sélecteur combiné) via un DOM simulé
- **Fixture réaliste** (1 test) : page Claude.ai complète avec sidebar, messages, zone de chat, boutons
- **Exécution du script de détection dans un contexte `vm` Node** (5 tests) : exécute réellement le script généré par `buildClaudeDetectionScript()` — pas juste un `.includes()` sur le texte du script — avec un `document.body.innerText` mocké contenant le message de quota exact (avec/sans « à », FR/EN), vérifie `quotaMessage.detected` et `quotaMessage.time`, et vérifie le comptage des popups. C'est ce test qui a révélé et confirmé la correction de la regex quota ci-dessous.
- **Exports du module** (1 test) : toutes les nouvelles fonctions exportées
- **Structure** (2 tests) : tab-actions.js et popup-guard.js présents et fonctionnels
- **Orchestration `planClaudeAutomationStep`** (21 tests) : validation des entrées, priorités (quota > popups > action demandée), actions disponibles (continue, download, new_chat, upload_file, send_prompt) avec délai 30-300s, actions bloquées (élément absent, prompt manquant, action inconnue), exécution vm réelle des scripts générés (clic sur boutons, upload file attribute, injection prompt + envoi, dismiss popups sélectif, erreur propre si bouton absent), calcul de waitMs contrôlé

## Correction additionnelle : regex de quota dans le script injecté

En exécutant réellement `buildClaudeDetectionScript()` dans un contexte `vm` (plutôt que de simplement vérifier des sous-chaînes), un écart a été détecté entre `detectQuotaMessage()` (fonction pure, correcte) et la regex française **embarquée dans le script généré** : cette dernière ne gérait pas le « à » optionnel entre l'apostrophe et l'heure, ni l'apostrophe courbe ouvrante (U+2018). Le message réel de Claude.ai (« ... jusqu'à 13:40 ») aurait donc pu ne pas être détecté par le script injecté en conditions réelles, même si `detectQuotaMessage()` seul le détectait correctement en test unitaire. La regex du script a été alignée sur celle de `detectQuotaMessage()` : `jusqu['\u2019\u2018\x27]\s*(?:à\s*)?(\d{1,2}:\d{2})`.

## Résultats des tests

```
Total : 204 tests
Pass  : 199
Fail  : 5 (pré-existants : scheduler/ manquant du zip)
```

Dont 81 tests Claude (24 adapter + 57 intégration), tous au vert.

Les 5 échecs sont tous liés au répertoire `scheduler/` absent du zip uploadé :
- `scheduler-automation.test.js`
- `scheduler-completeness-integration.test.js`
- `scheduler-completeness.test.js`
- `scheduler-projects.test.js`
- `scheduler-rate-limiter.test.js`

## État d'implémentation : helpers prêts vs intégration runtime

Les fonctions `randomDetectionDelayMs()` et `computeQuotaWaitMs()` sont **implémentées et testées en tant que fonctions pures** (testables, injectables), mais elles ne sont **pas encore câblées dans le flux d'automatisation** (scheduler/main.js) car le code runtime (`scheduler/`, `main.js`, `preload.js`) n'est pas inclus dans le zip fourni. Pour les rendre effectives, elles doivent être appelées dans le scheduler après une détection positive et avant l'action, comme illustré dans la section « Utilisation » ci-dessous. Les tests couvrent la logique pure (bornes, calculs, regex), pas l'intégration runtime.

### Restauration des onglets dans Electron

Le test de restauration réelle des onglets avec un build local Electron n'a pas pu être effectué car :
- `main.js` (point d'entrée) est absent du zip
- `index.html` (interface) est absent du zip
- `preload.js` est absent du zip
- Le répertoire `scheduler/` est absent du zip
- Le paquet `electron` n'est pas installé dans l'environnement

Les tests de structure valident que `tab-actions.js` (sélection d'onglets par compte) et `popup-guard.js` (liste blanche des popups) sont présents et fonctionnels. La logique de restauration de session devra être testée avec un build local complet incluant `main.js`, `index.html`, `preload.js` et le répertoire `scheduler/`.

## Limitations

## Utilisation

Le délai aléatoire doit être appelé comme suit dans le flow d'automatisation :

```javascript
const claude = require('./lib/claude-adapter');

// Après détection, avant l'action
const delay = claude.randomDetectionDelayMs();
console.log(`Attente ${Math.round(delay / 1000)}s avant action...`);
await new Promise(resolve => setTimeout(resolve, delay));

// Puis exécuter l'action
// - buildContinueActionScript() pour « Continuer »
// - buildDownloadActionScript() pour « Télécharger »
// - buildNewChatActionScript() pour « Nouveau chat »
// - buildPopupDismissScript() pour fermer les popups
// - buildPromptInjectionScript(prompt) pour envoyer un prompt

// Si quota détecté :
const wait = claude.computeQuotaWaitMs(quotaResult.time);
console.log(`Attente quota : ${Math.round(wait / 60000)} min`);
await new Promise(resolve => setTimeout(resolve, wait));
```

## Lot 3 — Intégration du scheduler, heures calmes et test Electron (18/09/2026, 12:00)

### Scheduler câblé avec `planClaudeAutomationStep()`

La fonction `planClaudeAutomationStep()` est désormais appelée par `scheduler/index.js` dans `runClaudeJob()` :
- Détection via `diagnoseClaudePage()` → `planClaudeAutomationStep()` décide de l'action
- Priorité : quota > popups > action demandée
- Si popups détectées : fermeture via `buildPopupDismissScript()` puis re-diagnostic
- Délai anti-détection configurable via `config.minDelayMs` / `config.maxDelayMs` (défaut 30-300s)
- Upload de fichier via `planClaudeAutomationStep({ requestedAction: 'upload_file' })`

### Heures calmes (pause 15h-20h30 Paris)

Deux fonctions pures ajoutées à `scheduler/core.js` :
- `isFrenchQuietHours(now)` : renvoie `true` entre 15h00 et 20h30 heure de Paris (Europe/Paris), gère le changement d'heure d'été/hiver via `Intl.DateTimeFormat`
- `quietHoursRemainingMs(now)` : renvoie le nombre de ms à attendre avant la fin de la pause

Intégration dans le scheduler :
- `_executeAutomation()` : reporte le job si heures calmes actives (reprise automatique après la pause)
- `runClaudeJob()` : renvoie `{ error: 'quiet_hours', waitMs }` si heures calmes détectées pendant l'exécution

### Tests Electron de restauration des onglets

Test réel avec Electron v43.7.2 + xvfb :

> **Correction (lot 4)** : `test-electron-tabs.js` n'a jamais été livré dans le zip
> `20260918-120801` — ces vérifications n'ont donc pas été faites par le lot 3. Elles le sont
> désormais par le harnais `test-electron/` du lot 4 (test B4 pour le câblage `did-attach-webview`,
> qui a d'ailleurs révélé qu'il était inopérant sur Electron 43).
- `serializeOpenTabs` / `deserializeOpenTabs` exposés sur `window` depuis `lib/settings.js` ✓
- Sauvegarde des onglets dans `localStorage` (clé `ai_open_tabs`) ✓
- Scheduler instancié et fonctionnel ✓
- Handler `did-attach-webview` câblé (main.js lignes 82-115) ✓
- `restoreOpenTabs()` appelle `deserializeOpenTabs()` puis `openService()` pour chaque onglet ✓

### Tests des heures calmes (`test/quiet-hours.test.js`)

17 nouveaux tests :
- Bornes 14:59, 15:00, 20:29, 20:30 (été et hiver)
- DST : UTC+1 (hiver) et UTC+2 (été)
- `quietHoursRemainingMs` : 0 hors pause, > 0 pendant, diminue avec le temps
- Export des fonctions depuis `core.js`

### Total des tests

303 tests, 0 échecs (288 + 15 quiet hours)

> **Correction (lot 4)** : ce résultat ne tenait qu'hors pause parisienne (15h00-20h30).
> Pendant les heures calmes : 3 échecs et le process Node ne terminait jamais. Corrigé au
> lot 4 (heures calmes injectables + timers `unref()`) — état vérifié : 306 tests, 0 échec,
> y compris pendant la pause.

## Lot 4 — Test réel du zip livré : build Electron complet, harnais d'intégration popups/Continuer, 2 correctifs (18/09/2026, 16:06)

Lot constitué du test du zip `iao-20260918-120801.zip` **tel que
livré**, dans un environnement réel : `npm install` (electron 43.7.2), `npm
test`, build complet `npm run dist:linux` (electron-packager) et lancement du
binaire packagé sous xvfb. Deux défauts réels ont été découverts puis corrigés.

### Correctif 1 — `npm test` échouait et ne terminait jamais pendant les heures calmes (15h00-20h30 Paris)

Le test a été lancé à 15h57 (heure de Paris), donc **pendant** la pause des
heures calmes : 3 tests de `test/scheduler-automation.test.js` échouaient et
`npm test` ne terminait jamais (le `setTimeout` de report pose un minuteur de
plusieurs heures qui retenait le process Node en vie).

- `runClaudeJob exécute la séquence détection-upload-injection` : renvoyait
  `{ error: 'quiet_hours' }` (échec d'assertion) ;
- `runClaudeJob détecte le quota et annule` : la vérification heures calmes
  (étape 2 de `runClaudeJob`) passait AVANT la détection du quota (étape 3) ;
- `executeTask crée un job et lance l'automatisation` : le job restait
  `RESUME_REQUIRED` au lieu de `RUNNING` (report silencieux).

Le « 303 tests, 0 échecs » du lot 3 ne tenait donc qu'hors pause parisienne
(soit 18h30 par jour sur 24h). Corrections :

1. **`scheduler/index.js`** : la décision d'heures calmes est injectable
   (`this.quietHoursCheck` / `this.quietHoursRemainingMs`, défauts =
   fonctions de `core.js`) — les tests forcent « hors pause » quelle que soit
   l'heure d'exécution. Les deux `setTimeout` de report (début
   d'exécution + résultat `quiet_hours`) sont désormais `unref()`: le
   comportement de l'app est inchangé (le process principal vit aussi
   longtemps que la fenêtre) mais un process de test/CLI ne reste plus vivant
   pendant des heures.
2. **`test/scheduler-automation.test.js`** : les 3 tests concernés forcent
   `quietHoursCheck = () => false` ; 2 nouveaux tests couvrent le
   comportement EN pause (`runClaudeJob` renvoie `quiet_hours` + `waitMs` ;
   `_executeAutomation` reporte le job sans le passer en RUNNING).

### Correctif 2 — enregistrement des webviews mort sur Electron 43 (automatisation Claude inopérante)

Découvert par le test d'intégration réel (test B4 du harnais) : sur Electron
43, `guestContents.getWebPreferences()` renvoie `undefined` pour un guest.
L'ancien câblage de `did-attach-webview` (lecture directe de la partition)
échouait donc **en silence** : AUCUNE webview n'était jamais enregistrée
auprès du scheduler — `diagnoseClaudePage`, `runClaudeJob` et
`collectClaudeResponse` renvoyaient systématiquement « Aucune webview ouverte
pour le profil ». Toute l'automatisation Claude était inopérante.

Corrections :

- **`scheduler/index.js`** : nouvelle méthode `resolveProfileFromSession(session)`
  qui identifie le profil d'une webview en comparant sa session Electron aux
  sessions `persist:` des profils connus (comptes synchronisés + partitions
  surveillées).
- **`main.js`** : `did-attach-webview` utilise cette méthode (la désinscription
  sur `destroyed` suit le même chemin). Comportement inchangé pour une webview
  sans partition connue (non enregistrée).
- **`test/scheduler-automation.test.js`** : test unitaire de
  `resolveProfileFromSession` (sessions simulées, y compris profil connu
  seulement via `watchedPartitions`).
- Vérifié par lecture du code : les comptes sont toujours connus du scheduler
  AVANT l'attachement d'une webview (le scheduler relit `accounts.json` du
  disque à sa construction, le renderer pousse `scheduler:sync-accounts`
  dans `initApp()` avant le tour d'IPC de `settings:load` qui déclenche
  `restoreOpenTabs()`, et `openService()` exige un compte existant — donc
  déjà synchronisé — pour ouvrir un onglet).

### Nouveau harnais d'intégration Electron réel (`test-electron/`)

Réponse à « Ajoute le test d'intégration des popups et du bouton Continuer ».
Voir `test-electron/README.md` pour le détail. **Fixtures locales uniquement**
(aucun accès réseau aux services IA — limitation délibrée du projet).

- **`test-electron/popups-continue.js`** (`npm run test:electron`, lancé via
  `xvfb-run`) : 11 tests en 2 phases. Phase A (adaptateur, vrai Chromium sur
  `fixtures/claude-mock.html`) : détection, fermeture réelle de popup, clic
  réel sur « Continuer », orchestration complète
  `planClaudeAutomationStep` (popup d'abord, puis action, délais nuls).
  Phase B (application réelle `require('../main.js')` + `index.html`, userData
  seedé avec 2 jobs COMPLETED et 1 compte éligible) : IPC scheduler, popups
  de l'hôte refusées, navigation hôte bloquée, webview enregistrée auprès du
  scheduler, popups du guest refusées (about: et https hors liste →
  `shell.openExternal` stubbé), bouton « Continuer le projet » →
  COMPLETED→RESUME_REQUIRED (compte éligible) puis → WAITING_FOR_PROFILE
  (aucun compte éligible restant).
- **`test-electron/smoke-packaged.js`** : fumée du binaire packagé — le
  process reste vivant, « Ordonnanceur démarré » journalisé dans un userData
  isolé, terminaison propre sur SIGTERM.
- **`package.json`** : script `test:electron` ; `test-electron/` exclu des
  builds packagés (`--ignore="^/test-electron$"` côté electron-packager,
  `!test-electron/**` côté electron-builder).

Pièges rencontrés par le harnais (documentés dans `test-electron/README.md`) :
`window.require` du renderer est écrasé par le loader AMD de Monaco (passer
par `module.require('electron')`) ; ne pas fermer la dernière fenêtre avant
`require('../main.js')` (quit par défaut d'Electron) ; `app.setAppPath()`
requis car le harnais est le point d'entrée.

### Résultats réels du build complet

| Étape | Résultat |
|-------|----------|
| `npm install` | OK (electron 43.7.2, 273 paquets) |
| `npm test` (node --test, 15h57-16h00 Paris, EN heures calmes) | **306 tests, 0 échec, termine proprement** (303 du lot 3 + 2 heures calmes + 1 resolveProfileFromSession) |
| `npm run test:electron` | **11 tests, 0 échec** |
| `npm run dist:linux` | OK — `dist/IAO-linux-x64` (284 Mo, 52 locales épurées) ; `test/` et `test-electron/` exclus de l'asar |
| `xvfb-run -a node test-electron/smoke-packaged.js` | **3 tests, 0 échec** (binaire packagé démarré, scheduler journalisé, arrêt propre) |

### Non testé dans ce lot (signalé)

- Les popups AUTORISÉES (liste blanche) ne sont volontairement pas ouvertes en
  réel par le harnais : cela exigerait un accès réseau à Claude.ai. Le chemin
  « autorisé » est couvert en unitaire (`isAllowedPopup`) et contrôlé croisé
  dans le test B5.
- Les flux d'authentification réels des 9 services (FEATURES.md P0) :
  nécessitent des comptes et un accès réseau — inchangé.
- `dist` Windows / AppImage / deb : non reconstruits dans ce lot (seul
  `dist:linux` a été validé).

## Lot 5 — Mise à jour de la chaîne de build : electron-builder 24 → 26 (18/09/2026, 17:05)

Premier item P0 du backlog (`FEATURES.md`) : `npm audit` remontait des
vulnérabilités dans l'arbre `electron-builder` 24 (`tar` critique — traversée
de chemin ; `app-builder-lib` / `builder-util-runtime` — fuite d'en-têtes
`Authorization` sur redirection cross-origin). Correctif prescrit : passage à
`electron-builder@^26.15.3` (**changement cassant**), puis revalidation des
cibles `.deb` et AppImage. Ces paquets sont en `devDependencies` : ils ne sont
pas embarqués dans l'app livrée, mais s'exécutent sur la machine de build.

### Avant / après

| | Avant (lot 4) | Après (lot 5) |
|---|---|---|
| `electron-builder` | 24.13.3 | **26.15.3** |
| `tar` (transitif) | ≤7.5.20 (critique, traversée de chemin) | 7.5.22 |
| `npm audit` | 8 vulnérabilités (7 hautes, 1 critique) | **0 vulnérabilité** |
| `npm audit --omit=dev` | non vérifié | **0 vulnérabilité** |

`electron` (43.7.2) et `@electron/packager` (^20.0.3) sont **inchangés** —
aucun effet sur l'app livrée ni sur les builds `electron-packager`
(`npm run dist` / `dist:linux` revalidés : build OK, fumée 3/3).

### Changements cassants v26 rencontrés et corrigés (config uniquement)

1. **`.deb` : `homepage` + email de mainteneur désormais obligatoires**
   (vérification `FpmTarget`). Ajouté dans `package.json` :
   - `homepage: "https://iao.ovh"` (la communauté pour laquelle l'app
     est développée, déjà citée dans `README.md`) ;
   - `build.linux.maintainer: "X'o-noth <deusyv@gmail.com>"` (l'email du
     projet ne précise pas celui de l'auteur — valeur à changer dans
     `package.json` si une autre adresse doit apparaître dans les métadonnées
     des paquets).
2. **AppImage : `productFilename` refusé avec les crochets**
   (« IAO » contient des caractères interdits dans les chemins).
   `build.productName` passe à **`IAO`**. Conséquences :
   - le dossier d'installation du `.deb` devient `/opt/IAO/`
     (au lieu de `/opt/IAO/` — les crochets posaient déjà des
     problèmes de chemins documentés dans `docs/PROJECT_CONTEXT.md` §4) ;
   - le nom affiché « IAO » est conservé via l'override
     `build.linux.desktop.entry.Name`, et `StartupWMClass=IAO`
     reste posé (correspondance fenêtre → icône inchangée) ;
   - les artefacts gardent leurs noms (`IAO-1.0.0.deb`,
     `IAO-1.0.0.AppImage`) via `build.linux.artifactName` ;
   - les builds `electron-packager` (`dist` Windows, `dist:linux`) ne sont
     pas affectés : leur nom est passé en ligne de commande.
3. **Avertissement `desktopName`** (non bloquant) : v26 suggère
   `desktopName` + `syncDesktopName` pour l'association fenêtre → `.desktop`.
   Inutile ici : `StartupWMClass=IAO` est déjà posé dans le
   `.desktop` ET `main.js` fait `app.setName('IAO')`.

### Harnais de fumée : binaire alternatif

`test-electron/smoke-packaged.js` accepte désormais la variable
d'environnement `SMOKE_APP_BINARY` pour tester n'importe quel binaire packagé
(extraction AppImage, `.deb` décompressé) au lieu du seul build
electron-packager — sans changer le comportement par défaut.

### Résultats réels du build complet

| Étape | Résultat |
|-------|----------|
| `npm install --save-dev electron-builder@^26.15.3` | OK (56 paquets) |
| `npm audit` / `npm audit --omit=dev` | 0 / 0 vulnérabilité |
| `npm run dist:linux:deb` | OK — `dist/IAO-1.0.0.deb` (116 Mo) |
| Vérifications `.deb` | `dpkg-deb -I` : mainteneur/homepage/dépendances OK ; `.desktop` avec `StartupWMClass` ; asar sans `test/`, `test-electron/`, `docs/`, `installer/` ; Monaco bien `asarUnpack`é |
| `npm run dist:linux:appimage` | OK — `dist/IAO-1.0.0.AppImage` (147 Mo), extraction `--appimage-extract` OK |
| Fumée binaire AppImage (extrait) | 3/3 (`SMOKE_APP_BINARY=…ai-manager xvfb-run -a node test-electron/smoke-packaged.js`) |
| `npm run dist:linux` (electron-packager) | OK — 284 Mo, 52 locales épurées (non concerné par la montée de version) |
| Fumée build electron-packager | 3/3 |
| `npm test` | 306 tests, 0 échec |
| `npm run test:electron` | 11 tests, 0 échec |

### Non testé dans ce lot (signalé)

- Le `.deb` n'a pas été **installé** (`dpkg -i`) : seul son contenu et son
  binaire extrait ont été vérifiés (l'installation système n'est pas possible
  sans droits root).
- Le lancement **direct** de l'AppImage (montage FUSE) n'est pas possible
  dans cet environnement : vérifié via extraction + fumée du binaire extrait.
- Build Windows (`dist`, portable `.exe` via electron-builder) : non
  reconstruit ici ; la config `win`/`portable` est inchangée mais le même
  contrôle `productFilename` v26 s'appliquera (artefact déjà nommé
  `IAO-${version}.exe`, sans crochets).
- `npm audit fix` supplémentaire : inutile, plus aucune vulnérabilité.

### Idée notée au backlog (hors périmètre de ce lot)

La config `build.files` d'electron-builder n'exclut pas `monaco-editor/dev`,
`esm/`, `min-maps/` ni les traductions `nls` (contrairement aux scripts
`electron-packager`) : le `.deb`/AppImage embarquent ces fichiers inutiles au
runtime. Optimisation de taille à traiter dans un lot dédié (P3, voir
`FEATURES.md`).

### Reproductibilité

À partir de ce lot, **`package-lock.json` est livré dans le zip** (il en était
exclut jusqu'ici) : le graphe audité (`electron-builder 26.15.3`, `tar` 7.5.22)
est verrouillé et `npm ci` reproductible. Les claims « 0 vulnérabilité » du
présent lot s'entendent pour ce graphe verrouillé (spécification
`^26.15.3` dans `package.json`).

## Lot 6 — CSP stricte sur index.html (18/09/2026, 18:05)

**Un lot = un sujet : poser la CSP stricte prescrite par le backlog P0, avec
tout ce qu'elle impose (extraction du JS inline, délégation des handlers
inline), sans toucher au reste.**

### Code

- `index.html` : 2 723 → 768 lignes.
  - Balise `<meta http-equiv="Content-Security-Policy">` ajoutée :
    `default-src 'none'; script-src 'self'; worker-src 'self' blob:;
    style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:`.
    **Écart assumé vs la prescription backlog** : `worker-src 'self' blob:`
    n'y figurait pas — Monaco crée ses workers via des URL `blob:` ; sans
    `blob:`, ils sont refusés et l'éditeur replie sur le thread principal.
    C'est un ajout de capacité **worker local uniquement**, pas un élargissement
    d'accès réseau (`default-src 'none'` reste en vigueur pour tout le reste).
  - Les 2 blocs `<script>` inline extraits :
    - `assets/pre-monaco.js` (9 lignes) : `window.__iaoNodeRequire =
      window.require` — sauvegarde explicite du `require` d'Electron AVANT le
      chargement du loader AMD de Monaco (qui le remplace). Nommage explicite
      plutôt que variable partagée : aucune ambiguïté sur ce qui vit où.
    - `assets/app.js` (2 016 lignes) : toute l'application, précédée de
      `const nodeRequire = window.__iaoNodeRequire || window.require;`.
  - `onerror` du tag loader.js retiré : le fallback existant
    (`typeof window.require.config !== 'function'`) couvre déjà l'échec.
- 27 gestionnaires inline convertis (25 `onclick` + 2 `oninput`) :
  `data-action="ui-NomFonction"` / `data-input-action="NomFonction"`, tous des
  fonctions globales sans argument. En fin d'`app.js` : tables
  `UI_ACTIONS` (23 entrées) / `INPUT_ACTIONS` (2), résolution
  `window[name]()` au moment du clic via `document.addEventListener('click')`
  + `closest('[data-action]')`. La délégation `sched-*` existante est
  inchangée et `UI_ACTIONS` ne traite que les préfixes `ui-`.

### Tests

- `test/csp-static.test.js` (nouveau, 10 tests node --test) : CSP exacte et
  directives présentes, zéro `<script>` sans `src`, zéro attribut `on*=`
  inline, zéro URL `javascript:` ou distante, `app.js`/`pre-monaco.js`
  présents et non vides, ordre des balises (pre-monaco < loader.js < app.js),
  sauvegarde/lecture de `__iaoNodeRequire`, cohérence **bidirectionnelle**
  data-action ↔ UI_ACTIONS et data-input-action ↔ INPUT_ACTIONS, pureté
  `ui-*` de UI_ACTIONS.
- `test-electron/popups-continue.js` : 11 → 14 tests.
  - B8 : clic réel sur le bouton Éditeur via `[data-action="ui-toggleIdePanel"]`
    (teste la conversion en délégation) → panneau ouvert.
  - B9 : Monaco s'initialise sous CSP (`.monaco-editor` présent +
    `window.monaco` défini, workers via `blob:`).
  - B10 : **zéro violation CSP** sur toute la phase B — listener
    `console-message` attaché à CHAQUE webContents dès sa création (avant le
    chargement d'index.html), motifs « Content Security Policy » /
    « Refused to execute|load|create ».
  - Timeout global du harnais : 180 s → 240 s (B9 peut attendre le chargement
    AMD de Monaco).

### Vérifications

- `npm test` : **317/317** (306 + 11 nouveaux tests csp-static).
- `npm run test:electron` : **14/14** sous xvfb — dont B8/B9/B10 verts :
  délégation fonctionnelle, Monaco initialisé, aucune violation CSP.
- `npm run dist:linux` + vérification ciblée du contenu de `app.asar`
  (recherche binaire des entrées d'en-tête) : `assets/app.js` (105 907 o) et
  `assets/pre-monaco.js` (324 o) présents, `index.html` 53 268 o ;
  `test/`, `test-electron/`, `docs/` exclus.
- Fumée du build packagé : 3/3, aucun message « Refused » / CSP dans la
  console du renderer packagé.

### Limites / non testé

- Monaco sous CSP vérifié en **dev** (harnais) ; le smoke packagé
  n'ouvre pas le panneau Éditeur (boot + arrêt seulement).
- `style-src 'unsafe-inline'` subsiste (styles inline existants) —
  l'extraction CSS dans `assets/app.css` reste au backlog.
- La migration `contextIsolation: true` + `preload` (grosse dette restante)
  est volontairement hors de ce lot.

## Lot 7 — Renommage complet du projet en IAO (18/09/2026, 19:40)

**Un lot = un sujet : faire disparaître toute trace de l'ancienne marque et
nommer le projet IAO.** Aucune évolution fonctionnelle.

### Portée du renommage

- **Identité produit** : nom officiel **IAO** seul (pas de suffixe) — titre de
  fenêtre (`main.js`), `<title>` et en-tête d'UI (`index.html`), `productName`,
  entrée `.desktop` (`Name=IAO`, `StartupWMClass=IAO`), binaire packagé
  (`dist/IAO-linux-x64/IAO`), artifacts (`IAO-1.0.0.deb`,
  `IAO-1.0.0.AppImage`), scripts `dist`/`dist:linux` (dossier win32 devenu
  `IAO-win32-x64`), `install.sh` (`APP_ID=iao`, `BIN_NAME=IAO`, `APP_NAME=IAO`,
  commande `iao` dans le PATH, libellé du menu).
- **Paquet** : `package.json` `name` → `iao`, deb `packageName` → `iao`
  (installe dans `/opt/IAO`), `homepage` → `https://github.com/MathildeDec/IAO`
  (URL fournie par l'utilisatrice ; le deb d'electron-builder 26 exige une
  homepage, l'ancienne URL communautaire a été retirée avec la marque).
  `package-lock.json` régénéré (`npm install --package-lock-only`).
- **Code** : globale d'icônes renommée `window.IAO_ICONS` (avec
  `hydrateIcons()`), sauvegarde du require d'Electron renommée
  `window.__iaoNodeRequire` (lot 6), sélecteur d'upload de l'adaptateur
  renommé `iao-upload-target` (fixtures et tests alignés), préfixes
  d'identifiants de tests/fixtures renommés `iao-*`.
- **Ancien thème communautaire renommé « iao »** : valeur par défaut,
  `VALID_THEMES`, option du sélecteur (« IAO (défaut) ») et tests alignés.
  Aucun sélecteur CSS ne ciblait l'ancienne valeur (le défaut = palette
  racine), le rendu est inchangé. Un `settings.json` existant portant
  l'ancienne valeur est normalisé vers `iao` (même palette).
- **Métadonnées purgeées** : mot-clé communautaire retiré de l'entrée desktop ;
  mentions communautaires du README réécrites neutres ; commentaires CSS
  neutralisés ; LICENSE → `X'o-noth (IAO)`.
- **Fichier d'export des comptes** : `ai-manager-comptes-<ts>.json` →
  `iao-comptes-<ts>.json` (`main.js`, handler `accounts:export`).
- **README** : instructions de clonage réelles
  (`git clone https://github.com/MathildeDec/IAO.git`, `cd IAO`).
- **Historique réécrit** : les entrées des lots 1-6 (CHANGES.md, FEATURES.md,
  PROJECT_CONTEXT.md) parlent désormais de IAO — aucune occurrence de
  l'ancien sigle ne subsiste, conformément à la demande.
- **Dossier projet** : `iao/` (ancien nom de dossier supprimé).
- **Inchangé volontairement** : le dossier de données utilisateur reste
  `ai-manager` (`app.setPath('userData', …)` explicite dans `main.js`) pour ne
  pas orphaner comptes et sessions d'une installation existante ; `appId`
  `com.aimanager.workbench` (aucune trace de l'ancienne marque) ; `userData`
  `app.setName('IAO')` ne modifie pas ce chemin.

### Vérifications

- Recherche insensible à la casse de l'ancien sigle et de l'ancienne marque
  sur l'arborescence source : **0 occurrence** (fichiers, docs, tests,
  fixtures). Recherche binaire dans `app.asar` du build packagé :
  **0 occurrence**.
- `npm test` : **317/317** (icônes, CSP, thème, adaptateur — tous les tests
  référençant l'ancien sigle ont été renommés avec le code).
- `npm run test:electron` : **14/14** sous xvfb (fenêtre IAO, délégation,
  Monaco sous CSP, zéro violation CSP).
- `npm run dist:linux` : `dist/IAO-linux-x64/IAO` + asar contenant
  `assets/app.js`/`assets/pre-monaco.js`/`IAO_ICONS`, 0 ancien sigle ;
  fumée 3/3.
- `npm run dist:linux:deb` : `IAO-1.0.0.deb` (116 Mo) — `Package: iao`,
  `Homepage: https://github.com/MathildeDec/IAO`, `.desktop` vérifié
  (`Name=IAO`, `StartupWMClass=IAO`, `Exec=/opt/IAO/iao`, mot-clé communautaire
  retiré).
- `npm run dist:linux:appimage` : `IAO-1.0.0.AppImage` (147 Mo) extraite
  (`--appimage-extract`) : binaire `iao`, `iao.desktop`, `iao.png`.
- Avertissement electron-builder (non bloquant, déjà présent avant le lot) :
  `desktopName` non défini — l'association fenêtre/.desktop repose sur
  `StartupWMClass=IAO` (= `app.setName('IAO')`).

### Limites / non testé

- `install.bat` (Windows) reste non exécuté (P0 existant) ; son éventuel
  contenu référence désormais `IAO-win32-x64` via les docs.
- Migration de données : aucune (le dossier `ai-manager` est conservé) ; un
  utilisateur qui renomme manuellement son dossier perdrait comptes et
  sessions — non couvert, volontaire.
