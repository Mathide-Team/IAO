# IAO

**Un poste de travail de bureau (Windows et Linux) pour utiliser plusieurs services d'IA web avec plusieurs comptes, sans jongler entre navigateurs.** Chaque compte dispose de sessions isolées (cookies séparés), chaque IA s'ouvre dans son propre **onglet** intégré, et un suivi de « cooldown » 24 h par service aide à gérer les quotas gratuits.

Publié ici pour quiconque en a l'usage.

> **Avertissement de non-affiliation** — Ce projet n'est affilié à, ni approuvé par, aucun des fournisseurs d'IA mentionnés (Anthropic/Claude, OpenAI/ChatGPT, Google/Gemini, Perplexity, Z.ai, xAI/Grok, Leonardo AI, Suno, Meshy AI). Les noms et marques citées appartiennent à leurs propriétaires respectifs et ne sont utilisés qu'à des fins d'identification.
>
> **Responsabilité d'usage** — Cet outil n'utilise aucune API : il affiche les interfaces web officielles des services dans des onglets intégrés (webviews), où vous vous connectez et interagissez vous-même, comme dans un navigateur. Vous restez seul responsable du respect des conditions d'utilisation de chaque service, notamment de leurs règles sur l'usage de plusieurs comptes.

## Aperçu

