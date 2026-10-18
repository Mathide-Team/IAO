'use strict';

// scheduler/taches-service.js — tâches programmables, lot 3 (issue #199) :
// persistance, échéances, heures calmes, historique et canaux IPC `taches:*`.
//
// Répartition des rôles (voir #199) : le preload n'expose que `invoke`, le
// process principal ne peut donc pas demander au renderer d'ouvrir un onglet.
// La minuterie vit côté renderer (assets/app.js) : toutes les 30 s elle
// appelle `taches:dues` avec les comptes (profil + services), ouvre les
// onglets du plan reçu, envoie le prompt par `scheduler:run-claude-job`, puis
// rend compte par `taches:report`. Ce module garde l'état : une tâche due est
// marquée exécutée AU MOMENT où son plan est remis, elle ne peut donc pas
// partir deux fois. Conséquence : une tâche ne s'exécute que si IAO est
// ouvert (une seule exécution de rattrapage à l'ouverture suivante).
//
// Fichiers : <userData>/scheduler/taches.json et taches-historique.json.
// Dépendances injectées (fs, horloge, heures calmes, journal) : testé par
// `node --test` sans Electron (test/scheduler-taches-service.test.js).

const path = require('path');
const taches = require('./taches.js');

const HISTORIQUE_MAX = 200;
const RESULTATS = Object.freeze(['lancee', 'envoye', 'quota', 'heures-calmes', 'non-connecte', 'erreur', 'aucun-compte']);

class TachesService {
  constructor(options) {
    const o = options || {};
    this.fs = o.fs || require('fs');
    this.dossier = o.dossier;
    this.fichier = path.join(this.dossier, 'taches.json');
    this.fichierHistorique = path.join(this.dossier, 'taches-historique.json');
    this.maintenant = o.maintenant || (() => new Date());
    this.heuresCalmes = o.heuresCalmes || (() => false);
    this.journal = o.journal || (() => {});
    this.fournisseurs = o.fournisseurs || taches.FOURNISSEURS_PAR_DEFAUT;
    this.taches = this._lire(this.fichier).map(t => taches.normaliserTache(t, this.fournisseurs))
      .filter(r => r.ok).map(r => r.tache);
    this.historique = this._lire(this.fichierHistorique).slice(-HISTORIQUE_MAX);
  }

  _lire(fichier) {
    try {
      const donnees = JSON.parse(this.fs.readFileSync(fichier, 'utf-8'));
      return Array.isArray(donnees) ? donnees : [];
    } catch (e) {
      if (e.code !== 'ENOENT') this.journal('warning', 'Tâches : ' + fichier + ' illisible (' + e.message + ').');
      return [];
    }
  }

  _ecrire(fichier, donnees) {
    try {
      this.fs.mkdirSync(this.dossier, { recursive: true });
      this.fs.writeFileSync(fichier + '.tmp', JSON.stringify(donnees, null, 2), 'utf-8');
      this.fs.renameSync(fichier + '.tmp', fichier);
      return true;
    } catch (e) {
      this.journal('error', 'Tâches : écriture de ' + fichier + ' impossible (' + e.message + ').');
      return false;
    }
  }

  _persister() { return this._ecrire(this.fichier, this.taches); }

  _noter(tache, profil, resultat, detail) {
    const entree = {
      date: this.maintenant().toISOString(), tache: tache.id, nom: tache.nom,
      profil: profil || null, resultat, detail: detail ? String(detail).slice(0, 300) : null
    };
    this.historique.push(entree);
    this.historique = this.historique.slice(-HISTORIQUE_MAX);
    this._ecrire(this.fichierHistorique, this.historique);
    this.journal(resultat === 'erreur' ? 'warning' : 'info',
      'Tâche « ' + tache.nom + ' »' + (profil ? ' (« ' + profil + ' »)' : '') + ' : ' + resultat +
      (entree.detail ? ' — ' + entree.detail : '') + '.');
    return entree;
  }

  // --- Gestion -------------------------------------------------------------

  // Liste, avec la prochaine échéance de chaque tâche (ISO ou null).
  liste() {
    return this.taches.map(t => {
      const e = taches.prochaineEcheance(t);
      return Object.assign({}, t, { prochaine: e ? e.toISOString() : null });
    });
  }

  // Crée (sans id) ou remplace (id connu) ; renvoie { ok, tache } ou { ok: false, erreurs }.
  enregistrer(entree) {
    const r = taches.normaliserTache(entree, this.fournisseurs);
    if (!r.ok) return { ok: false, erreurs: r.erreurs };
    const i = r.tache.id ? this.taches.findIndex(t => t.id === r.tache.id) : -1;
    if (i >= 0) {
      // L'état d'exécution n'est pas modifiable depuis l'interface.
      r.tache.derniereExecution = this.taches[i].derniereExecution;
      r.tache.indexRotation = this.taches[i].indexRotation;
      this.taches[i] = r.tache;
    } else {
      r.tache.id = taches.idSuivant(this.taches);
      r.tache.derniereExecution = null;
      r.tache.indexRotation = 0;
      this.taches.push(r.tache);
    }
    this._persister();
    this.journal('info', 'Tâche « ' + r.tache.nom + ' » enregistrée (' + (r.tache.active ? 'active' : 'inactive') + ').');
    return { ok: true, tache: r.tache };
  }

