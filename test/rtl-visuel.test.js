'use strict';
// Tests du module de vérification visuelle RTL du harnais (issue #51),
// sans Electron : comparaison des mesures, corrélation, profil des captures.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const rtl = require('../test-electron/rtl-visuel');

const W = 1000;
function mesuresFr() {
  return {
    dir: 'ltr', rtl: false, largeur: W, largeurDefilement: W,
    zones: { dashboard: { left: 0, right: 380, width: 380 }, zoneIA: { left: 380, right: 1000, width: 620 } },
    libelles: { titreComptes: 0 },
    debordements: ['div.existant'],
    glisser: -rtl.DEPLACEMENT_PX
  };
}
function mesuresAr() {
  return {
    dir: 'rtl', rtl: true, largeur: W, largeurDefilement: W,
    zones: { dashboard: { left: 620, right: 1000, width: 380 }, zoneIA: { left: 0, right: 620, width: 620 } },
    libelles: { titreComptes: 2 },
    debordements: ['div.existant'],
    glisser: rtl.DEPLACEMENT_PX
  };
}
// Fausse NativeImage : une bande sombre de `bande` colonnes à gauche ou à droite.
function image(largeur, bande, aDroite) {
  const h = 2;
  const buf = Buffer.alloc(largeur * h * 4, 255);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < largeur; x++) {
      const sombre = aDroite ? x >= largeur - bande : x < bande;
      if (sombre) { const i = (y * largeur + x) * 4; buf[i] = buf[i + 1] = buf[i + 2] = 10; }
    }
  }
  return { getSize: () => ({ width: largeur, height: h }), toBitmap: () => buf };
}

test('comparer : un miroir exact ne produit aucun écart', () => {
  assert.deepStrictEqual(rtl.comparer(mesuresFr(), mesuresAr()), []);
});

test('comparer : directions, défilement et nouveaux débordements', () => {
  const fr = mesuresFr(); fr.rtl = true;
  const ar = mesuresAr(); ar.rtl = false; ar.dir = 'ltr';
  ar.largeurDefilement = W + 40; ar.debordements = ['div.existant', 'span.nouveau'];
  const e = rtl.comparer(fr, ar);
  assert.ok(e.some((x) => x.includes('direction attendue rtl')));
  assert.ok(e.some((x) => x.includes('français : direction attendue ltr')));
  assert.ok(e.some((x) => x.includes('défilement horizontal')));
  assert.ok(e.some((x) => x.includes('span.nouveau') && !x.includes('div.existant')));
});

test('comparer : zone non retournée, largeur modifiée ou absente', () => {
  const ar = mesuresAr();
  ar.zones.dashboard = { left: 0, right: 380, width: 380 }; // restée à gauche
  ar.zones.zoneIA = { left: 0, right: 600, width: 600 };    // 20 px de moins
  const e = rtl.comparer(mesuresFr(), ar);
  assert.ok(e.some((x) => x.startsWith('zone dashboard : bord gauche 0 px, attendu 620 px')));
  assert.ok(e.some((x) => x.startsWith('zone zoneIA : largeur 600 px')));
  delete ar.zones.zoneIA;
  assert.ok(rtl.comparer(mesuresFr(), ar).includes('zone zoneIA absente en arabe'));
});

test('comparer : retrait des libellés et tolérance explicite', () => {
  const ar = mesuresAr(); ar.libelles.titreComptes = 30;
  assert.ok(rtl.comparer(mesuresFr(), ar).some((x) => x.includes('libellé titreComptes : retrait 30 px')));
  assert.deepStrictEqual(rtl.comparer(mesuresFr(), ar, 40), []);
  delete ar.libelles.titreComptes;
  assert.ok(rtl.comparer(mesuresFr(), ar).includes('libellé titreComptes absent en arabe'));
});

test('comparer : sens des poignées, contrôle ignoré si non mesuré', () => {
  const fr = mesuresFr(); fr.glisser = 0;
  const ar = mesuresAr(); ar.glisser = -rtl.DEPLACEMENT_PX;
  const e = rtl.comparer(fr, ar);
  assert.ok(e.some((x) => x.startsWith('français : poignée')));
  assert.ok(e.some((x) => x.startsWith('arabe : poignée') && x.includes('sens inversé')));
  delete fr.glisser; delete ar.glisser;
  assert.deepStrictEqual(rtl.comparer(fr, mesuresAr()), []);
});

test('comparer : captures en miroir acceptées, captures identiques refusées', () => {
  const fr = mesuresFr(); fr.png = image(20, 6, false);
  const ar = mesuresAr(); ar.png = image(20, 6, true);
  assert.deepStrictEqual(rtl.comparer(fr, ar), []);
  assert.deepStrictEqual(ar.correlation, { miroir: 1, direct: Number(rtl.correlation(
    rtl.profilColonnes(fr.png.toBitmap(), 20, 2), rtl.profilColonnes(ar.png.toBitmap(), 20, 2)).toFixed(3)) });
  const ar2 = mesuresAr(); ar2.png = image(20, 6, false); // panneau resté à gauche
  assert.ok(rtl.comparer(fr, ar2).some((x) => x.startsWith('captures : profil arabe retourné')));
});

test('correlation et profilColonnes : cas limites', () => {
  assert.strictEqual(rtl.correlation([], []), 0);
  assert.strictEqual(rtl.correlation([1, 2], [1, 2, 3]), 0);
  assert.strictEqual(rtl.correlation([5, 5, 5], [1, 2, 3]), 0);
  assert.ok(Math.abs(rtl.correlation([1, 2, 3], [3, 2, 1]) + 1) < 1e-9);
  const p = rtl.profilColonnes(image(4, 1, false).toBitmap(), 4, 2);
  assert.strictEqual(p.length, 4);
  assert.ok(p[0] < 20 && p[1] > 250);
});

test('sansImage, dossierCaptures et script de mesure', () => {
  const m = Object.assign(mesuresFr(), { png: {} });
  const c = rtl.sansImage(m);
  assert.ok(!('png' in c) && 'png' in m);
  const choisi = fs.mkdtempSync(path.join(os.tmpdir(), 'iao-rtl-')) + '/sous/dossier';
  assert.strictEqual(rtl.dossierCaptures(choisi), choisi);
  assert.ok(fs.statSync(choisi).isDirectory());
  assert.strictEqual(rtl.dossierCaptures(), path.join(os.tmpdir(), 'iao-captures'));
  for (const sel of Object.values(rtl.ZONES).concat(Object.values(rtl.LIBELLES))) {
    assert.ok(rtl.SCRIPT_MESURE.includes(JSON.stringify(sel).slice(1, -1)), sel);
  }
  assert.ok(rtl.SCRIPT_GLISSER.includes('x - ' + rtl.DEPLACEMENT_PX));
  assert.doesNotThrow(() => new Function('return ' + rtl.SCRIPT_MESURE));
  assert.doesNotThrow(() => new Function('return ' + rtl.SCRIPT_GLISSER));
});