<!-- À COMPLÉTER : captures d'écran à fournir avant/après publication -->
![Vue principale — grille de comptes et onglets IA](docs/screenshot-main.png)
![Barre d'onglets — plusieurs services et comptes ouverts simultanément](docs/screenshot-tabs.png)

*(Captures à ajouter dans `docs/` — emplacements prévus ci-dessus.)*

## Fonctionnalités

- **Multi-comptes isolés** : chaque compte utilise une partition Electron dédiée (`persist:<profil>`) — cookies et sessions strictement séparés. L'unicité du profil est imposée par l'app.
- **9 services IA intégrés** : Claude, ChatGPT, Gemini, Perplexity, Z.ai, Grok, Leonardo AI (images), Suno (musique), Meshy AI (3D). En ajouter un est un pattern simple et documenté (voir [Contribuer](#contribuer)).
- **Onglets** : chaque couple (compte + service) ouvert vit dans son propre onglet, avec sa webview et sa session. On bascule d'un onglet à l'autre sans rien recharger ; rouvrir un service déjà ouvert réactive simplement son onglet. Le `×` de l'onglet détruit la webview et **libère la mémoire** du process Chromium correspondant.
- **Actions rapides sur un onglet ouvert** : recharger la page, revenir à l'accueil du service, ou se
  déconnecter du profil (purge des cookies/session du compte, avec confirmation — action destructive).
- **Suivi de quota (« cooldown »)** par service et par compte : un service en cooldown apparaît estompé et se réactive automatiquement à l'expiration (le bouton manuel « Épuiser (24h) » a été retiré, issue #136).
- **Palette rapide (Ctrl+K)** : ouvrir n'importe quel service avec n'importe quel compte au clavier.
- **Raccourcis d'onglets** : `Ctrl+Tab` / `Ctrl+Maj+Tab` pour circuler entre les onglets, `Alt+1` à `Alt+9` pour aller directement au Nᵉ. (Quand le focus est à l'intérieur d'une page IA, cliquez d'abord hors de celle-ci — Electron ne fait pas remonter les touches depuis une webview.)
- **Page d'aide intégrée** (bouton `?`) : description et cas d'usage de chaque IA, pour les utilisateurs qui ne les connaissent pas toutes.
- **Éditeur de code intégré** (Monaco, celui de VS Code) avec explorateur de fichiers local — chargé paresseusement au premier clic, avec éditeur de secours si Monaco échoue.
- **Interface 100 % locale** : polices et icônes embarquées, aucun CDN, aucune télémétrie — l'app n'envoie rien à aucun serveur ; seuls les sites des IA sont contactés, dans leurs onglets.
- **Stockage résilient** : sauvegarde automatique d'une génération des données de comptes, récupération proposée en cas de corruption.
- **Ordonnanceur IA** (bouton robot, en cours de développement) : détecte automatiquement les fichiers `.zip` livrés par les IA dans les onglets, tient un registre de jobs, et propose de reprendre un projet inachevé sur le profil disponible le plus ancien plutôt que de toujours solliciter le même compte. La partie « upload + envoi du prompt » dans le service IA n'est pas encore automatisée — la reprise se fait aujourd'hui en un clic depuis le panneau.

## Installation — Linux (Ubuntu et dérivées)

Trois voies, de la plus simple à la plus manuelle. Toutes intègrent l'application au **menu des applications** (recherche GNOME, épinglage au Dock, icône, Alt+Tab).

### A. Paquet `.deb` (recommandé)

```bash
npm install
npm run dist:linux:deb     # produit dist/IAO-1.0.0.deb
sudo apt install ./dist/IAO-1.0.0.deb
```

L'intégration au bureau est faite par le paquet lui-même (entrée `.desktop`, icônes hicolor, commande `iao`). Le sandbox Chromium est correctement configuré. Pour désinstaller :

```bash
sudo apt remove iao
```

### B. Script d'installation fourni

Utile si vous partez d'un build `electron-packager` (`npm run dist:linux`) ou si vous ne voulez pas de paquet système.

```bash
npm install
./install.sh              # installation utilisateur, sans sudo
```

Le script construit l'app si nécessaire, puis installe. Le build de `dist/` est reconstruit automatiquement s'il est absent ou plus ancien que les sources (après un `git pull`, par exemple) ; `npm install` est relancé si `package-lock.json` a changé. `--rebuild` force la construction, `--no-build` installe `dist/` tel quel. Sous `sudo`, la construction se fait sous votre compte (`sudo -u`), pour que `node_modules/` et `dist/` ne passent pas à root.

| Élément | Installation utilisateur | Installation système (`sudo ./install.sh --system`) |
| --- | --- | --- |
| Application | `~/.local/opt/iao/` | `/opt/iao/` |
| Entrée de menu | `~/.local/share/applications/` | `/usr/share/applications/` |
| Icônes (16→512 px) | `~/.local/share/icons/hicolor/` | `/usr/share/icons/hicolor/` |
| Commande | `~/.local/bin/iao` | `/usr/local/bin/iao` |
| Sandbox Chromium | désactivé (`--no-sandbox`) | activé (`chrome-sandbox` setuid root) |

Désinstallation : `./install.sh --uninstall` (ajoutez `--system` et `sudo` si l'installation était système).

> **Sandbox** : le bac à sable de Chromium exige que `chrome-sandbox` appartienne à root avec le bit setuid — impossible sans droits root. En installation utilisateur, le lanceur détecte le cas et ajoute automatiquement `--no-sandbox`. Pour bénéficier du sandbox, préférez le `.deb` ou `--system`.

### C. AppImage (sans installation)

```bash
npm run dist:linux:appimage
chmod +x dist/IAO-1.0.0.AppImage
./dist/IAO-1.0.0.AppImage
```

Un AppImage ne s'intègre pas au menu tout seul. Installez [Gear Lever](https://flathub.org/apps/it.mijorus.gearlever) ou AppImageLauncher pour l'ajouter au menu en un clic.

### Prérequis Linux

- **Ubuntu 22.04 ou 24.04** (testé), **Node.js 18+** et npm pour construire.
- Les dépendances système habituelles d'Electron sont déclarées par le `.deb` : `libgtk-3-0`, `libnss3`, `libxss1`, `libxtst6`, `libnotify4`, `libatspi2.0-0`, `libsecret-1-0`, `xdg-utils`. En cas d'erreur au lancement d'un build non packagé :

  ```bash
  sudo apt install libgtk-3-0 libnss3 libxss1 libxtst6 libnotify4 libatspi2.0-0 libsecret-1-0
  ```

- Sur **Ubuntu 24.04+**, les restrictions AppArmor sur les espaces de noms utilisateur peuvent empêcher le démarrage d'un Electron non installé en système. Symptôme : `The SUID sandbox helper binary was found, but is not configured correctly`. Correctif : utiliser le `.deb`, ou lancer avec `--no-sandbox` (ce que fait déjà le lanceur du script B).

### Lancer en développement (Linux)

```bash
git clone https://github.com/MathildeDec/IAO.git
cd IAO
npm install
npm run start:linux-dev    # electron . --no-sandbox
```

## Installation — Windows

### Utilisateur (binaire)

Récupérez le zip de la [dernière release](../../releases), décompressez le dossier **en entier**, lancez `IAO.exe`. Au premier lancement, Windows SmartScreen affiche un avertissement (exécutable non signé) : « Informations complémentaires » → « Exécuter quand même ». Voir `docs/DISTRIBUTION-LISEZ-MOI.txt` pour le détail.

### Depuis les sources

```bat
npm install
npm run dist        :: produit dist\IAO-win32-x64\
install.bat         :: installe dans %LOCALAPPDATA%\Programs et crée le raccourci du menu Démarrer
```

| Option | Effet |
| --- | --- |
| `install.bat` | Installation utilisateur, sans droits administrateur |
| `install.bat /desktop` | Ajoute un raccourci sur le Bureau |
| `install.bat /system` | Installation pour tous les comptes dans `%ProgramFiles%` — invite administrateur requise |
| `install.bat /uninstall` | Désinstallation (ajoutez `/system` si l'installation l'était) |

Le script construit l'application avec `npm run dist` si aucun build n'est présent. Les comptes et les sessions restent dans `%APPDATA%\ai-manager` et ne sont jamais supprimés.


### Développement et build

Prérequis : **Windows 10/11**, **Node.js 18+** et npm.

```bash
npm install
npm start          # lance l'app en dev (electron .)
npm test           # lance les tests unitaires (node --test, sans Electron)
npm run dist       # produit dist/IAO-win32-x64/
```

L'exe a besoin du dossier complet — pour distribuer, zippez tout le dossier. Le script purge automatiquement les locales Chromium inutilisées et les traductions Monaco (−46 Mo).

**Limitation connue (Windows)** : `electron-builder` ne fonctionne pas sans droits administrateur ou Mode développeur Windows (création de liens symboliques) — c'est pourquoi le packaging Windows passe par `@electron/packager` et qu'il n'y a ni installateur ni exe portable mono-fichier côté Windows. Sous Linux, `electron-builder` fonctionne normalement, d'où le `.deb`.

## Langue de l'interface

IAO est en français. Les autres langues (29 locales gettext dans `lang/`) se
choisissent avec `IAO_LANG=en npm start` ou `iao --iao-lang=en`. Traductions,
ajout d'une langue et CI : [docs/i18n.md](docs/i18n.md) (issue #51).

## Emplacement des données

| Plateforme | Comptes, cooldowns et sessions IA |
| --- | --- |
| Linux | `~/.config/ai-manager` |
| Windows | `%APPDATA%\ai-manager` |

Ce dossier n'est **pas** supprimé par la désinstallation — effacez-le manuellement pour repartir de zéro.

## Dépannage au démarrage

- Si un problème empêche l'interface de fonctionner, un **bandeau rouge avec une icône
  d'alerte** s'affiche en haut de la fenêtre, avec le détail de l'erreur et une piste.
- Chaque lancement écrit un **journal** dans `<dossier de données>/logs/iao.log`
  (Linux : `~/.config/ai-manager/logs/iao.log`, Windows : `%APPDATA%\ai-manager\logs\iao.log`),
  y compris quand IAO est lancé depuis l'icône du Dock ou du menu Démarrer.
- **Mode debug** (journal détaillé de toute l'application) : option `--iao-debug` ou variable
  `IAO_DEBUG=1`.
  - Lancement : `npm run start:debug` en développement, `iao --iao-debug` après `install.sh`,
    clic droit sur l'icône puis « IAO (mode debug) » (menu GNOME, installé par `install.sh`),
    ou raccourci « IAO (mode debug) » du menu Démarrer (Windows, `install.bat`).
  - Un badge **DEBUG** s'affiche alors à côté du nom de l'application.
  - Sont ajoutés au journal : versions (Electron, Chrome, Node) et options de lancement ;
    chaque appel IPC (canal, durée, succès ou erreur) ; tous les messages de l'interface
    (ouverture, activation et fermeture d'onglets, enregistrement des comptes) ; pour chaque
    onglet IA, navigations, échecs de chargement et avertissements/erreurs de la page ;
    décisions détaillées de l'ordonnanceur (téléchargements ignorés, lancements refusés).
  - Confidentialité : les **arguments** des appels IPC (contenus de fichiers, export de
    comptes, prompts) ne sont jamais écrits, et les adresses des onglets sont réduites à
    leur nom d'hôte (une URL de connexion peut contenir des jetons).
- Le journal d'activité de l'ordonnanceur et ses erreurs sont aussi écrits dans `iao.log`,
  avec ou sans mode debug.
- IAO ne s'ouvre qu'**une fois** : relancer l'application ramène la fenêtre existante au
  premier plan. Deux instances sur le même dossier de données provoquaient des erreurs
  Chromium en rafale (`Failed to delete the database: Database IO error`).
- Les messages Chromium du type `vaInitialize failed` (accélération vidéo matérielle) sont
  sans incidence sur IAO.

## Structure du projet

```
iao/
├── install.sh              # Installeur Linux (menu applications, icônes, lanceur, --uninstall)
├── install.bat             # Installeur Windows (menu Démarrer, raccourcis, /uninstall) — créé lot 9
├── index.html              # HTML pur (CSS extrait vers assets/app.css, JS vers assets/app.js + pre-monaco.js). ~356 lignes.
├── main.js                 # Process principal Electron : fenêtre, IPC fichiers, durcissement navigation/popups, ordonnanceur
├── lib/                    # Fonctions pures extraites (escapeHtml, isAllowedPopup, statuts d'activité, actions d'onglet, recherche, cooldown, claude-adapter, settings) — testées par node --test
├── scheduler/               # Ordonnanceur IA : registre de jobs, détection des ZIP livrés, reprise par profil, automatisation Claude
├── test/                   # Tests unitaires (node --test, 332 tests)
├── test-electron/          # Tests d'intégration Electron réels (popups, Continuer, Monaco sous CSP, fumée binaire) — 14 + 3 tests
├── package.json            # Scripts npm, dépendances, configuration de packaging
├── CLAUDE.md               # Règles de travail sur le dépôt (conventions, invariants, checklist)
├── FEATURES.md             # Travaux à faire, par lot et par priorité
├── README.md               # Cette page
├── LICENSE                 # MIT
├── assets/
│   ├── app.css             # Feuille de style (extrait d'index.html, lot 8) : @font-face, :root, composants UI
│   ├── app.js              # Application complète (extrait d'index.html, lot 6)
│   ├── pre-monaco.js       # Sauvegarde du require d'Electron avant le loader AMD de Monaco (lot 6)
│   ├── icons.js            # 25 icônes SVG inline (sous-ensemble Font Awesome) + hydrateIcons()
│   └── fonts/              # Polices WOFF2 locales (Space Grotesk, Inter, JetBrains Mono)
├── build/                  # Icônes de l'application (PNG 16 → 1024 px)
├── scripts/
│   └── prune-locales.js    # Post-build : purge des locales Chromium inutilisées
└── docs/
    ├── PROJECT_CONTEXT.md          # Architecture détaillée + historique des chantiers
    ├── THIRD-PARTY-NOTICES.md      # Attributions des composants tiers
    └── DISTRIBUTION-LISEZ-MOI.txt  # Notice utilisateur jointe au zip distribué
```

Pas de framework, pas de bundler, pas de TypeScript : JS vanilla, CSS et JS extraits dans `assets/`. `docs/PROJECT_CONTEXT.md` contient la documentation d'architecture complète pour qui veut contribuer.

## Sécurité et limites connues

Transparence complète — ce qui est fait, et ce qui ne l'est pas :

**Limites assumées (à connaître avant d'utiliser) :**
- Le renderer tourne avec **`nodeIntegration: true` et `contextIsolation: false`** : la page hôte a un accès complet à Node/OS. C'est la principale dette de sécurité du projet ; la migration vers `contextIsolation` + preload est un chantier identifié mais non réalisé. Les webviews des services, elles, tournent sans privilèges Node.
- **Les sessions IA (cookies) et les métadonnées de comptes sont stockées en clair** dans le dossier de données (voir tableau ci-dessus) et le `localStorage`. Aucun chiffrement au repos. Règle simple : **une session utilisateur = une personne** — n'utilisez pas l'app dans un compte partagé.
- Les binaires distribués ne sont **pas signés** (avertissement SmartScreen sous Windows ; aucun dépôt APT signé côté Linux).
- Une installation utilisateur sous Linux tourne **sans le sandbox Chromium** (voir la note ci-dessus) : c'est une protection en moins pour les pages web affichées dans les onglets. Le `.deb` et l'installation `--system` n'ont pas cette limite.
- Pas de CSP sur `index.html` (prérequis faits — zéro ressource distante — mais l'en-tête n'est pas encore posé).

**Mesures en place :**
- Échappement HTML systématique de toute donnée utilisateur injectée dans le DOM ; aucun `onclick` généré dynamiquement (délégation d'événements par `data-*`, y compris sur la barre d'onglets).
- La fenêtre hôte ne peut pas naviguer vers une URL distante ni ouvrir de fenêtre ; les popups des webviews sont filtrées par **liste blanche d'origines** (les 9 services + fournisseurs OAuth courants), tout le reste part dans le navigateur système.
- Garde-fous divers : unicité des profils (pas de partage de session accidentel), limite de taille des fichiers ouverts dans l'éditeur, stockage tolérant à la corruption avec backup.

Les issues de sécurité sont bienvenues — merci de les signaler de façon responsable.

## Contribuer

Projet maintenu en solo, contributions bienvenues — en particulier :

- **Ajouter un service IA** (le pattern est entièrement data-driven) : une entrée dans `SERVICES`, des variables de couleur `--<id>`/`--<id>-dim` + une classe `.svc-<id>`, une fiche `SERVICE_INFO` pour la page d'aide, et si besoin le domaine d'auth dans `ALLOWED_POPUP_HOSTS` (`main.js`). La migration attache automatiquement le nouveau service aux comptes existants.
- Corrections de bugs, améliorations de performance mesurées, durcissement sécurité (la migration `contextIsolation` est le gros morceau ouvert).

Règles du projet : JS vanilla sans dépendance nouvelle, toute donnée utilisateur passe par `escapeHtml()`, les écritures de comptes passent par `saveAccounts()`, les listes cliquables utilisent la délégation d'événements. Lisez `CLAUDE.md` (règles de contribution) et `docs/PROJECT_CONTEXT.md` avant une contribution non triviale. Fork → branche → pull request.

## Licence

[MIT](LICENSE). Composants tiers (polices OFL, icônes Font Awesome CC BY 4.0, Monaco MIT) : voir [docs/THIRD-PARTY-NOTICES.md](docs/THIRD-PARTY-NOTICES.md).

## Crédits

Le thème violet/rose est l'héritage des premières versions. Merci aux bêta-testeurs de la première heure.
