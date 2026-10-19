'use strict';

// lib/comptes-serie.js — création de comptes en série (issue #201). PUR :
// chargé par le renderer (<script src>, window.iaoComptesSerie) et par
// node --test (module.exports). L'aléa est injecté (crypto.getRandomValues).
//
// Un compte de la série : nom = numéro, profil = profil_<numéro>,
// e-mail = <préfixe><numéro>@<domaine>. Numérotation : à la suite du plus
// grand numéro existant (noms numériques et profils profil_<n>).

var SERIE_MAX = 50;
var MOT_DE_PASSE_LONGUEUR = 20;
// Sans caractères ambigus (0/O, 1/l/I) ni caractères gênants dans un shell.
var ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789-_.+=';

function plusGrandNumero(comptes) {
  var max = 0;
  (Array.isArray(comptes) ? comptes : []).forEach(function(a) {
    var m1 = /^\d+$/.exec(String(a && a.name || '').trim());
    var m2 = /^profil_(\d+)$/.exec(String(a && a.profile || ''));
    if (m1) max = Math.max(max, Number(m1[0]));
    if (m2) max = Math.max(max, Number(m2[1]));
  });
  return max;
}

// Comptes à créer ; renvoie { ok, comptes } ou { ok: false, erreur }.
// options : { comptes, nombre, prefixe, domaine, services, maintenant }.
function comptesEnSerie(options) {
  var o = options || {};
  var n = Number(o.nombre);
  if (!Number.isInteger(n) || n < 1 || n > SERIE_MAX) return { ok: false, erreur: 'nombre' };
  if (!o.domaine) return { ok: false, erreur: 'domaine' };
  var depart = plusGrandNumero(o.comptes) + 1;
  var horodatage = Number(o.maintenant) || 0;
  var services = Array.isArray(o.services) ? o.services.slice() : [];
  var liste = [];
  for (var i = 0; i < n; i++) {
    var numero = depart + i;
    liste.push({
      id: 'acc_' + horodatage + '_' + numero,
      name: String(numero),
      email: (o.prefixe || '') + numero + '@' + o.domaine,
      profile: 'profil_' + numero,
      services: services.slice()
    });
  }
  return { ok: true, comptes: liste };
}

// Mot de passe aléatoire, tirage uniforme (rejet des octets >= 256 - 256 % taille).
// `aleatoire(n)` renvoie un Uint8Array de n octets.
function genererMotDePasse(aleatoire, longueur) {
  var l = longueur || MOT_DE_PASSE_LONGUEUR;
  var taille = ALPHABET.length;
  var limite = 256 - (256 % taille);
  var sortie = '';
  while (sortie.length < l) {
    var octets = aleatoire(l * 2);
    for (var i = 0; i < octets.length && sortie.length < l; i++) {
      if (octets[i] < limite) sortie += ALPHABET[octets[i] % taille];
    }
  }
  return sortie;
}

var iaoComptesSerie = {
  SERIE_MAX: SERIE_MAX, MOT_DE_PASSE_LONGUEUR: MOT_DE_PASSE_LONGUEUR, ALPHABET: ALPHABET,
  plusGrandNumero: plusGrandNumero, comptesEnSerie: comptesEnSerie, genererMotDePasse: genererMotDePasse
};
if (typeof window !== 'undefined') window.iaoComptesSerie = iaoComptesSerie;
else module.exports = iaoComptesSerie;
