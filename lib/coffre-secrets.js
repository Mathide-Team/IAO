'use strict';

// lib/coffre-secrets.js — mots de passe de messagerie des comptes (issue #201).
//
// Chiffrés par le trousseau du système (Electron `safeStorage` : DPAPI sous
// Windows, libsecret/kwallet sous Linux), stockés en base64 dans
// <userData>/secrets.json, indexés par profil. JAMAIS en clair : si le
// chiffrement n'est pas disponible (Linux sans trousseau : backend
// « basic_text »), l'enregistrement est refusé. Process principal uniquement ;
// `chiffreur` et `fs` injectés (testé par node --test sans Electron).

const CLE_RE = /^[A-Za-z0-9_-]{1,64}$/;
const VALEUR_MAX = 256;

class CoffreSecrets {
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
      if (e.code !== 'ENOENT') this.journal('warning', 'Coffre : ' + this.fichier + ' illisible (' + e.message + ').');
      return {};
    }
  }

  _ecrire(d) {
    this.fs.writeFileSync(this.fichier + '.tmp', JSON.stringify(d, null, 2), { encoding: 'utf-8', mode: 0o600 });
    this.fs.renameSync(this.fichier + '.tmp', this.fichier);
  }

  definir(cle, valeur) {
    if (!CLE_RE.test(String(cle))) return { ok: false, erreur: 'cle' };
    if (typeof valeur !== 'string' || !valeur || valeur.length > VALEUR_MAX) return { ok: false, erreur: 'valeur' };
    if (!this.disponible()) {
      this.journal('warning', 'Coffre : chiffrement du système indisponible, mot de passe non enregistré.');
      return { ok: false, erreur: 'chiffrement-indisponible' };
    }
    const d = this._lire();
    d[cle] = this.chiffreur.encryptString(valeur).toString('base64');
    this._ecrire(d);
    this.journal('info', 'Coffre : mot de passe enregistré pour « ' + cle + ' ».');
    return { ok: true };
  }

  lire(cle) {
    const brut = this._lire()[cle];
    if (typeof brut !== 'string' || !this.disponible()) return null;
    try {
      return this.chiffreur.decryptString(Buffer.from(brut, 'base64'));
    } catch (e) {
      this.journal('warning', 'Coffre : déchiffrement impossible pour « ' + cle + ' » (' + e.message + ').');
      return null;
    }
  }

  supprimer(cle) {
    const d = this._lire();
    if (!Object.prototype.hasOwnProperty.call(d, cle)) return false;
    delete d[cle];
    this._ecrire(d);
    return true;
  }
}

// Canaux IPC du coffre et du webmail. `app:open-webmail` n'ouvre QUE l'URL
// des réglages (jamais une URL fournie par le renderer).
function registerComptesIPC(ipc, o) {
  const sur = (fn) => async (_e, ...args) => {
    try { return await fn(...args); } catch (e) { return { error: e.message || String(e) }; }
  };
  ipc.handle('secrets:available', sur(() => o.coffre.disponible()));
  ipc.handle('secrets:set', sur((cle, valeur) => o.coffre.definir(cle, valeur)));
  ipc.handle('secrets:get', sur((cle) => o.coffre.lire(cle)));
  ipc.handle('secrets:delete', sur((cle) => o.coffre.supprimer(cle)));
  ipc.handle('app:open-webmail', sur(async () => {
    let url = '';
    try {
      url = o.normaliser(JSON.parse(await o.fsPromises.readFile(o.fichierReglages, 'utf-8'))).webmailUrl;
    } catch (_) { /* réglages absents : webmail non configuré */ }
    if (!url) return false;
    await o.ouvrirExterne(url);
    return true;
  }));
}

module.exports = { CoffreSecrets, registerComptesIPC, CLE_RE, VALEUR_MAX };
