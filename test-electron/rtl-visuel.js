'use strict';
// ---------------------------------------------------------------------------
// test-electron/rtl-visuel.js — vérification visuelle de la mise en page de
// droite à gauche (issue #51), utilisée par le scénario C7.5 du harnais.
//
// Principe : l'interface est rendue en français (ltr) puis en arabe (rtl).
//   1. SCRIPT_MESURE (exécuté dans le renderer) relève les rectangles des
//      zones structurantes, les débordements horizontaux et le décalage des
//      libellés par rapport à leur bord de départ.
//   2. comparer() vérifie que l'arabe est le MIROIR du français : chaque zone
//      occupe la position symétrique, avec la même largeur ; aucun nouveau
//      débordement ; les libellés partent du bord droit avec le même retrait.
//   3. Poignée de redimensionnement : tirée vers la gauche, elle rétrécit le
//      panneau éditeur en ltr et l'élargit en rtl (SCRIPT_GLISSER).
//   4. Contrôle pixel : le profil de luminance par colonne de la capture arabe,
//      retourné, doit ressembler à celui du français (corrélation), et
//      davantage que le profil non retourné : les panneaux ont bien changé de
//      côté à l'écran, pas seulement dans le DOM.
// Les captures PNG et un rapport JSON sont écrits dans un dossier publié
// comme artefact par la CI, pour une relecture humaine.
//
// Les fonctions de comparaison sont pures et testées par
// test/rtl-visuel.test.js (sans Electron).
// ---------------------------------------------------------------------------

const fs = require('fs');
const os = require('os');
const path = require('path');

// Zones dont la position doit être symétrique entre ltr et rtl.
const ZONES = {
  dashboard: '.dashboard',
  espaceTravail: '.workspace-container',
  zoneIA: '#aiArea',
  marque: '.app-brand',
  statistiques: '.dashboard .stats',
  titreComptes: '.section-title--accounts',
  premiereCarte: '#accountsList > *:first-child',
  ongletVide: '#tabsEmpty'
};

// Libellés dont le retrait depuis le bord de départ doit être conservé.
const LIBELLES = {
  titreComptes: '.section-title--accounts > span',
  carteActifs: '.stat-card:first-child .stat-card__label'
};

const TOLERANCE_PX = 8;
const CORRELATION_MIN = 0.8;

// Script autonome évalué par executeJavaScript : ne doit rien capturer.
const SCRIPT_MESURE = `(() => {
  const ZONES = ${JSON.stringify(ZONES)};
  const LIBELLES = ${JSON.stringify(LIBELLES)};
  const W = window.innerWidth;
  const rect = (el) => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, width: r.width }; };
  const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const zones = {};
  for (const [k, sel] of Object.entries(ZONES)) { const el = document.querySelector(sel); if (el && visible(el)) zones[k] = rect(el); }
  const rtl = getComputedStyle(document.documentElement).direction === 'rtl';
  const libelles = {};
  for (const [k, sel] of Object.entries(LIBELLES)) {
    const el = document.querySelector(sel); if (!el || !visible(el)) continue;
    const p = el.parentElement.getBoundingClientRect(); const r = el.getBoundingClientRect();
    libelles[k] = Math.round(rtl ? p.right - r.right : r.left - p.left);
  }
  // Débordements : éléments visibles (hors overlays masqués) sortant de la fenêtre.
  const debordements = [];
  for (const el of document.querySelectorAll('.dashboard *, .workspace-header *, #aiArea *')) {
    if (!visible(el) || el.closest('.hidden, .collapsed, [aria-hidden="true"]')) continue;
    const r = el.getBoundingClientRect();
    if (r.left < -1 || r.right > W + 1) {
      debordements.push((el.id ? '#' + el.id : el.tagName.toLowerCase() + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\\s+/)[0] : '')));
    }
  }
  return {
    dir: document.documentElement.dir || 'ltr', rtl, largeur: W,
    largeurDefilement: document.documentElement.scrollWidth,
    zones, libelles, debordements: Array.from(new Set(debordements)).sort()
  };
})()`;

// Glisser la poignée éditeur ↔ IA de 60 px vers la GAUCHE et relever la
// variation de largeur du panneau éditeur : -60 en ltr (panneau à gauche),
// +60 en rtl (panneau à droite). Remet ensuite l'état initial.
const DEPLACEMENT_PX = 60;
const SCRIPT_GLISSER = `(async () => {
  const ide = document.getElementById('idePanel');
  const poignee = document.getElementById('resizerIde');
  const ferme = ide.classList.contains('collapsed');
  if (ferme) window.toggleIdePanel();
  await new Promise((r) => setTimeout(r, 350));
  const avant = ide.getBoundingClientRect().width;
  const r = poignee.getBoundingClientRect();
  const x = r.left + r.width / 2, y = r.top + r.height / 2;
  poignee.dispatchEvent(new MouseEvent('mousedown', { clientX: x, clientY: y, bubbles: true }));
  document.dispatchEvent(new MouseEvent('mousemove', { clientX: x - ${DEPLACEMENT_PX}, clientY: y, bubbles: true }));
  document.dispatchEvent(new MouseEvent('mouseup', { clientX: x - ${DEPLACEMENT_PX}, clientY: y, bubbles: true }));
  const apres = ide.getBoundingClientRect().width;
  ide.style.flex = '';
  try { localStorage.removeItem('ide_w'); } catch (e) {}
  if (ferme) window.toggleIdePanel();
  return Math.round(apres - avant);
})()`;

