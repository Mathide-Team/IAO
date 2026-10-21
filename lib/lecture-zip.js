'use strict';

// lib/lecture-zip.js — lecture d'un fichier dans une archive ZIP, sans shell
// (issue #275).
//
// L'analyse de complétude lisait le FEATURES.md d'un ZIP livré avec
// `unzip` / PowerShell, par des commandes construites en concaténant le chemin
// du ZIP (nom choisi par le service IA) et le nom de l'entrée (contenu de
// l'archive) : un `$(…)` dans l'un ou l'autre était exécuté par le shell.
// Ce module lit l'archive lui-même : répertoire central, puis données de
// l'entrée, décompressées par zlib (méthodes « stocké » et « deflate »). Les
// noms sont des données, jamais des arguments de commande ; aucun outil
// système, aucune dépendance npm (invariant 7).
//
// Garde-fous : taille extraite bornée (ZIP bombe), taille et CRC-32 vérifiés,
// archive tronquée ou incohérente refusée ; ZIP64, archives multi-volumes et
// entrées chiffrées refusées explicitement (inutiles pour un FEATURES.md).
//
// La lecture passe par un « lecteur » (taille + lire(position, longueur)) :
// on ne charge que la fin de l'archive et l'entrée voulue, pas tout le ZIP.

const zlib = require('zlib');

const SIG_FIN = 0x06054b50; // fin du répertoire central (EOCD)
const SIG_CENTRAL = 0x02014b50; // en-tête du répertoire central
const SIG_LOCAL = 0x04034b50; // en-tête local
const TAILLE_FIN = 22;
const COMMENTAIRE_MAX = 0xffff;
const TAILLE_CENTRAL = 46;
const TAILLE_LOCAL = 30;
const METHODE_STOCKE = 0;
const METHODE_DEFLATE = 8;
const DRAPEAU_CHIFFRE = 0x0001;
const DRAPEAU_UTF8 = 0x0800;
const TAILLE_MAX_DEFAUT = 1024 * 1024; // 1 Mio : large pour un FEATURES.md

class ErreurZip extends Error {
  constructor(message) {
    super(message);
    this.name = 'ErreurZip';
  }
}

// CRC-32 (polynôme 0xEDB88320), table calculée une fois : zlib.crc32 n'existe
// pas dans toutes les versions de Node embarquées par Electron.
const TABLE_CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = TABLE_CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// Lecteur sur un Buffer en mémoire (tests, petites archives).
function lecteurDeBuffer(buf) {
  return {
    taille: buf.length,
    lire(position, longueur) {
      if (position < 0 || position + longueur > buf.length) throw new ErreurZip('ZIP tronqué');
      return buf.subarray(position, position + longueur);
    }
  };
}

// Lecteur sur un descripteur de fichier ouvert (fs injecté pour les tests).
function lecteurDeFichier(fd, fs) {
  const taille = fs.fstatSync(fd).size;
  return {
    taille,
    lire(position, longueur) {
      if (position < 0 || position + longueur > taille) throw new ErreurZip('ZIP tronqué');
      const buf = Buffer.alloc(longueur);
      let lus = 0;
      while (lus < longueur) {
        const n = fs.readSync(fd, buf, lus, longueur - lus, position + lus);
        if (n === 0) throw new ErreurZip('ZIP tronqué');
        lus += n;
      }
      return buf;
    }
  };
}

// Repère la fin du répertoire central : dernière signature EOCD dont la
// longueur de commentaire tombe exactement sur la fin du fichier.
function trouverFin(lecteur) {
  if (lecteur.taille < TAILLE_FIN) throw new ErreurZip("pas une archive ZIP (fichier trop court)");
  const longueur = Math.min(lecteur.taille, TAILLE_FIN + COMMENTAIRE_MAX);
  const debut = lecteur.taille - longueur;
  const queue = lecteur.lire(debut, longueur);
  for (let i = queue.length - TAILLE_FIN; i >= 0; i--) {
    if (queue.readUInt32LE(i) === SIG_FIN && i + TAILLE_FIN + queue.readUInt16LE(i + 20) === queue.length) {
      return {
        disque: queue.readUInt16LE(i + 4),
        disqueCentral: queue.readUInt16LE(i + 6),
        entreesDisque: queue.readUInt16LE(i + 8),
        entrees: queue.readUInt16LE(i + 10),
        tailleCentral: queue.readUInt32LE(i + 12),
        decalageCentral: queue.readUInt32LE(i + 16)
      };
    }
  }
  throw new ErreurZip("pas une archive ZIP (fin du répertoire central introuvable)");
}