  supprimer(id) {
    const avant = this.taches.length;
    this.taches = this.taches.filter(t => t.id !== id);
    if (this.taches.length === avant) return false;
    this._persister();
    this.journal('info', 'Tâche ' + id + ' supprimée.');
    return true;
  }

  activer(id, active) {
    const t = this.taches.find(x => x.id === id);
    if (!t) return null;
    t.active = active === true;
    this._persister();
    this.journal('info', 'Tâche « ' + t.nom + ' » ' + (t.active ? 'activée' : 'désactivée') + '.');
    return t;
  }

  // --- Exécution -----------------------------------------------------------

  // Plan d'une tâche pour les comptes fournis ; marque l'exécution (pas de
  // double départ) et met à jour la rotation.
  _lancer(tache, comptes) {
    const { eligibles, exclus } = taches.comptesEligibles(tache, comptes);
    const plan = taches.planExecution(tache, eligibles);
    tache.derniereExecution = this.maintenant().toISOString();
    tache.indexRotation = plan.indexRotation;
    for (const e of exclus) this._noter(tache, e.profil, 'erreur', 'compte ' + e.raison);
    if (!plan.etapes.length) this._noter(tache, null, 'aucun-compte', null);
    for (const etape of plan.etapes) this._noter(tache, etape.profil, 'lancee', null);
    const fournisseur = this.fournisseurs[tache.fournisseur];
    return {
      tache: tache.id, nom: tache.nom, fournisseur: tache.fournisseur,
      url: tache.nouvelleSession ? fournisseur.urlNouvelleSession : null,
      prompt: tache.prompt, etapes: plan.etapes
    };
  }

  // Tâches dues maintenant -> plans. Heures calmes : rien ne part, les
  // tâches restent dues et partent à la fin de la pause.
  dues(comptes) {
    const maintenant = this.maintenant();
    const aLancer = taches.tachesDues(this.taches, maintenant);
    if (!aLancer.length) return [];
    if (this.heuresCalmes(maintenant)) {
      this.journal('info', aLancer.length + ' tâche(s) reportée(s) : heures calmes (15h-20h30 Paris).');
      return [];
    }
    const plans = aLancer.map(t => this._lancer(t, comptes));
    this._persister();
    return plans;
  }

  // « Exécuter maintenant » : ignore la programmation (pas les heures calmes,
  // vérifiées par l'envoi du prompt lui-même).
  executerMaintenant(id, comptes) {
    const t = this.taches.find(x => x.id === id);
    if (!t) return null;
    const plan = this._lancer(t, comptes);
    this._persister();
    return plan;
  }

  // Compte rendu d'une étape par le renderer.
  rapport(id, profil, resultat, detail) {
    const t = this.taches.find(x => x.id === id);
    if (!t || !RESULTATS.includes(resultat)) return null;
    return this._noter(t, profil, resultat, detail);
  }

  derniersEvenements(n) {
    return this.historique.slice(-(n || 50)).reverse();
  }
}

// Résultat de `scheduler:run-claude-job` -> résultat d'historique.
function resultatEnvoi(res) {
  if (res && res.ok) return { resultat: 'envoye', detail: res.method || null };
  const err = res && res.error ? String(res.error) : 'inconnue';
  if (err === 'quota_exhausted') return { resultat: 'quota', detail: res.quotaTime || null };
  if (err === 'quiet_hours') return { resultat: 'heures-calmes', detail: null };
  if (/Aucune webview|element_not_found|invalid_detection/.test(err)) return { resultat: 'non-connecte', detail: err };
  return { resultat: 'erreur', detail: err };
}

function registerTachesIPC(ipc, service) {
  const sur = (fn) => async (_e, ...args) => {
    try { return await fn(...args); } catch (e) { return { error: e.message || String(e) }; }
  };
  ipc.handle('taches:list', sur(() => service.liste()));
  ipc.handle('taches:save', sur((entree) => service.enregistrer(entree)));
  ipc.handle('taches:delete', sur((id) => service.supprimer(id)));
  ipc.handle('taches:set-active', sur((id, active) => service.activer(id, active)));
  ipc.handle('taches:dues', sur((comptes) => service.dues(comptes)));
  ipc.handle('taches:run-now', sur((id, comptes) => service.executerMaintenant(id, comptes)));
  ipc.handle('taches:report', sur((id, profil, res) => {
    const r = resultatEnvoi(res);
    return service.rapport(id, profil, r.resultat, r.detail);
  }));
  ipc.handle('taches:history', sur((n) => service.derniersEvenements(n)));
}

module.exports = { TachesService, registerTachesIPC, resultatEnvoi, HISTORIQUE_MAX, RESULTATS };
