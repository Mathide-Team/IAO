'use strict';

// Issue #138 : lib/copy-text.js (copie de l'e-mail d'un compte) + câblage UI.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const LIB = path.join(ROOT, 'lib', 'copy-text.js');
const { copyText } = require(LIB);

function fakeDocument({ execResult = true, execThrows = false } = {}) {
  const children = [];
  const doc = {
    body: {
      appendChild: (el) => { children.push(el); },
      removeChild: (el) => { children.splice(children.indexOf(el), 1); }
    },
    children,
    execCalls: 0,
    selected: null,
    createElement: () => {
      const el = { style: {}, attrs: {}, value: '' };
      el.setAttribute = (k, v) => { el.attrs[k] = v; };
      el.select = () => { doc.selected = el.value; };
      return el;
    },
    execCommand: (cmd) => {
      doc.execCalls++;
      assert.equal(cmd, 'copy');
      if (execThrows) throw new Error('boom');
      return execResult;
    }
  };
  return doc;
}

test('copyText : API clipboard.writeText utilisée en priorité', async () => {
  const written = [];
  const doc = fakeDocument();
  const ok = await copyText('a@b.fr', { clipboard: { writeText: async (t) => { written.push(t); } }, document: doc });
  assert.equal(ok, true);
  assert.deepEqual(written, ['a@b.fr']);
  assert.equal(doc.execCalls, 0, 'pas de repli si l\'API réussit');
});

test('copyText : repli execCommand si writeText est refusé', async () => {
  const doc = fakeDocument();
  const ok = await copyText('a@b.fr', { clipboard: { writeText: async () => { throw new Error('denied'); } }, document: doc });
  assert.equal(ok, true);
  assert.equal(doc.selected, 'a@b.fr');
  assert.equal(doc.children.length, 0, 'textarea temporaire retiré');
});

test('copyText : repli execCommand sans API clipboard', async () => {
  const doc = fakeDocument();
  assert.equal(await copyText('x@y.fr', { document: doc }), true);
  assert.equal(doc.execCalls, 1);
});

test('copyText : execCommand renvoie false ou lève -> false, textarea retiré', async () => {
  const d1 = fakeDocument({ execResult: false });
  assert.equal(await copyText('x', { document: d1 }), false);
  assert.equal(d1.children.length, 0);
  const d2 = fakeDocument({ execThrows: true });
  assert.equal(await copyText('x', { document: d2 }), false);
  assert.equal(d2.children.length, 0);
});

test('copyText : texte vide/null ou aucun moyen de copie -> false', async () => {
  assert.equal(await copyText('', { document: fakeDocument() }), false);
  assert.equal(await copyText(null, { document: fakeDocument() }), false);
  assert.equal(await copyText(undefined), false);
  assert.equal(await copyText('x', {}), false);
  assert.equal(await copyText('x', { document: { execCommand: () => true } }), false, 'pas de body');
  assert.equal(await copyText('x', { clipboard: {}, document: {} }), false);
});

test('copyText : chargé dans le renderer, exposé sur window', () => {
  global.window = {};
  try {
    delete require.cache[LIB];
    require(LIB);
    assert.equal(typeof global.window.copyText, 'function');
  } finally {
    delete global.window;
    delete require.cache[LIB];
  }
});

test('#138 : e-mail cliquable câblé (index.html, app.js, app.css)', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf-8');
  const app = fs.readFileSync(path.join(ROOT, 'assets', 'app.js'), 'utf-8');
  const css = fs.readFileSync(path.join(ROOT, 'assets', 'app.css'), 'utf-8');
  assert.ok(html.includes('<script src="lib/copy-text.js"></script>'));
  assert.match(app, /data-action="copy-email" data-acc="\$\{id\}"/);
  assert.match(app, /case 'copy-email':\s+copyAccountEmail\(accId\)/);
  assert.match(app, /copyText\(acc\.email, \{ clipboard: navigator\.clipboard, document \}\)/);
  assert.ok(css.includes('.account-email-copy'));
});

test('copyText : sans environnement (env absent) -> false, sans lever', async () => {
  assert.equal(await copyText('x'), false);
});
