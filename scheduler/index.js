'use strict';

// scheduler/index.js — orchestration Electron de l'ordonnanceur IA (chantier
// E, FEATURES.md « Ordonnanceur »). S'appuie sur scheduler/core.js pour toute
// la logique pure (états, sélection de profil, CSV) ; ce fichier ne fait que
// du fs/session/IPC.
//
// PÉRIMÈTRE DE CE LOT (voir FEATURES.md pour le détail) :
//   ✅ Registre de jobs persistant (JSON + export CSV, ordo point 1)
//   ✅ Détection automatique des téléchargements .zip par profil (ordo point 1)
//   ✅ Sélection du profil le plus ancien > seuil configurable (ordo point 4)
//   ✅ Cycle de vie manuel d'un job (continuer / pause / reprendre / relancer /
//      marquer livré / ouvrir le ZIP) piloté depuis le panneau « Ordonnanceur »
//   ✅ Journal d'activité persistant
//   ❌ PAS dans ce lot : la fenêtre d'automatisation dédiée
//      (createAutomationWindow), l'upload du ZIP par CDP et l'envoi du prompt
//      dans le service IA (ordo points 5-6). Cette partie dépend fortement de
//      chaque interface web (Claude/ChatGPT/Gemini/…) et n'a pas pu être
//      testée dans cet environnement de développement (pas d'affichage, pas
//      d'accès réseau aux services IA depuis le bac à sable où ce lot a été
//      écrit). Elle reste documentée comme prochaine étape dans FEATURES.md,
//      avec le squelette d'adaptateurs déjà esquissé ci-dessous en commentaire
//      pour ne pas repartir de zéro :
//
//        const AUTOMATION_ADAPTERS = {
//          claude:     { fileInputSelector: 'input[type="file"]', promptSelector: 'div[contenteditable="true"]' },
//          chatgpt:    { fileInputSelector: 'input[type="file"]', promptSelector: '#prompt-textarea' },
//          gemini:     { fileInputSelector: 'input[type="file"]', promptSelector: 'div[contenteditable="true"]' },
//          perplexity: { fileInputSelector: 'input[type="file"]', promptSelector: 'textarea' }
//          // + repli générique pour zeta/grok/leonardo/suno/meshy.
//        };
//        // Upload : session.webContents.debugger (CDP) -> DOM.getDocument +
//        // DOM.querySelector + DOM.setFileInputFiles (un <input type="file">
//        // ne peut PAS recevoir de fichier via un simple executeJavaScript,
//        // c'est une restriction navigateur volontaire).
//        // Prompt + envoi : executeJavaScript suffit (pas de restriction
//        // équivalente sur un contenteditable/textarea).

const path = require('path');
const fs = require('fs');

const core = require('./core');
// Adaptateur Claude.ai (lot 18/09/2026, points 7-8, 10-13) : fonctions pures
// pour la détection d'éléments de page, l'injection de prompt, l'upload de
// fichier et la collecte de réponse. Chargé côté main.js car c'est ici que
// se fait l'orchestration CDP/executeJavaScript avec les <webview>.
const claudeAdapter = require('../lib/claude-adapter');

class Scheduler {
  constructor(electronApp, electronSession) {
    this._app = electronApp;
    this._session = electronSession;

    this.dir = path.join(this._app.getPath('userData'), 'scheduler');
    this.jobsPath = path.join(this.dir, 'jobs.json');
    this.csvPath = path.join(this.dir, 'jobs.csv');
    this.configPath = path.join(this.dir, 'config.json');
    this.accountsPath = path.join(this.dir, 'accounts-snapshot.json');
    this.logPath = path.join(this.dir, 'activity.json');
    this.projectsPath = path.join(this.dir, 'projects.json');

    this.jobs = [];
    this.config = { ...core.DEFAULT_CONFIG };
    this.accountsSnapshot = [];
    this.log = [];
    this.projects = [];
    this.jobSeq = 0;
    this.projectSeq = 0;
    this.taskSeq = 0;
    this.watchedPartitions = new Set();
    // Référence aux webviews ouvertes (pour l'automatisation Claude) :
    // Map<profile, webContents> mise à jour par le renderer via IPC.
    this._openWebviews = new Map();

    // Heures calmes injectables (lot 18/09/2026, correctif suite au test
    // Electron réel) : par défaut les fonctions pures de core.js, mais
    // remplaçables (notamment par les tests) pour rendre le comportement
    // déterministe quelle que soit l'heure d'exécution — avant ce correctif,
    // `npm test` exécuté entre 15h00 et 20h30 (heure de Paris) échouait sur
    // 3 tests de test/scheduler-automation.test.js et ne terminait jamais
    // (le report d'automatisation pose un setTimeout de plusieurs heures qui
    // retenait le process en vie).
    this.quietHoursCheck = core.isFrenchQuietHours;
    this.quietHoursRemainingMs = core.quietHoursRemainingMs;

    // Issue #162 : journal commun de main.js (terminal + iao.log), injecté
    // par setLogger(). Sans lui (tests, usage autonome), repli sur la console.
    this._logFn = null;
    this._debugEnabled = false;

    this._ensureDirSync();
    this._loadSync();
  }

  // Issue #162 : branche l'ordonnanceur sur le journal de main.js.
  // `logFn(scope, level, message)` ; `debug` active les traces _debug().
  setLogger(logFn, debug) {
    this._logFn = typeof logFn === 'function' ? logFn : null;
    this._debugEnabled = Boolean(debug);
  }

  _error(message, ...details) {
    if (this._logFn) {
      const text = details.map(d => (d && d.message ? d.message : String(d))).join(' ');
      this._logFn('scheduler', 'error', message + (text ? ' ' + text : ''));
    } else {
      console.error('[scheduler] ' + message, ...details);
    }
  }

  // Trace détaillée, uniquement en mode debug (--iao-debug ou IAO_DEBUG=1).
  _debug(message) {
    if (this._debugEnabled && this._logFn) this._logFn('scheduler', 'debug', message);
  }

  init() {
    this.accountsSnapshot.forEach(acc => this._watchPartition(acc.profile));
    this._logActivity('Ordonnanceur démarré (' + (this.config.enabled ? 'activé' : 'désactivé') + ').');
  }

  // --- Persistance ---------------------------------------------------------

  _ensureDirSync() {
    fs.mkdirSync(this.dir, { recursive: true });
  }

  _readJSONSync(file, fallback) {
    try { return JSON.parse(fs.readFileSync(file, 'utf-8')); }
    catch (_) { return fallback; }
  }

  _loadSync() {
    this.config = { ...core.DEFAULT_CONFIG, ...this._readJSONSync(this.configPath, {}) };
    this.jobs = this._readJSONSync(this.jobsPath, []);
    this.accountsSnapshot = this._readJSONSync(this.accountsPath, []);
    this.log = this._readJSONSync(this.logPath, []);
    this.projects = this._readJSONSync(this.projectsPath, []);
    this.jobSeq = this.jobs.reduce((max, j) => {
      const m = /^job_(\d+)$/.exec(j.id || '');
      return m ? Math.max(max, parseInt(m[1], 10)) : max;
    }, 0);
    this.projectSeq = this.projects.reduce((max, p) => {
      const m = /^proj_(\d+)$/.exec(p.id || '');
      return m ? Math.max(max, parseInt(m[1], 10)) : max;
    }, 0);
    this.taskSeq = this.projects.reduce((max, p) => {
      if (!Array.isArray(p.tasks)) return max;
      return p.tasks.reduce((m2, t) => {
        const tm = /^task_(\d+)$/.exec(t.id || '');
        return tm ? Math.max(m2, parseInt(tm[1], 10)) : m2;
      }, max);
    }, 0);
  }