// Profil de luminance moyenne par colonne d'une image BGRA (toBitmap()).
function profilColonnes(bitmap, largeur, hauteur) {
  const profil = new Array(largeur).fill(0);
  for (let y = 0; y < hauteur; y++) {
    for (let x = 0; x < largeur; x++) {
      const i = (y * largeur + x) * 4;
      profil[x] += 0.0722 * bitmap[i] + 0.7152 * bitmap[i + 1] + 0.2126 * bitmap[i + 2];
    }
  }
  return profil.map((v) => v / hauteur);
}

// Corrélation de Pearson ; 0 si l'un des profils est constant ou si les
// longueurs diffèrent (comparaison impossible).
function correlation(a, b) {
  if (!a.length || a.length !== b.length) return 0;
  const n = a.length;
  const ma = a.reduce((s, v) => s + v, 0) / n;
  const mb = b.reduce((s, v) => s + v, 0) / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) { num += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
  return da && db ? num / Math.sqrt(da * db) : 0;
}

function profilImage(img) {
  const { width, height } = img.getSize();
  return profilColonnes(img.toBitmap(), width, height);
}

// Compare les mesures ltr (fr) et rtl (ar) ; renvoie la liste des écarts
// (vide = mise en page RTL correcte). m.png (NativeImage) est facultatif.
function comparer(fr, ar, tol) {
  const t = tol == null ? TOLERANCE_PX : tol;
  const ecarts = [];
  if (!ar.rtl || ar.dir !== 'rtl') ecarts.push('arabe : direction attendue rtl, trouvée ' + ar.dir);
  if (fr.rtl) ecarts.push('français : direction attendue ltr');
  if (ar.largeurDefilement > ar.largeur + 1) {
    ecarts.push('arabe : défilement horizontal (' + ar.largeurDefilement + ' px pour ' + ar.largeur + ' px)');
  }
  const nouveaux = ar.debordements.filter((d) => !fr.debordements.includes(d));
  if (nouveaux.length) ecarts.push('arabe : éléments hors de la fenêtre : ' + nouveaux.join(', '));
  const W = fr.largeur;
  for (const [k, z] of Object.entries(fr.zones)) {
    const m = ar.zones[k];
    if (!m) { ecarts.push('zone ' + k + ' absente en arabe'); continue; }
    const attendu = W - z.right;
    if (Math.abs(m.left - attendu) > t) {
      ecarts.push('zone ' + k + ' : bord gauche ' + Math.round(m.left) + ' px, attendu ' + Math.round(attendu) + ' px (miroir)');
    }
    if (Math.abs(m.width - z.width) > t) {
      ecarts.push('zone ' + k + ' : largeur ' + Math.round(m.width) + ' px, attendue ' + Math.round(z.width) + ' px');
    }
  }
  for (const [k, v] of Object.entries(fr.libelles)) {
    const m = ar.libelles[k];
    if (m == null) { ecarts.push('libellé ' + k + ' absent en arabe'); continue; }
    if (Math.abs(m - v) > t) ecarts.push('libellé ' + k + ' : retrait ' + m + ' px depuis la droite, attendu ' + v + ' px');
  }
  if (fr.glisser != null && ar.glisser != null) {
    if (fr.glisser !== -DEPLACEMENT_PX) ecarts.push('français : poignée tirée de ' + DEPLACEMENT_PX + ' px à gauche, largeur ' + fr.glisser + ' px (attendu -' + DEPLACEMENT_PX + ')');
    if (ar.glisser !== DEPLACEMENT_PX) ecarts.push('arabe : poignée tirée de ' + DEPLACEMENT_PX + ' px à gauche, largeur ' + ar.glisser + ' px (attendu +' + DEPLACEMENT_PX + ', sens inversé en rtl)');
  }
  if (fr.png && ar.png) {
    const pf = profilImage(fr.png);
    const pa = profilImage(ar.png);
    const miroir = correlation(pf, pa.slice().reverse());
    const direct = correlation(pf, pa);
    ar.correlation = { miroir: Number(miroir.toFixed(3)), direct: Number(direct.toFixed(3)) };
    if (miroir < CORRELATION_MIN || miroir <= direct) {
      ecarts.push('captures : profil arabe retourné peu ressemblant au français (miroir ' +
        miroir.toFixed(3) + ', direct ' + direct.toFixed(3) + ', minimum ' + CORRELATION_MIN + ')');
    }
  }
  return ecarts;
}

function sansImage(m) {
  const copie = Object.assign({}, m);
  delete copie.png;
  return copie;
}

// Dossier des captures : IAO_CAPTURES_DIR, sinon un dossier temporaire.
function dossierCaptures(choix) {
  const d = choix || path.join(os.tmpdir(), 'iao-captures');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

module.exports = {
  ZONES, LIBELLES, TOLERANCE_PX, CORRELATION_MIN, DEPLACEMENT_PX, SCRIPT_MESURE, SCRIPT_GLISSER,
  profilColonnes, correlation, comparer, sansImage, dossierCaptures
};
