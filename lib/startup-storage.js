'use strict';

// lib/startup-storage.js — traces de démarrage sur le stockage (issue #203).
//
// Les bugs #184 (« Failed to delete the database ») et #186 (comptes non
// chargés au démarrage) ont été signalés sans que iao.log permette de
// trancher : quel dossier de données, stockage local présent ou non, combien
// de partitions, fichiers appartenant à un autre utilisateur (root après un
// `sudo npm start`), combien de comptes lus. Ces fonctions PURES (fs injecté)
// produisent ces informations ; main.js et le renderer les écrivent dans
// iao.log à chaque démarrage, hors mode debug. Partie renderer (comptes lus) :
// lib/startup-accounts.js.

const path = require('path');

const MAX_ETRANGERS = 10;
const MAX_PARCOURS = 5000;

// Inspecte `userData`. `fsLike` : { existsSync, readdirSync, lstatSync } ;
// `uid` : identifiant de l'utilisateur courant, ou null (Windows) pour ne pas
// contrôler les propriétaires. Ne lève jamais.
function inspecterDonnees(userData, fsLike, uid) {
  const info = {
    dossier: userData,
    existe: false,
    localStorage: { existe: false, fichiers: 0, octets: 0 },
    partitions: 0,
    partitionsServiceWorker: 0,
    etrangers: [],
    etrangersTotal: 0,
    erreurs: []
  };
  try {
    info.existe = fsLike.existsSync(userData);
  } catch (e) {
    info.erreurs.push('existence : ' + e.message);
  }
  if (!info.existe) return info;

  const leveldb = path.join(userData, 'Local Storage', 'leveldb');
  try {
    if (fsLike.existsSync(leveldb)) {
      info.localStorage.existe = true;
      for (const nom of fsLike.readdirSync(leveldb)) {
        info.localStorage.fichiers++;
        info.localStorage.octets += fsLike.lstatSync(path.join(leveldb, nom)).size;
      }
    }
  } catch (e) {
    info.erreurs.push('Local Storage : ' + e.message);
  }

  const partitionsDir = path.join(userData, 'Partitions');
  try {
    if (fsLike.existsSync(partitionsDir)) {
      for (const nom of fsLike.readdirSync(partitionsDir)) {
        info.partitions++;
        if (fsLike.existsSync(path.join(partitionsDir, nom, 'Service Worker'))) {
          info.partitionsServiceWorker++;
        }
      }
    }
  } catch (e) {
    info.erreurs.push('Partitions : ' + e.message);
  }

  if (uid !== null && uid !== undefined) {
    _proprietaires(userData, fsLike, uid, info);
  }
  return info;
}

// Parcours en largeur, borné (MAX_PARCOURS entrées), sans suivre les liens.
function _proprietaires(racine, fsLike, uid, info) {
  const file = [racine];
  let vus = 0;
  while (file.length && vus < MAX_PARCOURS) {
    const courant = file.shift();
    let st;
    try {
      st = fsLike.lstatSync(courant);
    } catch (e) {
      info.erreurs.push('propriétaire : ' + e.message);
      continue;
    }
    vus++;
    if (st.uid !== uid) {
      info.etrangersTotal++;
      if (info.etrangers.length < MAX_ETRANGERS) info.etrangers.push(courant);
    }
    if (st.isDirectory()) {
      try {
        for (const nom of fsLike.readdirSync(courant)) file.push(path.join(courant, nom));
      } catch (e) {
        info.erreurs.push('lecture : ' + e.message);
      }
    }
  }
}

// Ligne de journal (info) ; les anomalies sont rendues par `alertesDonnees`.
function resumeDonnees(info) {
  if (!info.existe) return 'Dossier de données absent (premier lancement ?) : ' + info.dossier;
  const ls = info.localStorage;
  return 'Dossier de données ' + info.dossier + ' — Local Storage : ' +
    (ls.existe ? ls.fichiers + ' fichier(s), ' + ls.octets + ' octet(s)' : 'absent') +
    ' — partitions : ' + info.partitions +
    ' (dont ' + info.partitionsServiceWorker + ' avec un dossier Service Worker).';
}

// Avertissements à journaliser (liste éventuellement vide).
function alertesDonnees(info) {
  const alertes = [];
  if (info.etrangersTotal) {
    alertes.push(info.etrangersTotal + ' fichier(s) du dossier de données appartiennent à un autre ' +
      'utilisateur (lancement avec sudo ?), Chromium ne peut pas les modifier : ' +
      info.etrangers.join(', ') + (info.etrangersTotal > info.etrangers.length ? ', …' : ''));
  }
  for (const e of info.erreurs) alertes.push('Inspection du dossier de données : ' + e);
  return alertes;
}

// Utilisateur courant (POSIX) ; null sous Windows : pas de contrôle des propriétaires.
function uidCourant(proc) {
  return typeof proc.getuid === 'function' ? proc.getuid() : null;
}

// Canal renderer -> iao.log : portée et niveau bornés, message tronqué.
const NIVEAUX_RENDERER = Object.freeze(['info', 'warning']);
function messageRenderer(portee, niveau, message) {
  const p = /^[a-z][a-z0-9-]{0,30}$/.test(String(portee)) ? String(portee) : 'renderer';
  const n = NIVEAUX_RENDERER.includes(niveau) ? niveau : 'info';
  return { portee: 'renderer:' + p, niveau: n, message: String(message).slice(0, 1000) };
}

module.exports = {
  MAX_ETRANGERS, MAX_PARCOURS, NIVEAUX_RENDERER,
  inspecterDonnees, resumeDonnees, alertesDonnees,
  uidCourant, messageRenderer
};