  _persistJobs() {
    try {
      fs.writeFileSync(this.jobsPath, JSON.stringify(this.jobs, null, 2), 'utf-8');
      fs.writeFileSync(this.csvPath, core.jobsToCSV(this.jobs), 'utf-8');
    } catch (e) { this._error('échec écriture jobs :', e); }
  }

  _persistConfig() {
    try { fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2), 'utf-8'); }
    catch (e) { this._error('échec écriture config :', e); }
  }

  _persistAccounts() {
    try { fs.writeFileSync(this.accountsPath, JSON.stringify(this.accountsSnapshot, null, 2), 'utf-8'); }
    catch (e) { this._error('échec écriture instantané comptes :', e); }
  }

  _logActivity(message) {
    this.log.push({ ts: new Date().toISOString(), message });
    if (this.log.length > 500) this.log = this.log.slice(-500);
    try { fs.writeFileSync(this.logPath, JSON.stringify(this.log, null, 2), 'utf-8'); }
    catch (e) { this._error('échec écriture journal :', e); }
    if (this._logFn) this._logFn('scheduler', 'info', message);
    else console.log('[scheduler]', message);
  }

  // --- État exposé au renderer ---------------------------------------------

  getState() {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const deliveredToday = this.jobs.filter(j =>
      j.status === 'DELIVERED' && j.finished_at && new Date(j.finished_at) >= startOfDay
    ).length;
    const active = this.jobs.filter(j => ['RUNNING', 'RESUME_REQUIRED', 'DOWNLOADING'].includes(j.status)).length;
    const waiting = this.jobs.filter(j =>
      ['WAITING_FOR_PROFILE', 'PROJECT_PENDING', 'COMPLETED', 'PAUSED'].includes(j.status)
    ).length;
    return {
      config: this.config,
      jobs: [...this.jobs].sort((a, b) => new Date(b.lastActivityAt) - new Date(a.lastActivityAt)),
      projects: [...this.projects].sort((a, b) => new Date(b.lastActivityAt) - new Date(a.lastActivityAt)),
      counters: { active, waiting, deliveredToday },
      log: this.log.slice(-100).reverse()
    };
  }

  // --- Comptes / profils -----------------------------------------------------

  // Reçoit un instantané des comptes depuis le renderer (accounts vit dans le
  // localStorage de la fenêtre — voir index.html `saveAccounts()`). Le process
  // main en a besoin indépendamment de la fenêtre pour choisir un profil et
  // surveiller les téléchargements de chaque partition.
  //
  // IMPORTANT : `automation.lastAutomationAt` n'est connu QUE du process main
  // (mis à jour par continueProject()/resumeJob() lorsqu'un profil est choisi
  // pour une automatisation) — le renderer ne le voit jamais passer. On le
  // PRÉSERVE donc depuis l'instantané précédent plutôt que de le réinitialiser
  // à chaque `saveAccounts()` côté renderer, sinon la sélection "profil le
  // plus ancien" oublierait tout son historique au moindre changement de
  // cooldown.
  syncAccounts(accounts) {
    const previousById = new Map(this.accountsSnapshot.map(a => [a.id, a]));
    this.accountsSnapshot = (Array.isArray(accounts) ? accounts : []).map(a => {
      const prev = previousById.get(a.id);
      const incomingAuto = (a.automation && typeof a.automation === 'object') ? a.automation : {};
      return {
        id: a.id,
        name: a.name,
        profile: a.profile,
        automation: {
          enabled: incomingAuto.enabled !== false,
          lastUsedAt: Number(incomingAuto.lastUsedAt) || 0,
          lastAutomationAt: prev ? (Number(prev.automation.lastAutomationAt) || 0) : (Number(incomingAuto.lastAutomationAt) || 0)
        }
      };
    });
    this._persistAccounts();
    this.accountsSnapshot.forEach(acc => this._watchPartition(acc.profile));
  }

  // --- Configuration ---------------------------------------------------------

  setEnabled(enabled) {
    this.config.enabled = !!enabled;
    this._persistConfig();
    this._logActivity('Ordonnanceur ' + (this.config.enabled ? 'activé' : 'mis en pause') + '.');
    return this.config;
  }

  setConfig(partial) {
    const next = { ...this.config, ...(partial || {}) };
    // Garde-fous : jamais de valeur négative ou non numérique.
    next.maxConcurrentJobs = Math.max(1, Number(next.maxConcurrentJobs) || this.config.maxConcurrentJobs);
    next.minDelayBetweenAutomationsMinutes = Math.max(0, Number(next.minDelayBetweenAutomationsMinutes) || 0);
    next.profileAgeThresholdHours = Math.max(0, Number(next.profileAgeThresholdHours) || this.config.profileAgeThresholdHours);
    this.config = next;
    this._persistConfig();
    this._logActivity('Configuration de l\'ordonnanceur mise à jour.');
    return this.config;
  }

  async pickDownloadsDir(win) {
    const { dialog } = require('electron');
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
    if (r.canceled || !r.filePaths.length) return this.config;
    return this.setConfig({ downloadsDir: r.filePaths[0] });
  }

  async pickDeliveryDir(win) {
    const { dialog } = require('electron');
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
    if (r.canceled || !r.filePaths.length) return this.config;
    return this.setConfig({ deliveryDir: r.filePaths[0] });
  }

  // --- Détection des téléchargements (ordo, point 1) --------------------------

  _watchPartition(profile) {
    if (!profile || this.watchedPartitions.has(profile)) return;
    this.watchedPartitions.add(profile);
    try {
      const ses = this._session.fromPartition('persist:' + profile);
      ses.on('will-download', (event, item, webContents) => {
        try { this._onWillDownload(profile, item, webContents); }
        catch (e) { this._error('erreur de traitement d\'un téléchargement :', e); }
      });
      this._logActivity('Surveillance des téléchargements activée pour le profil « ' + profile + ' ».');
    } catch (e) {
      this._error('échec de la surveillance du profil', profile, e);
    }
  }

  _onWillDownload(profile, item, webContents) {
    if (!this.config.enabled) { // ordonnanceur désactivé -> pas de suivi
      this._debug('téléchargement ignoré (ordonnanceur désactivé), profil ' + profile);
      return;
    }
    const filename = item.getFilename();
    if (!core.isZipFilename(filename)) { // on ne trace que les .zip (ordo, point 1)
      this._debug('téléchargement ignoré (pas un .zip) : ' + filename);
      return;
    }

    const url = item.getURL();
    let host = null;
    try { host = new URL(webContents.getURL()).hostname; } catch (_) { /* webContents fermé/invalide */ }
    const service = core.serviceFromHost(host);

    this.jobSeq += 1;
    const job = core.buildJobRecord({
      id: core.nextJobId(this.jobSeq),
      profile, service, url,
      status: 'DOWNLOADING',
      attempts: 1
    });
    this.jobs.push(job);
    this._persistJobs();
    this._logActivity('Téléchargement détecté : ' + filename + ' (profil ' + profile + ', service ' + (service || '?') + ').');

    item.once('done', (event, state) => {
      const savePath = item.getSavePath();
      let size = 0;
      try { size = fs.statSync(savePath).size; } catch (_) { /* fichier déjà déplacé/supprimé */ }
      job.file_path = savePath;
      job.file_size = size;
      job.finished_at = new Date().toISOString();
      job.lastActivityAt = job.finished_at;
      try {
        job.status = core.nextJobState(job.status, state === 'completed' ? 'COMPLETED' : 'ERROR');
      } catch (e) {
        this._error('transition invalide sur job', job.id, e);
      }
      this._persistJobs();
      this._logActivity(state === 'completed'
        ? 'Téléchargement terminé : ' + path.basename(savePath) + ' (' + size + ' octets).'
        : 'Téléchargement en échec ou annulé : ' + filename + '.');

      // Détection automatique de complétude (lot 18/09/2026) :
      // Si le téléchargement est réussi, on analyse le FEATURES.md du ZIP.
      // Si toutes les cases sont cochées ([x]), on passe automatiquement
      // en PROJECT_PENDING puis DELIVERED (projet terminé).
      if (state === 'completed') {
        this._autoDetectCompleteness(job);
      }
    });
  }

  // --- Cycle de vie manuel d'un job (panneau « Ordonnanceur ») ----------------

  _findJob(jobId) {
    const job = this.jobs.find(j => j.id === jobId);
    if (!job) throw new Error('Job introuvable : ' + jobId);
    return job;
  }

  // « Continuer le projet » depuis un ZIP téléchargé (COMPLETED) : on ne
  // devine PAS automatiquement si le projet est terminé (voir FEATURES.md,
  // sous-tâche « détection de complétude d'un projet ») — c'est une décision
  // manuelle de l'utilisateur, prise depuis le panneau.
  continueProject(jobId) {
    const job = this._findJob(jobId);
    job.status = core.nextJobState(job.status, 'PROJECT_PENDING');
    const account = core.selectOldestEligibleProfile(this.accountsSnapshot, this.config.profileAgeThresholdHours);
    if (account) {
      job.status = core.nextJobState(job.status, 'RESUME_REQUIRED');
      job.profile = account.profile;
      account.automation.lastAutomationAt = Date.now();
      this._persistAccounts();
      this._logActivity('Job ' + jobId + ' : reprise programmée sur le profil « ' + account.profile + ' ».');
    } else {
      job.status = core.nextJobState(job.status, 'WAITING_FOR_PROFILE');
      this._logActivity('Job ' + jobId + ' : aucun profil disponible depuis plus de ' + this.config.profileAgeThresholdHours + ' h, mis en attente.');
    }
    job.lastActivityAt = new Date().toISOString();
    this._persistJobs();
    return job;
  }

  markDelivered(jobId) {
    const job = this._findJob(jobId);
    job.status = core.nextJobState(job.status, 'DELIVERED');
    job.finished_at = job.finished_at || new Date().toISOString();
    job.lastActivityAt = new Date().toISOString();
    this._persistJobs();
    this._logActivity('Job ' + jobId + ' marqué comme livré.');
    return job;
  }

  pauseJob(jobId) {
    const job = this._findJob(jobId);
    job.status = core.nextJobState(job.status, 'PAUSED');
    job.lastActivityAt = new Date().toISOString();
    this._persistJobs();
    this._logActivity('Job ' + jobId + ' mis en pause.');
    return job;
  }

  resumeJob(jobId) {
    const job = this._findJob(jobId);
    const account = core.selectOldestEligibleProfile(this.accountsSnapshot, this.config.profileAgeThresholdHours);
    job.status = core.nextJobState(job.status, account ? 'RESUME_REQUIRED' : 'WAITING_FOR_PROFILE');
    if (account) {
      job.profile = account.profile;
      account.automation.lastAutomationAt = Date.now();
      this._persistAccounts();
    }
    job.lastActivityAt = new Date().toISOString();
    this._persistJobs();
    this._logActivity('Job ' + jobId + ' : reprise demandée.');
    // Tente un lancement automatique si les contraintes le permettent
    this.tryAutoLaunch();
    return job;
  }

  // Tente de lancer automatiquement le prochain job éligible en respectant
  // maxConcurrentJobs et minDelayBetweenAutomationsMinutes (FEATURES.md P1).
  // Lance réellement l'automatisation Claude si le profil a une webview ouverte.
  // Renvoie le job lancé ou null.
  tryAutoLaunch() {
    var now = Date.now();
    var lastAuto = this._getLastAutomationTime();
    var nextJob = core.selectNextJobToLaunch(this.jobs, this.config, lastAuto, now);
    if (!nextJob) {
      this._debug('auto-lancement : aucun job éligible');
      return null;
    }
    var eligibility = core.checkJobLaunchEligibility(nextJob, this.jobs, this.config, lastAuto, now);
    if (!eligibility.canLaunch) {
      this._logActivity('Auto-lancement : ' + eligibility.reason);
      return null;
    }
    // Lancement réel de l'automatisation
    this._executeAutomation(nextJob);
    return nextJob;
  }

  // Lance manuellement un job spécifique, en vérifiant les contraintes du
  // limiteur. Lance réellement l'automatisation Claude. Renvoie { ok, job, reason }.
  launchJob(jobId) {
    var job = this._findJob(jobId);
    var now = Date.now();
    var lastAuto = this._getLastAutomationTime();
    var eligibility = core.checkJobLaunchEligibility(job, this.jobs, this.config, lastAuto, now);
    if (!eligibility.canLaunch) {
      this._debug('lancement manuel refusé pour ' + jobId + ' : ' + eligibility.reason);
      return { ok: false, job: job, reason: eligibility.reason };
    }
    // Lancement réel de l'automatisation
    this._executeAutomation(job);
    return { ok: true, job: job, reason: 'OK' };
  }

  // Exécute l'automatisation Claude pour un job donné. Cette méthode est
  // asynchrone : elle passe le job en RUNNING, exécute runClaudeJob, collecte
  // la réponse et met à jour le statut du job et de la tâche associée.
  async _executeAutomation(job) {
    var self = this;

    // Vérifier les heures calmes (pause 15h-20h30 Paris)
    if (this.quietHoursCheck(new Date())) {
      var waitMs = this.quietHoursRemainingMs(new Date());
      this._logActivity('Job ' + job.id + ' : reporté — heures calmes (15h-20h30 Paris). Reprise dans ' + Math.round(waitMs / 60000) + ' min.');
      // Programmer une reprise après la fin de la pause. Le timer est unref()
      // pour ne pas retenir le process en vie (tests, arrêt de l'app) : dans
      // l'app il ne change rien, le process principal vit aussi longtemps
      // que la fenêtre.
      var deferTimer = setTimeout(function() { self._executeAutomation(job); }, waitMs + 1000);
      if (typeof deferTimer.unref === 'function') deferTimer.unref();
      return;
    }

    // Transition vers RUNNING
    try {
      job.status = core.nextJobState(job.status, 'RUNNING');
    } catch (e) {
      this._logActivity('Job ' + job.id + ' : transition vers RUNNING impossible (' + e.message + ').');
      return;
    }
    job.started_at = new Date().toISOString();
    job.lastActivityAt = job.started_at;
    this._lastAutomationAt = Date.now();
    this._persistJobs();
    this._logActivity('Job ' + job.id + ' : lancement de l\'automatisation Claude (profil « ' + (job.profile || '?') + ' »).');

    // Récupérer le prompt et le ZIP source depuis la tâche associée
    var prompt = '';
    var sourceZipPath = job.sourceZip || null;
    if (job.projectId) {
      var project = this.projects.find(function(p) { return p.id === job.projectId; });
      if (project) {
        var task = project.tasks.find(function(t) {
          return t.assignedProfile === job.profile && (t.status === 'assigned' || t.status === 'running');
        });
        if (task) {
          prompt = task.prompt || '';
          if (task.sourceZip) sourceZipPath = task.sourceZip;
          task.status = 'running';
          task.lastActivityAt = new Date().toISOString();
          this._persistProjects();
        }
      }
    }

    // Si pas de prompt, utiliser le prompt de livraison par défaut
    if (!prompt) {
      // core.buildDeliveryPrompt attend un horodatage YYYYMMDD-HHMMSS (et lève
      // sinon) : l'appel avec le job lui-même levait, laissant le job RUNNING
      // sans échec ni reprise (trouvé par les tests de couverture, #55).
      prompt = core.buildDeliveryPrompt(core.formatTimestamp(new Date()));
    }

    // Vérifier que la webview est enregistrée
    var webContents = this._openWebviews.get(job.profile);
    if (!webContents) {
      this._failJob(job, 'Aucune webview ouverte pour le profil « ' + job.profile + ' ». Ouvrez un onglet Claude.ai pour ce compte.');
      return;
    }

    // Exécuter le job Claude
    try {
      var result = await this.runClaudeJob(job.profile, prompt, sourceZipPath);
      if (result && result.error) {
        // Erreur (quota, sélecteur non trouvé, etc.)
        if (result.error === 'quota_exhausted') {
          this._failJob(job, 'Quota Claude épuisé jusqu\'à ' + (result.quotaTime || '?') + '.');
        } else if (result.error === 'quiet_hours') {
          // Heures calmes : reporter le job après la pause (timer unref, cf.
          // début de _executeAutomation)
          this._logActivity('Job ' + job.id + ' : heures calmes détectées pendant l\'exécution. Reprise dans ' + Math.round((result.waitMs || 0) / 60000) + ' min.');
          var resumeTimer = setTimeout(function() { self._executeAutomation(job); }, (result.waitMs || 0) + 1000);
          if (typeof resumeTimer.unref === 'function') resumeTimer.unref();
        } else {
          this._failJob(job, 'Erreur Claude : ' + result.error);
        }
        return;
      }
      // Succès de l'injection — attendre la réponse de Claude
      this._logActivity('Job ' + job.id + ' : prompt envoyé à Claude, en attente de la réponse...');

      // Poller la réponse pendant max 120 secondes (toutes les 5 s)
      var response = await this._pollClaudeResponse(job.profile, 120000, 5000);
      if (response && response.ok && response.response) {
        job.response = response.response.slice(0, 10000);
        job.responseCollectedAt = new Date().toISOString();
        this._logActivity('Job ' + job.id + ' : réponse collectée (' + response.response.length + ' caractères).');

        // Mettre à jour la tâche associée
        if (job.projectId) {
          var proj = this.projects.find(function(p) { return p.id === job.projectId; });
          if (proj) {
            var t = proj.tasks.find(function(tk) {
              return tk.assignedProfile === job.profile && tk.status === 'running';
            });
            if (t) {
              t.status = 'completed';
              t.result = job.response;
              t.lastActivityAt = new Date().toISOString();
              this._persistProjects();
              this._logActivity('Tâche ' + t.id + ' marquée comme terminée.');
            }
          }
        }
      } else {
        this._logActivity('Job ' + job.id + ' : pas de réponse collectée (délai dépassé).');
      }

      // Transition vers DELIVERED (le job a livré sa réponse)
      try {
        job.status = core.nextJobState(job.status, 'DELIVERED');
        job.finished_at = new Date().toISOString();
        job.lastActivityAt = job.finished_at;
        this._persistJobs();
        this._logActivity('Job ' + job.id + ' : automatisation terminée avec succès.');
      } catch (e) {
        this._logActivity('Job ' + job.id + ' : transition vers DELIVERED impossible (' + e.message + ').');
      }
    } catch (e) {
      this._failJob(job, 'Exception pendant l\'automatisation : ' + e.message);
    }
  }

  // Marque un job comme échoué et met à jour la tâche associée.
  _failJob(job, reason) {
    try {
      job.status = core.nextJobState(job.status, 'ERROR');
    } catch (_) {
      job.status = 'ERROR';
    }
    job.errorReason = reason;
    job.lastActivityAt = new Date().toISOString();
    this._persistJobs();
    this._logActivity('Job ' + job.id + ' : échec — ' + reason);

    // Marquer la tâche associée comme échouée
    if (job.projectId) {
      var project = this.projects.find(function(p) { return p.id === job.projectId; });
      if (project) {
        var task = project.tasks.find(function(t) {
          return t.assignedProfile === job.profile && t.status === 'running';
        });
        if (task) {
          task.status = 'failed';
          task.lastActivityAt = new Date().toISOString();
          this._persistProjects();
          this._logActivity('Tâche ' + task.id + ' marquée comme échouée.');
        }
      }
    }
  }

  // Poll la réponse de Claude à intervalles réguliers.
  // Renvoie { ok: true, response: string } ou { ok: false } si délai dépassé.
  async _pollClaudeResponse(profile, timeoutMs, intervalMs) {
    var self = this;
    var start = Date.now();
    while (Date.now() - start < timeoutMs) {
      await new Promise(function(r) { setTimeout(r, intervalMs); });
      try {
        var resp = await self.collectClaudeResponse(profile);
        if (resp && resp.ok && resp.response) {
          return resp;
        }
      } catch (_) { /* continuer à poller */ }
    }
    return { ok: false, response: null };
  }

  // Crée un job à partir d'une tâche de projet et le lance immédiatement.
  // L'onglet Claude doit déjà être ouvert pour le profil assigné.
  async executeTask(projectId, taskId) {
    var project = this.projects.find(function(p) { return p.id === projectId; });
    if (!project) throw new Error('Projet introuvable : ' + projectId);
    var task = project.tasks.find(function(t) { return t.id === taskId; });
    if (!task) throw new Error('Tâche introuvable : ' + taskId);
    if (!task.assignedProfile) throw new Error('Tâche non assignée à un profil.');

    // Vérifier que la webview est ouverte
    var wc = this._openWebviews.get(task.assignedProfile);
    if (!wc) {
      return { ok: false, error: 'Aucune webview ouverte pour le profil « ' + task.assignedProfile + ' ». Ouvrez un onglet Claude.ai pour ce compte.' };
    }

    // Créer un job en RESUME_REQUIRED
    this.jobSeq += 1;
    var job = core.buildJobRecord({
      id: core.nextJobId(this.jobSeq),
      projectId: projectId,
      sourceZip: task.sourceZip,
      profile: task.assignedProfile,
      service: 'claude',
      status: 'RESUME_REQUIRED'
    });
    this.jobs.push(job);
    this._persistJobs();
    this._logActivity('Job ' + job.id + ' : créé pour la tâche ' + taskId + ' (projet « ' + project.name + ' »).');

    // Lancer l'automatisation
    var launchResult = this.launchJob(job.id);
    if (!launchResult.ok) {
      return launchResult;
    }
    return { ok: true, job: job };
  }

  // Récupère le timestamp de la dernière automatisation exécutée.
  _getLastAutomationTime() {
    if (this._lastAutomationAt) return this._lastAutomationAt;
    // Recherche parmi les jobs : le started_at du job RUNNING le plus récent
    var running = this.jobs.filter(function(j) { return j && j.started_at; });
    if (running.length === 0) return 0;
    var latest = running.reduce(function(max, j) {
      var t = new Date(j.started_at).getTime();
      return t > max ? t : max;
    }, 0);
    return latest;
  }

  retryJob(jobId) {
    const job = this._findJob(jobId);
    job.attempts = (job.attempts || 0) + 1;
    job.status = core.nextJobState(job.status, 'RESUME_REQUIRED');
    job.lastActivityAt = new Date().toISOString();
    this._persistJobs();
    this._logActivity('Job ' + jobId + ' : nouvelle tentative (#' + job.attempts + ').');
    return job;
  }

  openZip(jobId) {
    const { shell } = require('electron');
    const job = this._findJob(jobId);
    const target = job.outputZip || job.file_path;
    if (!target) throw new Error('Aucun fichier associé à ce job pour l\'instant.');
    shell.showItemInFolder(target);
    return true;
  }

  // --- Projets et tâches (lot 18/09/2026, point 6) -------------------------
  // L'ordonnanceur gère des projets contenant des tâches. L'utilisateur
  // choisit quels comptes peuvent recevoir une tâche (allowedAccountIds).
  // Les tâches ne peuvent être confiées qu'aux comptes verts (plus de 5h
  // d'inactivité) — voir canAssignTaskToAccount (scheduler/core.js) et
  // getAssignableAccounts (lib/activity-status.js).

  _persistProjects() {
    try { fs.writeFileSync(this.projectsPath, JSON.stringify(this.projects, null, 2), 'utf-8'); }
    catch (e) { this._error('échec écriture projets :', e); }
  }

  createProject(name, allowedAccountIds) {
    this.projectSeq += 1;
    var project = core.buildProjectRecord({
      id: 'proj_' + String(this.projectSeq).padStart(3, '0'),
      name: name || ('Projet ' + this.projectSeq),
      allowedAccountIds: Array.isArray(allowedAccountIds) ? allowedAccountIds : []
    });
    this.projects.push(project);
    this._persistProjects();
    this._logActivity('Projet créé : « ' + project.name + ' » (' + project.id + ').');
    return project;
  }

  updateProject(projectId, fields) {
    var project = this.projects.find(function(p) { return p.id === projectId; });
    if (!project) throw new Error('Projet introuvable : ' + projectId);
    if (fields && fields.name) project.name = fields.name;
    if (fields && Array.isArray(fields.allowedAccountIds)) project.allowedAccountIds = fields.allowedAccountIds;
    if (fields && fields.status) project.status = fields.status;
    project.lastActivityAt = new Date().toISOString();
    this._persistProjects();
    this._logActivity('Projet mis à jour : « ' + project.name + ' » (' + project.id + ').');
    return project;
  }

  deleteProject(projectId) {
    var idx = this.projects.findIndex(function(p) { return p.id === projectId; });
    if (idx === -1) throw new Error('Projet introuvable : ' + projectId);
    var removed = this.projects.splice(idx, 1)[0];
    this._persistProjects();
    this._logActivity('Projet supprimé : « ' + removed.name + ' » (' + removed.id + ').');
    return removed;
  }

  createTask(projectId, prompt, sourceZip) {
    var project = this.projects.find(function(p) { return p.id === projectId; });
    if (!project) throw new Error('Projet introuvable : ' + projectId);
    this.taskSeq += 1;
    var task = core.buildTaskRecord({
      id: 'task_' + String(this.taskSeq).padStart(3, '0'),
      projectId: projectId,
      prompt: prompt || '',
      sourceZip: sourceZip || null
    });
    project.tasks.push(task);
    project.lastActivityAt = new Date().toISOString();
    this._persistProjects();
    this._logActivity('Tâche créée dans « ' + project.name + ' » : ' + task.id + '.');
    return task;
  }

  // Assigne une tâche à un compte vert. Vérifie que le compte est autorisé
  // par le projet ET qu'il est vert (plus de 5h d'inactivité, pas d'onglet
  // ouvert). Renvoie la tâche mise à jour ou lève une erreur explicite.
  assignTask(projectId, taskId, accountId, openAccountIds) {
    var project = this.projects.find(function(p) { return p.id === projectId; });
    if (!project) throw new Error('Projet introuvable : ' + projectId);
    var task = project.tasks.find(function(t) { return t.id === taskId; });
    if (!task) throw new Error('Tâche introuvable : ' + taskId);
    var account = this.accountsSnapshot.find(function(a) { return a.id === accountId; });
    if (!account) throw new Error('Compte introuvable : ' + accountId);
    var canAssign = core.canAssignTaskToAccount(
      project, account, openAccountIds || [],
      this.config.profileAgeThresholdHours, Date.now()
    );
    if (!canAssign) {
      throw new Error('Le compte « ' + account.name + ' » n\'est pas assignable (pas vert ou non autorisé pour ce projet).');
    }
    task.assignedProfile = account.profile;
    task.status = 'assigned';
    task.lastActivityAt = new Date().toISOString();
    project.lastActivityAt = task.lastActivityAt;
    this._persistProjects();
    this._logActivity('Tâche ' + taskId + ' assignée au profil « ' + account.profile + ' » (compte « ' + account.name + ' »).');
    return task;
  }

  // Renvoie les comptes assignables pour un projet donné (verts + autorisés).
  getAssignableAccountsForProject(projectId, openAccountIds) {
    var project = this.projects.find(function(p) { return p.id === projectId; });
    if (!project) throw new Error('Projet introuvable : ' + projectId);
    var openSet = openAccountIds instanceof Set ? openAccountIds : new Set(openAccountIds || []);
    var threshold = this.config.profileAgeThresholdHours;
    var now = Date.now();
    return this.accountsSnapshot.filter(function(acc) {
      return core.canAssignTaskToAccount(project, acc, openSet, threshold, now);
    });
  }

  // --- Automatisation Claude.ai (lot 18/09/2026, points 7-8, 10-13) -------
  // Seul Claude est supporté pour l'instant (point 10). Les méthodes ci-
  // dessous utilisent les scripts de lib/claude-adapter.js pour interagir
  // avec la page Claude.ai via executeJavaScript et CDP.

  // Enregistre la référence à une <webview> ouverte pour un profil donné.
  // Appelé par le renderer quand un onglet Claude est ouvert.
  registerWebview(profile, webContents) {
    if (profile && webContents) this._openWebviews.set(profile, webContents);
  }
  unregisterWebview(profile) {
    this._openWebviews.delete(profile);
  }

  // Résout le profil d'une <webview> attachée à partir de sa session Electron.
  // Correctif du lot « test Electron réel du 18/09/2026 » : sur Electron 43,
  // guestContents.getWebPreferences() renvoie undefined pour un guest (la
  // partition n'est plus lisible depuis le process principal), ce qui
  // désactivait SILENCIEUSEMENT l'enregistrement des webviews — et donc toute
  // l'automatisation Claude (diagnostic, exécution, collecte : « Aucune webview
  // ouverte »). On identifie désormais le profil en comparant la session du
  // guest aux sessions persist: des profils connus (comptes synchronisés +
  // partitions surveillées). Testé en réel par test-electron/popups-continue.js
  // (test B4) et en unitaire dans test/scheduler-automation.test.js.
  resolveProfileFromSession(guestSession) {
    if (!guestSession) return null;
    var seen = new Set();
    var candidates = Array.from(this.watchedPartitions)
      .concat(this.accountsSnapshot.map(function(acc) { return acc && acc.profile; }))
      .filter(Boolean);
    for (var i = 0; i < candidates.length; i++) {
      var profile = candidates[i];
      if (seen.has(profile)) continue;
      seen.add(profile);
      try {
        if (this._session.fromPartition('persist:' + profile) === guestSession) return profile;
      } catch (e) { /* partition invalide : on continue */ }
    }
    return null;
  }

  // Détecte les éléments de la page Claude.ai (point 7) : boutons Continuer,
  // Télécharger, Nouveau, zone de chat, upload, message de quota, popups.
  // Exécute le script de détection dans la <webview> du profil donné.
  async diagnoseClaudePage(profile) {
    var webContents = this._openWebviews.get(profile);
    if (!webContents) return { error: 'Aucune webview ouverte pour le profil « ' + profile + ' ».' };
    try {
      var script = claudeAdapter.buildClaudeDetectionScript();
      var result = await webContents.executeJavaScript(script);
      var parsed = typeof result === 'string' ? JSON.parse(result) : result;
      this._logActivity('Diagnostic Claude (« ' + profile + ' ») : ' +
        (parsed.quotaMessage && parsed.quotaMessage.detected ? 'quota détecté (' + parsed.quotaMessage.time + ')' : 'pas de quota') +
        ', ' + (parsed.popups ? parsed.popups.count : 0) + ' popup(s).');
      return parsed;
    } catch (e) {
      this._logActivity('Erreur diagnostic Claude (« ' + profile + ' ») : ' + e.message);
      return { error: e.message };
    }
  }

  // Exécute un job Claude : ouvre l'onglet, colle le prompt dans une nouvelle
  // conversation, uploade le fichier source, envoie (point 8).
  // Seul Claude est supporté (point 10).
  // Utilise planClaudeAutomationStep() (lot 18/09/2026 suite) pour décider
  // de l'action à entreprendre à partir du résultat de détection.
  async runClaudeJob(profile, prompt, sourceZipPath) {
    var webContents = this._openWebviews.get(profile);
    if (!webContents) return { error: 'Aucune webview ouverte pour le profil « ' + profile + ' ».' };
    try {
      // 1. Détecter les éléments de la page
      var diag = await this.diagnoseClaudePage(profile);
      if (diag && diag.error) return diag;

      // 2. Vérifier les heures calmes (pause 15h-20h30 Paris)
      if (this.quietHoursCheck(new Date())) {
        var waitMs = this.quietHoursRemainingMs(new Date());
        this._logActivity('Job Claude en pause : heures calmes (15h-20h30 Paris). Reprise dans ' + Math.round(waitMs / 60000) + ' min (« ' + profile + ' »).');
        return { error: 'quiet_hours', waitMs: waitMs };
      }

      // 3. Utiliser planClaudeAutomationStep pour décider de l'action
      //    (priorité : quota > popups > action demandée)
      var plan = claudeAdapter.planClaudeAutomationStep(diag, {
        requestedAction: 'send_prompt',
        prompt: prompt,
        minDelayMs: this.config.minDelayMs ?? 30000,
        maxDelayMs: this.config.maxDelayMs ?? 300000
      });

      // Si quota détecté, ne pas lancer
      if (plan.action === 'wait_quota') {
        this._logActivity('Job Claude annulé : quota gratuit épuisé jusqu\'à ' + plan.quotaTime + ' (« ' + profile + ' »).');
        return { error: 'quota_exhausted', quotaTime: plan.quotaTime };
      }

      // Si popups détectées, les fermer avant de continuer
      if (plan.action === 'dismiss_popups') {
        this._logActivity('Fermeture de ' + plan.popupCount + ' popup(s) Claude (« ' + profile + ' »).');
        await webContents.executeJavaScript(plan.script);
        // Re-diagnostiquer après fermeture des popups
        diag = await this.diagnoseClaudePage(profile);
        plan = claudeAdapter.planClaudeAutomationStep(diag, {
          requestedAction: 'send_prompt',
          prompt: prompt,
          minDelayMs: this.config.minDelayMs ?? 30000,
          maxDelayMs: this.config.maxDelayMs ?? 300000
        });
      }

      // Si l'action est bloquée, rapporter
      if (plan.action === 'blocked') {
        this._logActivity('Job Claude bloqué : ' + plan.reason + ' (« ' + profile + ' »).');
        return { error: plan.reason };
      }

      // 4. Uploader le fichier source (si fourni) via CDP
      if (sourceZipPath) {
        var uploadPlan = claudeAdapter.planClaudeAutomationStep(diag, {
          requestedAction: 'upload_file',
          minDelayMs: this.config.minDelayMs ?? 30000,
          maxDelayMs: this.config.maxDelayMs ?? 300000
        });
        if (uploadPlan.action === 'upload_file' && uploadPlan.script) {
          // Délai anti-détection avant upload
          if (uploadPlan.delayMs > 0) {
            this._logActivity('Délai anti-détection : ' + Math.round(uploadPlan.delayMs / 1000) + 's avant upload (« ' + profile + ' »).');
            await new Promise(function(r) { setTimeout(r, uploadPlan.delayMs); });
          }
          var uploadResult = await webContents.executeJavaScript(uploadPlan.script);
          var uploadParsed = typeof uploadResult === 'string' ? JSON.parse(uploadResult) : uploadResult;
          if (uploadParsed && uploadParsed.ok) {
            // L'upload réel via CDP (DOM.setFileInputFiles) nécessite le debugger
            // Electron — tentative best-effort, sans échec si indisponible.
            try {
              await this._uploadFileViaCDP(webContents, sourceZipPath, uploadParsed.selector);
              this._logActivity('Fichier uploadé pour Claude (« ' + profile + ' ») : ' + sourceZipPath);
            } catch (e) {
              this._logActivity('Upload CDP échoué (« ' + profile + ' ») : ' + e.message + ' — l\'utilisateur devra uploader manuellement.');
            }
          }
        }
      }

      // 5. Délai anti-détection puis injection du prompt
      if (plan.delayMs > 0) {
        this._logActivity('Délai anti-détection : ' + Math.round(plan.delayMs / 1000) + 's avant envoi (« ' + profile + ' »).');
        await new Promise(function(r) { setTimeout(r, plan.delayMs); });
      }

      if (plan.script) {
        var injectResult = await webContents.executeJavaScript(plan.script);
        var injectParsed = typeof injectResult === 'string' ? JSON.parse(injectResult) : injectResult;
        if (injectParsed && injectParsed.ok) {
          this._logActivity('Prompt injecté dans Claude (« ' + profile + ' ») via ' + injectParsed.method + '.');
        }
        return injectParsed || { ok: false, error: 'unknown' };
      }

      return { ok: false, error: 'no_action_taken' };
    } catch (e) {
      this._logActivity('Erreur job Claude (« ' + profile + ' ») : ' + e.message);
      return { error: e.message };
    }
  }

  // Upload d'un fichier via CDP (Chrome DevTools Protocol).
  // Utilise webContents.debugger pour DOM.setFileInputFiles — un <input
  // type="file"> ne peut pas recevoir de fichier via executeJavaScript
  // (restriction de sécurité navigateur).
  async _uploadFileViaCDP(webContents, filePath, selector) {
    var debugger_ = webContents.debugger;
    if (!debugger_) throw new Error('CDP non disponible sur cette webview.');
    await debugger_.attach('1.3');
    try {
      var doc = await debugger_.sendCommand('DOM.getDocument');
      var root = doc.root;
      var node = await debugger_.sendCommand('DOM.querySelector', {
        nodeId: root.nodeId,
        selector: selector
      });
      if (!node || node.nodeId === 0) throw new Error('Input file non trouvé via CDP.');
      await debugger_.sendCommand('DOM.setFileInputFiles', {
        nodeId: node.nodeId,
        files: [filePath]
      });
    } finally {
      try { await debugger_.detach(); } catch (_) {}
    }
  }

  // Collecte la dernière réponse de Claude pour analyse (point 13).
  async collectClaudeResponse(profile) {
    var webContents = this._openWebviews.get(profile);
    if (!webContents) return { error: 'Aucune webview ouverte pour le profil « ' + profile + ' ».' };
    try {
      var script = claudeAdapter.buildResponseCollectionScript();
      var result = await webContents.executeJavaScript(script);
      var parsed = typeof result === 'string' ? JSON.parse(result) : result;
      if (parsed && parsed.ok) {
        this._logActivity('Réponse Claude collectée (« ' + profile + ' ») : ' +
          (parsed.response ? parsed.response.length + ' caractères.' : 'aucune réponse.'));
      }
      return parsed;
    } catch (e) {
      this._logActivity('Erreur collecte réponse Claude (« ' + profile + ' ») : ' + e.message);
      return { error: e.message };
    }
  }

  // --- Détection automatique de complétude (lot 18/09/2026, FEATURES.md P1) ---
  // Analyse le FEATURES.md du ZIP livré. Si toutes les cases sont cochées
  // ([x], plus aucune [ ] ou [~]), passe automatiquement le job en DELIVERED
  // et marque le projet comme terminé. Sinon, passe en PROJECT_PENDING
  // (l'utilisateur doit décider : continuer ou marquer livré).
  _autoDetectCompleteness(job) {
    var analysis = this.analyzeCompleteness(job.id);
    if (analysis && analysis.error) {
      // Pas de FEATURES.md trouvé — on laisse le job en COMPLETED
      // (l'utilisateur décidera manuellement).
      this._logActivity('Job ' + job.id + ' : pas de FEATURES.md détecté, complétude non déterminée.');
      return;
    }
    if (analysis && analysis.analysis) {
      var a = analysis.analysis;
      this._logActivity('Job ' + job.id + ' : complétude analysée — ' +
        a.done + ' fait(s), ' + a.inProgress + ' en cours, ' + a.pending + ' en attente (total ' + a.total + ').');

      if (a.complete) {
        // Projet terminé : transition automatique COMPLETED → DELIVERED
        try {
          job.status = core.nextJobState(job.status, 'DELIVERED');
          job.lastActivityAt = new Date().toISOString();
          job.autoCompleted = true;
          this._persistJobs();
          this._logActivity('Job ' + job.id + ' : projet terminé automatiquement (toutes les cases cochées).');

          // Marquer le projet associé comme terminé
          if (job.projectId) {
            var project = this.projects.find(function(p) { return p.id === job.projectId; });
            if (project && project.status === 'active') {
              project.status = 'completed';
              project.lastActivityAt = new Date().toISOString();
              this._persistProjects();
              this._logActivity('Projet « ' + project.name + ' » marqué comme terminé automatiquement.');
            }
          }
        } catch (e) {
          this._logActivity('Job ' + job.id + ' : transition automatique impossible (' + e.message + ').');
        }
      } else {
        // Pas encore terminé : transition automatique vers PROJECT_PENDING
        // pour que l'utilisateur puisse décider (continuer ou marquer livré).
        try {
          job.status = core.nextJobState(job.status, 'PROJECT_PENDING');
          job.lastActivityAt = new Date().toISOString();
          job.completenessAnalysis = a;
          this._persistJobs();
          this._logActivity('Job ' + job.id + ' : ' + a.pending + ' feature(s) encore en attente, passage en PROJECT_PENDING.');
        } catch (e) {
          // Déjà transitionné ? On ignore.
        }
      }
    }
  }

  // --- Détection de complétude d'un projet (FEATURES.md P1).
  // Tente de lire un FEATURES.md à l'intérieur du ZIP livré et compte les
  // cases [ ] / [x] / [~] restantes via core.parseFeaturesMd(). Renvoie
  // { analysis: { done, inProgress, pending, total, complete }, source } ou
  // { error } si le ZIP ne contient pas de FEATURES.md ou ne peut être lu.
  // L'extraction utilise `unzip` (Linux/Mac) ou PowerShell (Windows) — pas de
  // nouvelle dépendance npm (invariant 7), on s'appuie sur des outils système.
  analyzeCompleteness(jobId) {
    const { execSync } = require('child_process');
    const job = this._findJob(jobId);
    const target = job.outputZip || job.file_path;
    if (!target) return { error: 'Aucun fichier associé à ce job.' };
    let content = null;
    const isWin = process.platform === 'win32';
    // Stratégie 1 : `unzip -p` (Linux/Mac) — cherche FEATURES.md n'importe où
    // dans l'archive et l'écrit sur stdout.
    if (!isWin) {
      try {
        // -p : extrait vers stdout ; on cherche FEATURES.md (insensible à la casse)
        // dans toute l'archive. `unzip -l` liste d'abord, puis -p extrait.
        const listing = execSync('unzip -l "' + target + '"', {
          timeout: 5000, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe']
        });
        // Cherche FEATURES.md (insensible à la casse) avec son chemin complet
        // dans l'archive. `unzip -l` liste le chemin relatif de chaque fichier.
        const lines = listing.split('\n');
        var featuresPath = null;
        for (var li = 0; li < lines.length; li++) {
          var lm = lines[li].match(/\s([^\s]*FEATURES\.md)\s*$/i);
          if (lm) { featuresPath = lm[1]; break; }
        }
        if (featuresPath) {
          content = execSync('unzip -p "' + target + '" "' + featuresPath + '"', {
            timeout: 5000, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe']
          });
        }
      } catch (e) { /* unzip absent ou ZIP illisible */ }
    } else {
      // Stratégie 2 (Windows) : PowerShell Expand-Archive vers un dossier
      // temporaire, puis lecture du FEATURES.md.
      // mkdtempSync (et non « 'iao-zip-' + Date.now() ») : dossier UNIQUE. Deux
      // analyses dans la même milliseconde partageaient le même dossier, et un
      // FEATURES.md resté d'une analyse précédente (nettoyage raté) était relu
      // à tort (test intermittent « archive sans FEATURES.md », 30/09/2026).
      // path.join : chemin correct quel que soit l'OS (tests win32 sur Linux, PR #120).
      const fs = require('fs');
      let tmpDir = null;
      try {
        tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'iao-zip-'));
        execSync('powershell -NoProfile -Command "Expand-Archive -LiteralPath \'' + target + '\' -DestinationPath \'' + tmpDir + '\' -Force"', {
          timeout: 10000, stdio: ['pipe', 'pipe', 'pipe']
        });
        function findFeaturesMd(dir) {
          const entries = fs.readdirSync(dir, { withFileTypes: true });
          for (const e of entries) {
            const full = path.join(dir, e.name);
            if (e.isFile() && /^FEATURES\.md$/i.test(e.name)) {
              return fs.readFileSync(full, 'utf-8');
            }
            if (e.isDirectory()) {
              const found = findFeaturesMd(full);
              if (found) return found;
            }
          }
          return null;
        }
        content = findFeaturesMd(tmpDir);
      } catch (e) { /* PowerShell a échoué */ }
      // Nettoie le dossier temporaire, y compris si PowerShell a échoué (best-effort).
      if (tmpDir) { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {} }
    }
    if (!content) return { error: 'Aucun FEATURES.md trouvé dans le ZIP.' };
    const analysis = core.parseFeaturesMd(content);
    return {
      analysis: { ...analysis, complete: core.isProjectComplete(content) },
      source: 'FEATURES.md'
    };
  }
}

