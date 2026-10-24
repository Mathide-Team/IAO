'use strict';

// Garde-fou (issue #291) : l'ancien nom mal orthographié de l'organisation
// GitHub ne correspond à aucun compte. Quiconque l'enregistrerait recevrait
// les liens de téléchargement, de documentation et de rapport de traduction.
// Aucun fichier suivi par git ne doit donc le contenir.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
// Assemblé en deux morceaux pour que ce fichier ne contienne pas le nom fautif.
const NOM_FAUTIF = 'Mathide' + '-Team';
const NOM_CORRECT = 'Mathilde-Team';

function fichiersSuivis() {
  return execFileSync('git', ['ls-files', '-z'], { cwd: ROOT })
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .map((nom) => path.join(ROOT, nom));
}

const gitDisponible = fs.existsSync(path.join(ROOT, '.git'));

test('aucun fichier suivi ne contient le nom fautif', { skip: !gitDisponible && 'dépôt git indisponible' }, () => {
  const fautif = Buffer.from(NOM_FAUTIF);
  const fautifs = fichiersSuivis()
    .filter((f) => fs.existsSync(f) && fs.statSync(f).isFile())
    .filter((f) => fs.readFileSync(f).includes(fautif))
    .map((f) => path.relative(ROOT, f));
  assert.deepEqual(fautifs, []);
});

test('le lien de la dernière release pointe vers l\'organisation', () => {
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  assert.ok(readme.includes(`https://github.com/${NOM_CORRECT}/IAO/releases`));
});

test('le script i18n signale les erreurs de traduction à l\'organisation', () => {
  const script = fs.readFileSync(path.join(ROOT, 'scripts', 'i18n-update.sh'), 'utf8');
  assert.ok(script.includes(`https://github.com/${NOM_CORRECT}/IAO/issues`));
});
