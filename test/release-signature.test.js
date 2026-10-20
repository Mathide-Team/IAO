'use strict';

// Issue #7 : signature GPG des sommes SHA-256, conditionnelle au secret.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const wf = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'release.yml'), 'utf8');

test('release.yml : sommes SHA-256 puis signature GPG conditionnelle', () => {
  const sommes = wf.indexOf('sha256sum "${files[@]}" > SHA256SUMS.txt');
  const signature = wf.indexOf('--detach-sign');
  assert.ok(sommes !== -1 && signature > sommes, 'la signature doit suivre le calcul des sommes');
  assert.match(wf, /IAO_GPG_PRIVATE_KEY: \$\{\{ secrets\.IAO_GPG_PRIVATE_KEY \}\}/);
  assert.match(wf, /if \[ -z "\$IAO_GPG_PRIVATE_KEY" \]; then[\s\S]*?exit 0/, 'sans secret, l\'étape doit passer sans signer');
});

test('release.yml : trousseau temporaire, runner auto-hébergé non modifié', () => {
  assert.match(wf, /export GNUPGHOME="\$\(mktemp -d\)"/);
  assert.match(wf, /trap '[^']*rm -rf "\$GNUPGHOME"' EXIT/);
  assert.match(wf, /gpg --batch --verify SHA256SUMS\.txt\.asc SHA256SUMS\.txt/);
  assert.match(wf, /IAO-signature\.asc/);
});