// Enregistre tous les canaux IPC 'scheduler:*'. `getWin` est un callback
// renvoyant la BrowserWindow courante (pour ancrer les boîtes de dialogue de
// sélection de dossier). Chaque handler capture ses erreurs pour renvoyer
// `{ error }` plutôt que de faire planter le canal IPC — le renderer n'a
// alors qu'à tester `result && result.error`.
function registerSchedulerIPC(ipcMainRef, scheduler, getWin) {
  const safe = (fn) => async (event, ...args) => {
    try { return await fn(...args); }
    catch (e) { return { error: e.message || String(e) }; }
  };

  ipcMainRef.handle('scheduler:get-state', safe(() => scheduler.getState()));
  ipcMainRef.handle('scheduler:sync-accounts', safe((accounts) => { scheduler.syncAccounts(accounts); return true; }));
  ipcMainRef.handle('scheduler:set-enabled', safe((enabled) => scheduler.setEnabled(enabled)));
  ipcMainRef.handle('scheduler:set-config', safe((partial) => scheduler.setConfig(partial)));
  ipcMainRef.handle('scheduler:pick-downloads-dir', safe(() => scheduler.pickDownloadsDir(getWin())));
  ipcMainRef.handle('scheduler:pick-delivery-dir', safe(() => scheduler.pickDeliveryDir(getWin())));
  ipcMainRef.handle('scheduler:continue-project', safe((jobId) => scheduler.continueProject(jobId)));
  ipcMainRef.handle('scheduler:mark-delivered', safe((jobId) => scheduler.markDelivered(jobId)));
  ipcMainRef.handle('scheduler:pause-job', safe((jobId) => scheduler.pauseJob(jobId)));
  ipcMainRef.handle('scheduler:resume-job', safe((jobId) => scheduler.resumeJob(jobId)));
  ipcMainRef.handle('scheduler:retry-job', safe((jobId) => scheduler.retryJob(jobId)));
  ipcMainRef.handle('scheduler:open-zip', safe((jobId) => scheduler.openZip(jobId)));
  ipcMainRef.handle('scheduler:analyze-completeness', safe((jobId) => scheduler.analyzeCompleteness(jobId)));
  // Limiteur de lancement (lot 18/09/2026, FEATURES.md P1)
  ipcMainRef.handle('scheduler:launch-job', safe((jobId) => scheduler.launchJob(jobId)));
  ipcMainRef.handle('scheduler:try-auto-launch', safe(() => scheduler.tryAutoLaunch()));
  // Projets et tâches (lot 18/09/2026, point 6)
  ipcMainRef.handle('scheduler:create-project', safe((name, allowedAccountIds) => scheduler.createProject(name, allowedAccountIds)));
  ipcMainRef.handle('scheduler:update-project', safe((projectId, fields) => scheduler.updateProject(projectId, fields)));
  ipcMainRef.handle('scheduler:delete-project', safe((projectId) => scheduler.deleteProject(projectId)));
  ipcMainRef.handle('scheduler:create-task', safe((projectId, prompt, sourceZip) => scheduler.createTask(projectId, prompt, sourceZip)));
  ipcMainRef.handle('scheduler:assign-task', safe((projectId, taskId, accountId, openAccountIds) => scheduler.assignTask(projectId, taskId, accountId, openAccountIds)));
  ipcMainRef.handle('scheduler:get-assignable-accounts', safe((projectId, openAccountIds) => scheduler.getAssignableAccountsForProject(projectId, openAccountIds)));
  // Automatisation Claude (lot 18/09/2026, points 7-8, 10-13)
  ipcMainRef.handle('scheduler:register-webview', safe((profile, webContentsId) => {
    // Le renderer passe l'id de la webview ; on retrouve le webContents via BrowserView/webContents.
    // Pour une <webview>, on utilise le webContents de la partition.
    // En pratique, le renderer passera le webContents directement via l'API Electron.
    // Ce canal est un placeholder — l'enregistrement réel se fait via did-attach-webview.
    return true;
  }));
  ipcMainRef.handle('scheduler:diagnose-claude', safe((profile) => scheduler.diagnoseClaudePage(profile)));
  ipcMainRef.handle('scheduler:run-claude-job', safe((profile, prompt, sourceZipPath) => scheduler.runClaudeJob(profile, prompt, sourceZipPath)));
  ipcMainRef.handle('scheduler:collect-claude-response', safe((profile) => scheduler.collectClaudeResponse(profile)));
  // Exécution réelle d'une tâche (lot 18/09/2026 — automatisation Claude)
  ipcMainRef.handle('scheduler:execute-task', safe((projectId, taskId) => scheduler.executeTask(projectId, taskId)));
}

module.exports = { Scheduler, registerSchedulerIPC };