// Liste des entrées, dans l'ordre du répertoire central.
function lireEntrees(lecteur) {
  const fin = trouverFin(lecteur);
  if (fin.entrees === 0xffff || fin.tailleCentral === 0xffffffff || fin.decalageCentral === 0xffffffff) {
    throw new ErreurZip('ZIP64 non pris en charge');
  }
  if (fin.disque !== 0 || fin.disqueCentral !== 0 || fin.entreesDisque !== fin.entrees) {
    throw new ErreurZip('archive en plusieurs volumes non prise en charge');
  }
  const central = lecteur.lire(fin.decalageCentral, fin.tailleCentral);
  const entrees = [];
  let p = 0;
  for (let n = 0; n < fin.entrees; n++) {
    if (p + TAILLE_CENTRAL > central.length || central.readUInt32LE(p) !== SIG_CENTRAL) {
      throw new ErreurZip('répertoire central invalide');
    }
    const drapeaux = central.readUInt16LE(p + 8);
    const lgNom = central.readUInt16LE(p + 28);
    const lgExtra = central.readUInt16LE(p + 30);
    const lgCommentaire = central.readUInt16LE(p + 32);
    const suivant = p + TAILLE_CENTRAL + lgNom + lgExtra + lgCommentaire;
    if (suivant > central.length) throw new ErreurZip('répertoire central invalide');
    const brut = central.subarray(p + TAILLE_CENTRAL, p + TAILLE_CENTRAL + lgNom);
    // Sans le drapeau UTF-8, le nom est en CP437 ; latin1 en est une
    // approximation suffisante (un nom ASCII comme FEATURES.md est identique).
    const nom = brut.toString(drapeaux & DRAPEAU_UTF8 ? 'utf8' : 'latin1');
    entrees.push({
      nom,
      dossier: nom.endsWith('/'),
      chiffre: Boolean(drapeaux & DRAPEAU_CHIFFRE),
      methode: central.readUInt16LE(p + 10),
      crc: central.readUInt32LE(p + 16),
      tailleCompressee: central.readUInt32LE(p + 20),
      taille: central.readUInt32LE(p + 24),
      decalageLocal: central.readUInt32LE(p + 42)
    });
    p = suivant;
  }
  return entrees;
}

// Contenu décompressé d'une entrée, vérifié (taille annoncée et CRC-32).
function extraire(lecteur, entree, options) {
  const tailleMax = (options && options.tailleMax) || TAILLE_MAX_DEFAUT;
  if (entree.chiffre) throw new ErreurZip('entrée chiffrée : ' + entree.nom);
  if (entree.methode !== METHODE_STOCKE && entree.methode !== METHODE_DEFLATE) {
    throw new ErreurZip('méthode de compression ' + entree.methode + ' non prise en charge : ' + entree.nom);
  }
  if (entree.taille > tailleMax) {
    throw new ErreurZip('entrée trop grande (' + entree.taille + ' octets, limite ' + tailleMax + ') : ' + entree.nom);
  }
  const local = lecteur.lire(entree.decalageLocal, TAILLE_LOCAL);
  if (local.readUInt32LE(0) !== SIG_LOCAL) throw new ErreurZip('en-tête local invalide : ' + entree.nom);
  const debutDonnees = entree.decalageLocal + TAILLE_LOCAL + local.readUInt16LE(26) + local.readUInt16LE(28);
  const compresse = lecteur.lire(debutDonnees, entree.tailleCompressee);
  let donnees;
  if (entree.methode === METHODE_STOCKE) {
    donnees = compresse;
  } else {
    try {
      // maxOutputLength : la décompression s'arrête à la limite, même si la
      // taille annoncée ment (ZIP bombe).
      donnees = zlib.inflateRawSync(compresse, { maxOutputLength: tailleMax });
    } catch (e) {
      throw new ErreurZip('décompression impossible (' + (e.code || e.message) + ') : ' + entree.nom);
    }
  }
  if (donnees.length !== entree.taille) throw new ErreurZip('taille incohérente : ' + entree.nom);
  if (crc32(donnees) !== entree.crc) throw new ErreurZip('CRC incorrect : ' + entree.nom);
  return donnees;
}

// Première entrée (ordre de l'archive) dont le nom de fichier, hors dossier,
// est exactement FEATURES.md (casse ignorée).
function trouverFeaturesMd(entrees) {
  return entrees.find((e) => !e.dossier && /^FEATURES\.md$/i.test(e.nom.split('/').pop())) || null;
}

// Point d'entrée de l'ordonnanceur : texte du FEATURES.md de l'archive, ou
// null s'il n'y en a pas. Lève ErreurZip si l'archive est illisible.
function lireFeaturesMd(cheminZip, deps) {
  const fs = (deps && deps.fs) || require('fs');
  const fd = fs.openSync(cheminZip, 'r');
  try {
    const lecteur = lecteurDeFichier(fd, fs);
    const entree = trouverFeaturesMd(lireEntrees(lecteur));
    if (!entree) return null;
    return { nom: entree.nom, contenu: extraire(lecteur, entree, deps).toString('utf8') };
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = {
  ErreurZip,
  TAILLE_MAX_DEFAUT,
  crc32,
  lecteurDeBuffer,
  lecteurDeFichier,
  lireEntrees,
  extraire,
  trouverFeaturesMd,
  lireFeaturesMd
};
