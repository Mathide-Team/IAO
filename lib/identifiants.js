'use strict';

// lib/identifiants.js — identifiants de connexion partagés entre profils (issue #278).
//
// But : ne plus ressaisir les identifiants d'un connecteur dans chaque profil,
// comme le fait un navigateur classique avec son gestionnaire de mots de passe,
// SANS toucher à l'étanchéité des cookies : les cookies restent par partition
// (profil), seuls les identifiants (login + mot de passe) sont partagés. Le 2FA
// n'est pas concerné (il vit dans la session/le téléphone, jamais ici).
//
// Stockage : <userData>/identifiants.json, mot de passe chiffré par le trousseau
// du système (Electron `safeStorage`), en base64, indexé par hôte puis par
// login. Lister ne déchiffre jamais rien : les mots de passe ne sont lus qu'à la
// demande explicite (obtenir). Mêmes règles que le coffre (issue #201) : si le
// chiffrement du système n'est pas disponible, l'enregistrement est refusé.
// Process principal uniquement ; `chiffreur` et `fs` injectés (testé par
// `node --test` sans Electron).

const HOST_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.[a-z]{2,63}$/;
const LOGIN_MAX = 128;
const MDP_MAX = 256;
const HOTES_MAX = 200;      // garde-fou : nombre d'hôtes
const PAR_HOTE_MAX = 20;    // garde-fou : identifiants par hôte

class IdentifiantsPartages {
  constructor(options) {
    this.fichier = options.fichier;
    this.chiffreur = options.chiffreur;
    this.fs = options.fs || require('fs');
    this.journal = options.journal || (() => {});
  }

  disponible() {
    try {
      if (!this.chiffreur.isEncryptionAvailable()) return false;
      const backend = typeof this.chiffreur.getSelectedStorageBackend === 'function'
        ? this.chiffreur.getSelectedStorageBackend() : null;
      return backend !== 'basic_text';
    } catch (_) {
      return false;
    }
  }

  _lire() {
    try {
      const d = JSON.parse(this.fs.readFileSync(this.fichier, 'utf-8'));
      return d && typeof d === 'object' && !Array.isArray(d) ? d : {};
    } catch (e) {
      if (e.code !== 'ENOENT') this.journal('warning', 'Identifiants : ' + this.fichier + ' illisible (' + e.message + ').');
      return {};
    }
  }

  _ecrire(d) {
    this.fs.writeFileSync(this.fichier + '.tmp', JSON.stringify(d, null, 2), { encoding: 'utf-8', mode: 0o600 });
    this.fs.renameSync(this.fichier + '.tmp', this.fichier);
  }

  // Liste les hôtes et leurs logins, SANS aucun mot de passe (rien à déchiffrer).
  // Forme : { 'context7.com': [{ login, ajoute }], ... }
  lister() {
    const d = this._lire();
    const sortie = {};
    for (const hote of Object.keys(d)) {
      if (!Array.isArray(d[hote])) continue;
      sortie[hote] = d[hote]
        .filter(e => e && typeof e === 'object' && typeof e.login === 'string')
        .map(e => ({ login: e.login, ajoute: typeof e.ajoute === 'number' ? e.ajoute : null }));
    }
    return sortie;
  }

  // Ajoute ou remplace (même hôte + même login) un identifiant.
  enregistrer(hote, login, motDePasse) {
    hote = String(hote || '').toLowerCase().trim();
    login = String(login || '').trim();
    if (!HOST_RE.test(hote)) return { ok: false, erreur: 'hote' };
    if (!login || login.length > LOGIN_MAX) return { ok: false, erreur: 'login' };
    if (typeof motDePasse !== 'string' || !motDePasse || motDePasse.length > MDP_MAX) return { ok: false, erreur: 'mot-de-passe' };
    if (!this.disponible()) {
      this.journal('warning', 'Identifiants : chiffrement du système indisponible, identifiant non enregistré.');
      return { ok: false, erreur: 'chiffrement-indisponible' };
    }
    const d = this._lire();
    if (!Array.isArray(d[hote])) {
      if (Object.keys(d).filter(h => Array.isArray(d[h])).length >= HOTES_MAX) return { ok: false, erreur: 'quota-hotes' };
      d[hote] = [];
    }
    const autres = d[hote].filter(e => !(e && e.login === login));
    if (autres.length + 1 > PAR_HOTE_MAX) return { ok: false, erreur: 'quota-hote' };
    d[hote] = autres.concat([{ login, secret: this.chiffreur.encryptString(motDePasse).toString('base64'), ajoute: Date.now() }]);
    this._ecrire(d);
    this.journal('info', 'Identifiants : « ' + login + ' » enregistré pour ' + hote + '.');
    return { ok: true };
  }

  // Mot de passe en clair d'un identifiant, ou null. Déchiffrement à la demande.
  obtenir(hote, login) {
    hote = String(hote || '').toLowerCase().trim();
    login = String(login || '').trim();
    if (!HOST_RE.test(hote) || !login) return null;
    const entree = (this._lire()[hote] || []).find(e => e && e.login === login);
    if (!entree || typeof entree.secret !== 'string' || !this.disponible()) return null;
    try {
      return this.chiffreur.decryptString(Buffer.from(entree.secret, 'base64'));
    } catch (e) {
      this.journal('warning', 'Identifiants : déchiffrement impossible pour « ' + login + ' » sur ' + hote + ' (' + e.message + ').');
      return null;
    }
  }

  supprimer(hote, login) {
    hote = String(hote || '').toLowerCase().trim();
    login = String(login || '').trim();
    const d = this._lire();
    if (!Array.isArray(d[hote])) return false;
    const avant = d[hote].length;
    d[hote] = d[hote].filter(e => !(e && e.login === login));
    if (d[hote].length === avant) return false;
    if (d[hote].length === 0) delete d[hote];
    this._ecrire(d);
    this.journal('info', 'Identifiants : « ' + login + ' » supprimé pour ' + hote + '.');
    return true;
  }
}

// Canaux IPC des identifiants partagés. Le renderer (fenêtre hôte privilégiée,
// pas la webview) y accède pour l'UI de gestion et la copie — même posture que
// le coffre des mots de passe de messagerie (issue #201).
function registerIdentifiantsIPC(ipc, o) {
  const sur = (fn) => async (_e, ...args) => {
    try { return await fn(...args); } catch (e) { return { error: e.message || String(e) }; }
  };
  ipc.handle('identifiants:lister', sur(() => o.identifiants.lister()));
  ipc.handle('identifiants:enregistrer', sur((hote, login, mdp) => o.identifiants.enregistrer(hote, login, mdp)));
  ipc.handle('identifiants:obtenir', sur((hote, login) => o.identifiants.obtenir(hote, login)));
  ipc.handle('identifiants:supprimer', sur((hote, login) => o.identifiants.supprimer(hote, login)));
}

module.exports = { IdentifiantsPartages, registerIdentifiantsIPC, HOST_RE, LOGIN_MAX, MDP_MAX };
