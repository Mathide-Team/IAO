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

// Issue #7 : sommes sur les fichiers publiés et attestation de provenance
// Sigstore, dans release.yml (tag v*) ET cd.yml (nightly).
const cd = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'cd.yml'), 'utf8');

for (const [nom, contenu] of [['release.yml', wf], ['cd.yml', cd]]) {
  test(nom + ' : sommes SHA-256 des fichiers publiés, zip Windows compris', () => {
    assert.match(contenu, /files=\( \*\.deb \*\.AppImage \*\.zip \)/);
    assert.match(contenu, /\[ "\$\{#files\[@\]\}" -ge 3 \]/, 'un artefact manquant doit faire échouer la publication');
    assert.match(contenu, /sha256sum -c SHA256SUMS\.txt/);
    assert.doesNotMatch(contenu, /Get-FileHash \*\.exe/, 'ancienne somme Windows vide (exe dans dist/IAO-win32-x64/)');
  });

  test(nom + ' : attestation de provenance après les sommes, permissions OIDC du job', () => {
    const sommes = contenu.indexOf('sha256sum "${files[@]}" > SHA256SUMS.txt');
    const attestation = contenu.indexOf('uses: actions/attest-build-provenance@');
    const publication = contenu.indexOf('uses: softprops/action-gh-release@');
    assert.ok(sommes !== -1 && attestation > sommes && publication > attestation,
      'ordre attendu : sommes, attestation, publication');
    for (const ext of ['deb', 'AppImage', 'zip']) {
      assert.match(contenu, new RegExp('release-assets/\\*\\.' + ext), 'sujet de l\'attestation : *.' + ext);
    }
    assert.match(contenu, /permissions:\n {6}contents: write\n {6}id-token: write\n {6}attestations: write/);
    assert.match(contenu, /gh attestation verify <fichier> --repo/);
  });
}
