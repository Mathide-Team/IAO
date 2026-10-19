# Rapport de modifications — IAO (18/09/2026)

## Issue #206 — lot 2a : durcissement de la mesure (revue, 20/10/2026)

### Corrigé (suite à la revue du lot 2a fusionné)
- **La mesure ne compte que le NOUVEAU texte généré** : la dernière réponse
  présente avant l'envoi est capturée comme base de comparaison — sans elle,
  le premier poll renvoyait l'ancienne réponse et la mesure valait l'intervalle
  de poll, pas la génération. Une réponse n'est acceptée que (1) différente de
  cette base ET (2) STABLE sur deux lectures consécutives (le texte d'une
  génération en cours croît à chaque lecture) : une réponse partielle ou un
  délai dépassé ne produisent jamais de « temps de réponse réussi ».
- **Périmètre explicite** : la mesure couvre les envois passant par
  `_executeAutomation` (tâches et relances) ; les appels IPC directs
  `run-claude-job` et les envois manuels dans la webview ne sont pas
  instrumentés.
- **Écritures sérialisées** : reponses.jsonl et quotas.jsonl partent de
  chaînes de promesses distinctes (lecture → réécriture complète) — des
  notations simultanées ne s'écrasaient plus mutuellement (test : 24
  événements notés en parallèle, aucun perdu).
- **Conservation 90 jours tenue** : la purge est PERSISTÉE au chargement
  (fichier réécrit) — un événement expiré restait physiquement dans le
  fichier tant qu'aucune notation n'avait lieu.
- **Épisodes de quota dédupliqués** : au plus un événement par compte et par
  heure glissante — la boucle wait_quota re-diagnostique le même blocage sans
  envoyer ; sans déduplication, un blocage comptait pour chaque re-détection.
- **Récupération réessayable** : un échec de la récupération des sessions
  (disque plein) n'est plus mémoïsé sur son rejet — sinon tous les appels
  suivants échouaient jusqu'au redémarrage de l'app.
- Délais de poll injectables via la config (`responseTimeoutMs`,
  `responsePollIntervalMs`) : tests rapides et déterministes.
- 6 tests discriminants ajoutés (concurrence, déduplication, purge persistée,
  échec réessayé, texte croissant, délai dépassé) ; couverture 100 %.

## Issue #206 — statistiques d'utilisation, lot 2 (19/10/2026)

### Livré
- **Heures de pointe** : carte de chaleur jour × heure (heure locale, lundi en
  premier) du temps actif, réparti au prorata des tranches horaires couvertes.
- **Série** de jours consécutifs d'utilisation (en cours et record) ; une
  session à cheval sur minuit compte pour les deux jours.
