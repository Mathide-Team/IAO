'use strict';

// lib/startup-storage.js — état du dossier de données au démarrage (issue #203).
//
// Les bugs #184 (« Failed to delete the database ») et #186 (comptes non
// chargés) ont été signalés sans que iao.log dise dans quel état était le
// stockage. Ces fonctions PURES (fs injecté) résument, à chaque démarrage et
// hors mode debug : dossier utilisé, Local Storage (fichiers, octets),
// partitions et partitions ayant un dossier `Service Worker` (piste #184 :
// cleanupServiceWorkerStorage() ne nettoie que celui de la fenêtre
// principale). Complète #196 (comptes lus) et #197 (propriétaires des
// fichiers), sans les dupliquer.

const path = require('path');

// `fsLike` : { existsSync, readdirSync, lstatSync }. Ne lève jamais.
function inspecterDonnees(userData, fsLike) {
  const info = {
    dossier: userData,
    existe: false,
    localStorage: { existe: false, fichiers: 0, octets: 0 },
    partitions: 0,
    partitionsServiceWorker: 0,
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
  return info;
}

function resumeDonnees(info) {
  if (!info.existe) return 'Dossier de données absent (premier lancement ?) : ' + info.dossier;
  const ls = info.localStorage;
  return 'Dossier de données ' + info.dossier + ' — Local Storage : ' +
    (ls.existe ? ls.fichiers + ' fichier(s), ' + ls.octets + ' octet(s)' : 'absent') +
    ' — partitions : ' + info.partitions +
    ' (dont ' + info.partitionsServiceWorker + ' avec un dossier Service Worker).';
}

// Ligne info, puis un avertissement par erreur d'inspection.
function journaliserDonnees(info, log) {
  log('demarrage', 'info', resumeDonnees(info));
  for (const e of info.erreurs) log('demarrage', 'warning', 'Inspection du dossier de données : ' + e);
}

module.exports = { inspecterDonnees, resumeDonnees, journaliserDonnees };