- **Comptes inutilisés** sur la période, avec la dernière utilisation connue.
- **Tâches programmables par compte** (lien avec #199) : envoyées, quotas,
  erreurs (erreur + non connecté), exécutions, dernier quota et heure de fin
  rapportée. Source : l'historique des tâches (`taches:history`, 200 dernières
  exécutions). Depuis le retrait du bouton « Épuiser » (#136), plus rien
  n'alimente `cooldowns` : les quotas ne viennent que de cet historique.
- **Tri par colonne** de tous les tableaux (clic sur l'en-tête, second clic = sens
  inverse, `aria-sort`).
- `lib/stats.js` : `heuresDePointe`, `comptesInutilises`, `serieJours`,
  `resultatsTaches`, `trierLignes` (100 %, `test/stats-lot2.test.js`) ;
  harnais C11.3 ; traductions en/de/es/it/pt.

## Issue #206 — lot 2a : mesure des temps de réponse et des quotas (20/10/2026)

### Livré
- **La mesure laissée en « reste » par le lot 2** : temps de réponse et quotas.
  - temps de réponse Claude : envoi du prompt -> fin de la génération,
    mesuré dans `_executeAutomation` (le poll de réponse existant) ;
  - quotas atteints : notés quand `runClaudeJob` détecte le quota
    (cooldown) — couvre jobs ET tâches programmables ;
  - tout reste local (`<userData>/stats/reponses.jsonl` et
    `quotas.jsonl`, 90 jours, plafond 130 000 événements par type,
    jamais bloquants pour l'envoi).
- `lib/stats.js` (pur, testé) : `normaliserReponse`/`normaliserQuota`,
  `agregerReponses` (médiane/min/max par compte et service),
  `agregerQuotas` (répartition par heure de la journée),
  `classerComptes` (sous-utilisés / **surchargés** — la moitié
  « surchargés », alimentée par les quotas, est nouvelle) ;
  `purger` généralisé (champ `fin` ou `date`), `parserJsonl` typé.
  (`carteHeures` retirée : doublon de `heuresDePointe` du lot 2.)
- IPC : `stats:noter-reponse`, `stats:noter-quota`, `stats:reponses`,
  `stats:quotas` ; `scheduler.statsStore` câblé dans `main.js`.

## Issue #206 — statistiques d'utilisation, lot 1 (19/10/2026)

### Livré
- **Mesure locale** des sessions d'onglet : durée d'ouverture et **temps actif**
  (onglet au premier plan ET fenêtre IAO au focus), par compte (profil) et par
  service. `lib/stats.js` (pur, 100 %) : suivi, agrégation, JSONL, conservation.
- **Persistance** dans `<userData>/stats/` : `sessions.jsonl` (90 jours, purgé au
  démarrage, lignes abîmées ignorées une à une) et `en-cours.json` (instantané
  des onglets ouverts, synchronisé à chaque fermeture d'onglet et toutes les
  minutes). Fermeture brutale ou page rechargée : les sessions ouvertes sont
  versées à l'historique, perte maximale d'une minute, sans doublon (par id).
- **Page Statistiques** (bouton « graphique » de la barre du haut) : périodes
  Aujourd'hui / 7 / 30 / 90 jours ; totaux (temps actif, durée ouverte,
  sessions) ; tableaux par compte (dernière utilisation) et par service (part
  du temps actif). Une session à cheval sur le début de période n'y compte que
  pour sa partie incluse. Noms échappés (`escapeHtml`).
- Aucune télémétrie, aucun appel réseau ; canaux IPC `stats:sync` et
  `stats:load`. Icône Font Awesome Free 6.5.0 `chart-simple`.
- Tests : `test/stats.test.js` (100 %), harnais Electron C11.1/C11.2 ;
  traductions anglaises.

### Reste (lots suivants de #206)
- Lot 2 : messages envoyés et tâches programmables (lien avec #199).
- Lot 3 : graphiques d'évolution, export CSV/JSON, remise à zéro depuis l'interface.
## Fermeture d'onglet : bandeau « Invalid guestInstanceId » (19/10/2026)

- Fermer un onglet IA chargé affichait le bandeau rouge « IAO a rencontré un
  problème — Invalid guestInstanceId ». Bug d'Electron (suppression d'une
  `<webview>` chargée, electron/electron#54089), corrigé en 43.7.4 : Electron
  passe de 43.7.2 à **43.8.0** (même branche majeure).
- Test de non-régression : harnais Electron C12.1.

## Issue #184 (suite) : nettoyage des Service Worker des partitions (19/10/2026, durci)

### Livré
- **Piste de #184 mise en œuvre (mesure d'atténuation, cause exacte non
  démontrée)** : `cleanupServiceWorkerStorage()` ne nettoyait que le dossier
  `Service Worker` de la fenêtre principale — chaque partition d'onglet
  (`persist:<profile>`, `Partitions/<profile>/`) a le sien. Les partitions
  n'étaient pas couvertes par le nettoyage.
- `dossiersServiceWorkerANettoyer()` (`lib/startup-storage.js`, pur, testé —
  ne lève jamais) : liste les dossiers `Service Worker` existants (fenêtre
  principale + une entrée par partition **réelle**). `main.js` les supprime
  tous AVANT la création de la fenêtre (donc avant l'ouverture des bases
  Chromium) ; journal : une ligne par dossier nettoyé.
- **Durcissement (revue)** : une erreur sur un dossier n'interrompt pas les
  autres (`nettoyerDossiersServiceWorker()`, testé) ; les liens symboliques
  et entrées illisibles de `Partitions/` sont ignorés (périmètre garanti au
  dossier de données) ; un dossier `Local Storage`/`Cookies` n'est jamais
  touché (test sur arborescence réelle).
- **À valider sur la machine de #58/#59** : les rafales doivent disparaître.
  Si elles persistent, la cause est ailleurs (droits — voir #197 — ou verrou
  d'instance) : joindre `logs/iao.log`.

## Issue #51 — i18n : allemand, espagnol, italien, portugais complets (19/10/2026)

### Livré
- **403/403 messages traduits** dans `lang/de.po` (#224), `lang/es.po`
  (#225 — espagnol ajouté aux locales, 30e langue), `lang/it.po` (#226) et
  `lang/pt.po` (#227), lot 4 des tâches (#199) inclus.
- Traductions produites par l'agent (docker25200), chaîne par chaîne,
  terminologie UI cohérente, placeholders `{…}` préservés — **relecture
  humaine attendue** (convention #51, mentionnée dans chaque en-tête de
  catalogue et chaque PR).
- Test LINGUAS mis à jour (30 locales). `msgfmt --check` propre,
  `i18n:check` vert, interface vérifiée dans chaque langue au lancement
  (`IAO_LANG=de|es|it|pt`).

## Issue #199 — lot 4 : interface des tâches programmables (19/10/2026)

### Livré
- **Modale ordonnanceur** : l'interface des tâches remplace le bandeau « en
  cours de développement » du lot 1 — liste des tâches (nom échappé, comptes,
  répartition, périodicité, prochaine exécution, boutons Activer/Désactiver,
  Exécuter maintenant, Modifier, Supprimer avec confirmation), historique
  borné aux 200 derniers événements (libellés traduits : lancée, envoyée,
  quota, heures calmes, non connecté, aucun compte éligible, erreur).
- **Formulaire de création/édition** : nom, comptes (tous ou sélection,
  seuls les comptes avec Claude sont proposés), répartition (tous avec
  espacement en secondes, ou rotation), nouvelle session, prompt,
  programmation (unique `datetime-local` ou périodique N unités), actif.
  Erreurs du service affichées dans le formulaire sans le fermer ; la saisie
  survit au rafraîchissement de 4 s (le formulaire n'est jamais reconstruit
  par le polling). L'édition préserve l'état d'exécution (le service garde
  `derniereExecution`/`indexRotation`) ET les valeurs exactes des champs
  inchangés : un espacement en ms non rond (90050) ou une date à la
  milliseconde ne sont ni arrondis ni tronqués (`preserverValeursNonModifiees`,
  testé). Sous-titre de la modale adapté au flux actif ; dates formatées
  dans la langue active (`document.documentElement.lang`).
- `lib/taches-ui.js` (pur, testé par `test/taches-ui.test.js`) : conversions
  sans perte à la seconde près `datetime-local` <-> ISO (heure locale, jamais
  `toISOString().slice()`), espacement secondes <-> ms, mapping
  formulaire <-> tâche, descripteurs de programmation et résultats. Codes
  d'erreur (pas de français dans le helper) traduits côté app par des
  appels `N_()`/`_()` littéraux.
- **« Exécuter maintenant »** : même chemin que la minuterie — la garde du
  moteur est prise AVANT l'appel au service (`taches:run-now` marque la tâche
  côté service), plan construit par le service (même forme que
  `taches:dues`), exécuté par `creerMoteur` (`lib/taches-runner.js`) :
  minuterie et exécution manuelle partagent la même garde, jamais deux plans
  en même temps. Le résultat arrive par l'historique (`taches:report`),
  jamais fabriqué par l'interface (toast neutre).
- Harnais Electron C10 (8 scénarios) : interface visible, création avec nom
  HTML (échappé), saisie préservée au polling, édition, bascule d'activation,
  exécution manuelle avec envoi réel simulé (canal `scheduler:run-claude-job`
  remplacé côté main, tout le reste réel) jusqu'à l'historique, suppression
  avec confirmation, erreurs de prévalidation ET du service affichées sans
  fermer le formulaire.
- i18n : 79 nouveaux msgid extraits, catalogues régénérés (29 langues,
  nouvelles chaînes non traduites par défaut — à traduire au fil de l'eau).

## Issue #201 — comptes en série, côté IAO (18/10/2026)

### Livré
- **Réglages** : préfixe et domaine des adresses e-mail, adresse du webmail
  (Roundcube) ; normalisés dans `lib/settings.js` (invalide -> non configuré,
  URL http/https seulement).
- **Création en série** (bouton « personnes » de la liste des comptes) : 1 à 50
  comptes, nom = numéro suivant le plus grand existant (noms numériques et
  profils `profil_<n>`), profil `profil_<n>`, e-mail `<préfixe><n>@<domaine>`,
  tous les services ; `lib/comptes-serie.js` (pur, 100 %).
- **Mot de passe de messagerie** : 20 caractères aléatoires
  (`crypto.getRandomValues`, tirage sans biais, sans caractères ambigus),
  généré pour chaque compte de la série ou à la demande (bouton clé) ; masqué
  dans la fenêtre du compte, bouton œil pour l'afficher. Stocké par
  `lib/coffre-secrets.js` : chiffré par `safeStorage` (trousseau du système),
  `<userData>/secrets.json` en 0600, **jamais en clair** ; refusé si le
  chiffrement n'est pas disponible (Linux sans trousseau : backend `basic_text`),
  avec un message.
- **Webmail** : bouton enveloppe sur chaque carte quand l'URL est réglée ;
  copie l'adresse du compte et ouvre le webmail dans le navigateur. Le process
  principal n'ouvre **que l'URL des réglages** (`app:open-webmail`, jamais une
  URL fournie par l'interface).
- Le clic sur l'e-mail copiait déjà l'adresse (#138).
- Icônes Font Awesome Free 6.5.0 ajoutées : `eye`, `eye-slash`, `key`,
  `envelope`, `users`.
- Tests : `comptes-serie`, `coffre-secrets` (100 %), réglages, harnais Electron
  C8.1/C8.2 ; traductions anglaises.

### Reste
- Création des boîtes sur le serveur de messagerie (docker-mailserver, sans
  API HTTP) : petite API à créer dans un autre dépôt, puis appel depuis IAO.

## Issue #203 — état du dossier de données au démarrage (18/10/2026)

Le journal `<userData>/logs/iao.log` existait déjà (#52, #162). Cette ligne y est
écrite à chaque démarrage, **hors mode debug**, pour les bugs signalés avec
journal (#184, #186). Elle complète #196 (comptes lus au démarrage) et #197
(fichiers appartenant à un autre utilisateur) sans les dupliquer.

### Livré
- `lib/startup-storage.js` (pur, fs injecté, 100 %) : dossier utilisé, Local
  Storage (fichiers, octets), partitions et partitions ayant un dossier
  `Service Worker` ; erreurs d'inspection en avertissements, jamais levées.
- Piste #184 : `cleanupServiceWorkerStorage()` ne nettoie que le dossier
  `Service Worker` de la fenêtre principale ; le compte des partitions qui en
  ont un dira s'il faut étendre le nettoyage.
- Tests : `test/startup-storage.test.js`, `main-debug` (#203), harnais Electron
  C1.1b (ligne présente dans le vrai `iao.log`).

## Issue #199 — lot 3 : exécution des tâches programmables (18/10/2026)

### Livré
- `scheduler/taches-service.js` (process principal, 100 % couvert) : tâches dans
  `<userData>/scheduler/taches.json` (écriture atomique), historique borné à 200
  entrées (`taches-historique.json`), création/remplacement/suppression/activation ;
  `dues(comptes)` remet le plan des tâches dues et les marque **exécutées aussitôt**
  (jamais deux départs) ; **heures calmes** 15h–20h30 : rien ne part, la tâche
  reste due ; « Exécuter maintenant » ; comptes exclus notés (service absent,
  profil introuvable) ; canaux IPC `taches:*`.
- `lib/taches-runner.js` (renderer, 100 % couvert) : minuterie toutes les 30 s,
  un plan et un compte à la fois, délais d'espacement, ouverture de l'onglet
  (nouvelle session `claude.ai/new`, rechargée si l'onglet existait), envoi par
  l'automatisation Claude existante (`scheduler:run-claude-job` : diagnostic,
  quota, délai anti-détection), jusqu'à 6 tentatives espacées de 10 s tant que
  la page n'est pas prête, compte rendu (envoyé, quota, heures calmes, non
  connecté, erreur).
- Une tâche ne s'exécute que si IAO est ouvert ; une exécution manquée est
  rattrapée **une fois** à l'ouverture suivante.

### Reste
- lot 4 : interface (liste, édition, « Exécuter maintenant », historique, i18n).

## Issue #199 — lot 1 : ancien ordonnanceur désactivé (18/10/2026)

### Livré
- L'ancien flux (détection des ZIP, jobs, projets) est **désactivé par défaut** :
  `Scheduler.setEnabled(true)` est refusé et journalisé, aucune partition n'est
  surveillée (`will-download`). Le panneau « Ordonnanceur IA » affiche un bandeau
  et masque le bouton Démarrer et les sections de l'ancien flux ; le journal
  d'activité reste visible.
- `IAO_ORDONNANCEUR_ANCIEN=1` (`true`, `yes`, `on`) le réactive (retour arrière,
  tests du code conservé). Code, `jobs.json` et `projects.json` sont conservés.
- `getState()` expose `ancienFlux`. Tests : `test/scheduler-ancien-flux.test.js`,
  harnais Electron C3.4 réécrit (bandeau, refus par IPC) ; les tests de l'ancien
  flux le réactivent explicitement.

## Issue #199 — tâches programmables, lot 2 : cœur pur (18/10/2026)

Remplacement prévu de l'ordonnanceur (ZIP, jobs, projets) par des **tâches
programmables** dans le menu « Ordonnanceur ». Conception validée dans #199.

### Livré
- `scheduler/taches.js` (fonctions pures, 100 % couvert, `test/scheduler-taches.test.js`) :
  - registre **modulaire** de fournisseurs (`enregistrerFournisseur`), Claude seul
    pour commencer (nouvelle session `https://claude.ai/new`) ;
  - `normaliserTache` : nom, fournisseur, comptes (« tous » ou liste de profils),
    répartition (« tous » espacés de N ms, ou « rotation » : un compte par exécution
    à tour de rôle), nouvelle session, prompt, programmation, **inactive à la création** ;
  - programmation « unique » (date/heure) ou « periodique » (toutes les N
    minutes/heures/jours/semaines/mois, minimum 5 minutes) ; `prochaineEcheance` :
    **une** exécution de rattrapage après une absence, jamais de rafale ; mois
    calendaires (31 janvier + 1 mois → fin février) ;
  - `comptesEligibles` (service absent, profil introuvable), `planExecution`.
- Inventaire de couverture (#101) : `scheduler/taches.js` ajouté.

### Reste (lots suivants de #199)
- lot 3 : exécution (minuterie, onglet nouvelle session, envoi du prompt par
  l'automatisation Claude existante, heures calmes 15 h – 20 h 30, historique) ;
- lot 4 : interface (liste, édition, « Exécuter maintenant », historique, i18n 29 langues).

## Issue #187 — mode debug accessible depuis l'application (17/10/2026)

### Livré
- Canal `app:relaunch-debug` (fenêtre principale uniquement) : `app.relaunch()` avec les mêmes
  arguments plus `--iao-debug` (`debugRelaunchArgs()`, `lib/startup-diagnostics.js`), puis
  `app.exit(0)`. Canal `app:log-path` : chemin du journal.
- Bandeau d'erreur de démarrage : bouton « Relancer en mode debug » et chemin du journal.
- Barre du workspace : bouton « Redémarrer en mode debug », masqué quand le mode debug est actif.
- Documentation (README, section Dépannage reprise par MkDocs) : relance depuis l'application,
  que joindre à une issue.
- Tests : unitaires (couverture 100 %), harnais main.js, scénario Electron C6.5.

## Issue #184 — diagnostic du propriétaire des fichiers de données (17/10/2026)

### Hypothèse
`Failed to delete the database: Database IO error` et `Could not open the quota database,
resetting` signifient que Chromium ne peut ni supprimer ni rouvrir ses bases. Hors seconde
instance (déjà empêchée depuis #52), la cause connue est un fichier que le compte courant
ne peut pas modifier, par exemple créé par un lancement en root. Ce cas expliquerait aussi
la perte des comptes de #186.

### Livré
- `lib/data-dir-check.js` (testé, système de fichiers injecté) : parcours borné du dossier de
  données (20 000 entrées, profondeur 6, caches Chromium ignorés), sans aucune modification.
- `main.js` : au démarrage, un `warning` dans `iao.log` donne le nombre de fichiers concernés,
  des exemples et la commande `sudo chown -R "$USER": <dossier>`.
- README (section Dépannage, reprise dans la doc MkDocs).

## Issue #185 — pas de bandeau rouge sur une navigation remplacée (17/10/2026)

### Cause
Sur un service sans compte, le site redirige vers sa page de connexion pendant le
premier chargement. Chromium interrompt la navigation (`ERR_ABORTED`, code -3) et la
promesse interne de la `<webview>` est rejetée sans être rattrapée : le bandeau
« Une opération asynchrone a échoué au démarrage » s'affichait pour une situation normale.

### Livré
- `lib/startup-diagnostics.js` : `isNavigationAbort(err)` reconnaît `ERR_ABORTED` (-3),
  et seulement lui (`ERR_NAME_NOT_RESOLVED`, certificat, hors ligne restent signalés).
- `assets/boot-guard.js` : un rejet `ERR_ABORTED` n'affiche plus de bandeau ; une ligne
  `console.info` est écrite (recopiée dans `logs/iao.log` en mode debug).
- `assets/app.js` : le retour à l'accueil d'un onglet rattrape le rejet de `loadURL()`.
- Tests : unitaires (couverture 100 %), scénario Electron C0.3 (rejet `ERR_ABORTED`
  sans bandeau, vraie erreur réseau avec bandeau).

### Écart avec l'issue
L'issue prévoyait une ligne `info` toujours présente dans le journal. `main.js` ne recopie
le niveau `info` du renderer qu'en mode debug (règle de #162) ; la ligne n'apparaît donc
dans `iao.log` qu'avec `--iao-debug`. Changer cette règle sortirait du périmètre.

## Documentation MkDocs (13/10/2026)

Règle d'équipe Mathide-Team : documentation navigable MkDocs sur le modèle de Netcross.

### Livré
- `mkdocs.yml` (thème Material, français, navigation explicite, sans `site_url`).
- Pages sous `docs/` : accueil, installation, données et dépannage, langue,
  développement, contexte du projet, travaux à faire, historique.
- Sans copie : les pages incluent des sections du README, `FEATURES.md` et
  `CHANGES.md` (`pymdownx.snippets`, repères invisibles sur GitHub) ; une section
  disparue fait échouer la construction.
- CI : job « Construction (mkdocs build --strict) » sur les runners maison, site
  publié en artefact.
- README : lien « dernière release » en URL absolue (valable dans la doc et sur GitHub).

## Issue #186 — comptes absents au démarrage : journal et restauration (17/10/2026)

### Constat
Journal de #58 (12/10/2026) : au lancement, l'ordonnanceur connaissait ~70 profils
(`<userData>/scheduler/accounts-snapshot.json`), alors que l'interface n'en lisait aucun
dans son `localStorage`. Ensuite, l'interface renvoyait sa liste vide à l'ordonnanceur
et effaçait l'instantané : un import devenait la seule issue. La cause de la perte du
`localStorage` n'est pas reproduite dans le bac à sable.

### Livré
- `lib/accounts-recovery.js` (pur, testé) : `accountsFromSnapshot()` reconstruit les
  comptes (id, nom, profil, automatisation ; doublons de profil écartés) ;
  `startupAccountsReport()` écrit la ligne de journal et décide de la proposition.
- Ordonnanceur : `reportStartupAccounts()` et canal `scheduler:accounts-startup`. La ligne
  « Comptes lus au démarrage : N (stockage de l'interface : …) ; instantané de
  l'ordonnanceur : M compte(s). » part toujours dans `iao.log` (`warning` si N = 0 et M > 0).
- Interface : une liste vide au démarrage n'écrase plus l'instantané ; modale « Comptes
  retrouvés » qui restaure les comptes sans import. Les sessions sont conservées
  (partitions `persist:<profil>`) ; l'e-mail est à compléter.
- Tests : unitaires (couverture 100 %), scénarios Electron C8.1 et C8.2.

## Issue #181 — IAO démarre sans l'ordonnanceur (12/10/2026)

### Cause
`scheduler.init()` branchait la surveillance des téléchargements de tous les profils
au lancement et reprenait l'état « activé » de la session précédente.

### Livré
- Au lancement, l'ordonnanceur est toujours **arrêté** (un état « activé » persisté
  est remis à « arrêté ») et aucune partition n'est surveillée.
- Fenêtre Ordonnanceur : l'interrupteur est remplacé par un bouton **Démarrer /
  Arrêter** et un état « Arrêté / En marche ». Démarrer branche la surveillance des
  profils ; Arrêter retire réellement les écouteurs `will-download`.
- Tests : unitaires (couverture 100 %), scénario Electron C3.4, fumée du binaire
  packagé alignée sur le nouveau message.
- CI sur les runners « maison » : gettext installé s'il manque (`i18n.yml`) ;
  harnais Electron sans réinstallation si les bibliothèques sont déjà présentes,
  et `sudo -n` (échec immédiat et message clair au lieu de `sudo: timed out`
  sur la VM `ubuntu`, où sudo demande un mot de passe).

## Issue #7 (partie sommes de contrôle) — SHA256SUMS.txt des fichiers publiés (10/10/2026)

### Cause
`release.yml` hachait `dist/*.exe` sous Windows alors que l'exécutable est dans
`dist/IAO-win32-x64/` (liste vide), au format `Format-List` incompatible avec
`sha256sum -c` ; le zip Windows réellement publié n'était jamais haché.

### Livré
- Job « release » : `SHA256SUMS.txt` unique, au format `sha256sum`, calculé sur les
  fichiers publiés (`.deb`, `.AppImage`, zip Windows) après création du zip, puis
  vérifié par `sha256sum -c` ; échec si un artefact manque.
- Étapes de hachage par OS supprimées ; notes de release : commande de vérification.
## Issue #165 — install.sh réinstallait un build périmé (10/10/2026)

### Cause
`install.sh` ne lançait `npm run dist:linux` que si `dist/` était vide. Après un
`git pull`, il recopiait donc le build du premier lancement : icônes absentes, menu
natif visible, `--iao-debug` inconnu — les correctifs de `dev` n'étaient jamais installés.

### Livré
- `install.sh` : reconstruction automatique si une source embarquée (`main.js`,
  `preload.js`, `index.html`, `package*.json`, `assets/`, `lib/`, `scheduler/`, `lang/`)
  est plus récente que l'exécutable du build ; `npm install` relancé si
  `package-lock.json` est plus récent que `node_modules/.package-lock.json`.
- Options `--rebuild` (force) et `--no-build` (installe `dist/` tel quel).
- Sous `sudo`, la construction est déléguée au compte appelant (`sudo -u "$SUDO_USER"`) ;
  en root sans `SUDO_USER` (conteneur, runner CI), `npm install` reste refusé comme avant,
  `npm run dist:linux` est permis si les dépendances sont à jour.

### Tests
- `test/install-sh.test.js` : le vrai `install.sh` dans un projet temporaire avec un faux
  `npm` (build absent, à jour, périmé, `package-lock.json` modifié, refus de `npm install` en root,
  `--no-build`, `--rebuild`) ; passe en compte normal comme sur les runners root.

## Issue #51 (lot 4) — HTML construit par app.js traduisible (09/10/2026)

### Livré
- `assets/app.js` : `_()` dans le HTML construit (état vide et cartes de comptes,
  barre d'outils et menu des onglets, aide des services, éditeur de secours,
  ordonnanceur : jobs, projets, tâches, invites, notification de fin de cooldown) ;
  `N_()` pour les tables construites avant le catalogue (`SERVICE_INFO`, libellés
  d'état), traduites au rendu. Boutons « modifier » et « supprimer » des cartes : `title`.
- `scripts/i18n-update.sh` : mot-clé `N_`.
- Catalogues : 267 chaînes (112 nouvelles), toutes traduites en anglais.

### Tests
- Harnais Electron C7.2 : aide des services et carte de compte en anglais.

## Issue #51 (lot 3) — Réglage « Langue », langue du système (09/10/2026)

### Livré
- `lib/i18n.js` : `preferredLocales` (demande explicite, réglage, langues du système).
- `lib/settings.js` : réglage `language` (`auto` par défaut, code de locale validé sans
  liste codée en dur).
- `main.js` : `i18n:catalog` lit le réglage et `app.getPreferredSystemLanguages()`
  (repli `app.getLocale()`), renvoie le réglage courant.
- Réglages : liste « Langue » (« Langue du système » + catalogues livrés, nommés dans
  leur langue), appliquée au prochain démarrage.

### Comportement
Sans `IAO_LANG` ni réglage, l'interface suit désormais la langue du système (anglais
sur un bureau anglophone) ; chaîne non traduite : français.

### Tests
- `settings`, `i18n` (`preferredLocales`), `main-harness` (ordre de priorité, replis).
- Harnais Electron : scénarios en `IAO_LANG=fr`, C7.3 (langue du système, sélecteur).

## Issue #51 (lot 2) — Libellés construits par app.js traduisibles (09/10/2026)

### Livré
- `lib/i18n.js` : `formatMessage(gabarit, paramètres)` (marqueurs `{nom}`, 100 % couvert).
- `assets/app.js` : fonction `_()` (relit `window.iaoT`) sur les 78 toasts, le titre de
  la fenêtre de résultat et la fenêtre de récupération des comptes ; concaténations et
  littéraux de gabarit remplacés par des marqueurs nommés (76 nouvelles chaînes).
- Catalogues régénérés : 151 chaînes, toutes traduites en anglais.

### Tests
- `test/i18n.test.js` : `formatMessage`, garde « aucun toast littéral » dans `app.js`.
- Harnais Electron C7.2 : toast « Fill in all the fields » avec `IAO_LANG=en`.

### Reste à faire
Cartes de comptes et listes de l'ordonnanceur (HTML généré), sélecteur de langue,
bascule automatique sur la langue du système, relecture des traductions.

## Issue #51 (lot 1) — Internationalisation gettext, 29 locales (08/10/2026)

### Livré
- `lang/LINGUAS` (seule liste des 29 locales), `lang/messages.pot`, `lang/<xx>.po`,
  `lang/<xx>/LC_MESSAGES/iao.mo`.
- `lib/i18n.js` (pur, 100 % couvert) : lecture `.mo`, `Plural-Forms` évalué sans `eval`
  (CSP), `gettext`/`ngettext`/`pgettext`, négociation de locale, extraction HTML.
- `main.js` : canal `i18n:catalog`. `assets/app.js` : traduction du DOM statique,
  `window.iaoT()` pour les lots suivants.
- `scripts/i18n-update.sh` (`npm run i18n:update` / `i18n:check`) : `xgettext` +
  extracteur HTML, `msgmerge` (traductions conservées), `msgfmt --check`, compilation,
  rapport par locale.
- `.github/workflows/i18n.yml` : vérification CI + PR automatique
  « chore(i18n): update translation catalogs » sur `dev`.
- Anglais : les 75 chaînes de l'interface statique (à relire).
- Doc : `docs/i18n.md`.

### Comportement
Français par défaut (inchangé). Autre langue : `IAO_LANG=en` ou `--iao-lang=en`.

### Tests
- `test/i18n.test.js` (24 tests), `main-harness` (canal `i18n:catalog`, repli si `.mo` corrompu).
- Harnais Electron `ui-flows` : C7.1 (français par défaut), C7.2 (`IAO_LANG=en` traduit
  textes, `title`, `placeholder`, icônes intactes).

### Reste à faire (lots suivants)
Libellés construits par `assets/app.js` via `window.iaoT()`, sélecteur de langue dans
les réglages, bascule automatique sur la langue du système, relecture des traductions.

## Correctif #165 — Démarrage difficile : --debug obsolète, sandbox, Database IO error (07/10/2026)

### Causes
1. **`--debug` obsolète** : Node.js intercepte `--debug` comme flag DEP0062 et affiche
   un avertissement au lieu de le passer à l'application. Le mode debug (#162)
   ne s'activait donc jamais via la ligne de commande.
2. **Sandbox Linux en dev** : `npm run start` (sans `--no-sandbox`) crashait sur
   Linux quand `chrome-sandbox` n'est pas setuid root (cas en développement).
3. **Spam « Database IO error »** : les bases de données de service workers de
   Chromium peuvent rester dans un état incohérent après un arrêt brutal,
   provoquant des rafales d'erreurs au démarrage suivant.

### Correctifs
- Renommage du flag `--debug` en `--iao-debug` dans toute l'application
  (`startup-diagnostics.js`, `package.json`, `install.bat`, `README.md`, tests).
  `IAO_DEBUG=1` reste inchangé. `--debug` toujours accepté en compatibilité.
- `package.json` : `start` et `start:debug` incluent `--no-sandbox` (dev).
- `main.js` : `cleanupServiceWorkerStorage()` supprime le dossier `Service Worker`
  avant l'initialisation de Chromium, prévenant le spam « Database IO error ».

### Tests
- `test/startup-diagnostics.test.js` : `isDebugEnabled` accepte `--iao-debug`,
  `--debug` (compat) et `IAO_DEBUG`.
- `test/debug-trace.test.js` : `describeRuntime` avec `--iao-debug`.
- `npm test` : à vérifier.

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
