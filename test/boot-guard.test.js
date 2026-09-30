'use strict';

// test/boot-guard.test.js — assets/boot-guard.js (issue #99, tâche 55.30).
//
// boot-guard.js tourne dans le renderer (<script src>), jamais via require() :
// on l'exécute dans un bac à sable `vm` avec `window`, `document` et `console`
// simulés (mini-DOM ci-dessous), comme test/icons.test.js le fait pour
// assets/icons.js. Le script est compilé UNE fois puis exécuté dans autant de
// contextes que de cas, pour que la couverture V8 s'additionne.

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const diagnostics = require('../lib/startup-diagnostics');

const FILE = path.join(__dirname, '..', 'assets', 'boot-guard.js');
const SCRIPT = new vm.Script(fs.readFileSync(FILE, 'utf8'), { filename: FILE });

// --- Mini-DOM --------------------------------------------------------------

function makeElement(tag) {
  const el = {
    tagName: String(tag).toUpperCase(),
    id: '',
    className: '',
    textContent: '',
    type: '',
    children: [],
    attrs: {},
    listeners: {},
    get firstChild() { return this.children[0] || null; },
    setAttribute(name, value) { this.attrs[name] = String(value); },
    getAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null; },
    appendChild(child) { this.children.push(child); return child; },
    insertBefore(child, ref) {
      const i = ref ? this.children.indexOf(ref) : -1;
      if (i < 0) this.children.push(child); else this.children.splice(i, 0, child);
      return child;
    },
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
    click() { (this.listeners.click || []).forEach(fn => fn({ target: this })); },
    hasClass(name) { return this.className.split(/\s+/).includes(name); },
    classList: {
      add(name) { if (!el.hasClass(name)) el.className = (el.className + ' ' + name).trim(); },
      remove(name) { el.className = el.className.split(/\s+/).filter(c => c && c !== name).join(' '); }
    },
    querySelector(selector) {
      const wanted = selector.replace(/^\./, '');
      const walk = (node) => {
        for (const child of node.children) {
          if (child.hasClass(wanted)) return child;
          const deeper = walk(child);
          if (deeper) return deeper;
        }
        return null;
      };
      return walk(el);
    }
  };
  return el;
}

function findById(root, id) {
  if (!root) return null;
  for (const child of root.children) {
    if (child.id === id) return child;
    const deeper = findById(child, id);
    if (deeper) return deeper;
  }
  return null;
}

// Charge boot-guard.js dans un contexte neuf.
//   diag         : true (lib/startup-diagnostics) | false (absent) | objet perso
//   body         : false pour simuler un document sans <body> (script chargé très tôt)
//   hydrateIcons : fonction facultative exposée sur window
function load({ diag = true, body = true, hydrateIcons } = {}) {
  const errors = [];
  const domListeners = [];
  const handlers = [];
  const document = {
    body: body ? makeElement('body') : null,
    createElement: makeElement,
    getElementById(id) { return findById(document.body, id); },
    addEventListener(type, fn, opts) { domListeners.push({ type, fn, opts }); }
  };
  const window = {
    addEventListener(type, fn, capture) { handlers.push({ type, fn, capture }); }
  };
  if (diag === true) window.IAOStartupDiagnostics = diagnostics;
  else if (diag) window.IAOStartupDiagnostics = diag;
  if (hydrateIcons) window.hydrateIcons = hydrateIcons;
  const sandbox = { window, document, console: { error: (...a) => errors.push(a.join(' ')) } };
  vm.createContext(sandbox);
  SCRIPT.runInContext(sandbox);

  const handler = (type) => handlers.find(h => h.type === type);
  return {
    window, document, errors, domListeners, handlers,
    report: window.__iaoReportStartupProblem,
    fire(type, ev) { handler(type).fn(ev); },
    banner() { return document.getElementById('bootError'); },
    items() {
      const b = document.getElementById('bootError');
      return b ? b.querySelector('.boot-error__list').children : [];
    }
  };
}

// --- Exposition et abonnements --------------------------------------------

test('boot-guard expose __iaoReportStartupProblem et écoute error (capture) + unhandledrejection', () => {
  const env = load();
  assert.equal(typeof env.report, 'function');
  assert.equal(env.handlers.length, 2);
  const err = env.handlers.find(h => h.type === 'error');
  const rej = env.handlers.find(h => h.type === 'unhandledrejection');
  assert.equal(err.capture, true, 'error doit être écouté en phase de capture (erreurs de chargement de <script>)');
  assert.ok(rej);
  // Rien n'est affiché tant qu'aucun problème n'est signalé.
  assert.equal(env.banner(), null);
});

// --- Bandeau ---------------------------------------------------------------

test('un problème crée le bandeau (rôle alert, icône, titre, bouton, liste) en tête du body', () => {
  const hydrated = [];
  const env = load({ hydrateIcons: (root) => hydrated.push(root) });
  const existing = makeElement('main');
  env.document.body.appendChild(existing);

  env.report('preload', 'window.iaoAPI indisponible');

  const banner = env.banner();
  assert.ok(banner);
  assert.equal(env.document.body.firstChild, banner, 'le bandeau passe avant le contenu existant');
  assert.equal(env.document.body.children[1], existing);
  assert.equal(banner.className, 'boot-error');
  assert.equal(banner.getAttribute('role'), 'alert');

  const [head, list] = banner.children;
  assert.equal(head.className, 'boot-error__head');
  const [icon, title, close] = head.children;
  assert.equal(icon.getAttribute('data-icon'), 'triangle-exclamation');
  assert.match(icon.className, /boot-error__icon/);
  assert.equal(title.textContent, 'IAO a rencontré un problème');
  assert.equal(close.type, 'button');
  assert.equal(close.getAttribute('aria-label'), 'Masquer');
  assert.equal(close.textContent, '×');
  assert.equal(list.className, 'boot-error__list');

  // hydrateIcons est appelé sur le bandeau pour dessiner l'icône.
  assert.deepEqual(hydrated, [banner]);
});

test('l\'entrée affiche titre, détail technique et piste de dépannage (via textContent)', () => {
  const env = load();
  env.report('error', new Error('boum'), 'assets/app.js:42');

  assert.equal(env.items().length, 1);
  const [t, d, h] = env.items()[0].children;
  assert.equal(t.className, 'boot-error__item-title');
  assert.equal(t.textContent, "Une erreur a interrompu l'interface");
  assert.equal(d.tagName, 'CODE');
  assert.equal(d.textContent, 'boum (assets/app.js:42)');
  assert.match(h.textContent, /logs\/iao\.log/);
  assert.equal(env.errors.length, 1);
  assert.equal(env.errors[0], "[demarrage] Une erreur a interrompu l'interface : boum (assets/app.js:42)");
});

test('hydrateIcons qui lève ou est absent n\'empêche pas l\'affichage du bandeau', () => {
  const failing = load({ hydrateIcons: () => { throw new Error('icône cassée'); } });
  assert.doesNotThrow(() => failing.report('error', 'x'));
  assert.equal(failing.items().length, 1);

  const absent = load(); // pas de window.hydrateIcons
  assert.doesNotThrow(() => absent.report('error', 'x'));
  assert.equal(absent.items().length, 1);
});

test('un second problème réutilise le bandeau existant', () => {
  const env = load();
  env.report('error', 'premier');
  const first = env.banner();
  env.report('rejection', 'second');

  assert.equal(env.banner(), first);
  assert.equal(env.document.body.children.length, 1, 'un seul bandeau dans le body');
  assert.equal(env.items().length, 2);
});

test('dédoublonnage : la même erreur n\'ajoute qu\'une ligne mais reste journalisée à chaque fois', () => {
  const env = load();
  env.report('error', 'identique');
  env.report('error', 'identique');
  env.report('error', 'identique');

  assert.equal(env.items().length, 1);
  assert.equal(env.errors.length, 3);
});

test('limite de 5 lignes : les suivantes sont journalisées mais pas affichées', () => {
  const env = load();
  for (let i = 1; i <= 7; i++) env.report('error', 'erreur ' + i);

  assert.equal(env.items().length, 5);
  assert.equal(env.errors.length, 7);
  assert.equal(env.items()[4].children[1].textContent, 'erreur 5');
  // Une 8e erreur déjà affichée ou non ne change rien à la limite.
  env.report('error', 'erreur 1');
  assert.equal(env.items().length, 5);
});

test('bouton fermer : masque le bandeau, un nouveau problème le réaffiche', () => {
  const env = load();
  env.report('error', 'a');
  const banner = env.banner();
  const close = banner.children[0].children[2];

  assert.equal(banner.hasClass('boot-error--hidden'), false);
  close.click();
  assert.equal(banner.hasClass('boot-error--hidden'), true);

  env.report('error', 'b');
  assert.equal(banner.hasClass('boot-error--hidden'), false);
  assert.equal(env.items().length, 2);
});

// --- document.body absent --------------------------------------------------

test('sans document.body : l\'affichage attend DOMContentLoaded puis crée le bandeau', () => {
  const env = load({ body: false });
  env.report('error', 'très tôt');

  assert.equal(env.errors.length, 1, 'journalisé immédiatement');
  assert.equal(env.domListeners.length, 1);
  assert.equal(env.domListeners[0].type, 'DOMContentLoaded');
  assert.equal(env.domListeners[0].opts.once, true, 'l\'écouteur ne doit se déclencher qu\'une fois');

  env.document.body = makeElement('body'); // le parseur a créé le <body>
  env.domListeners[0].fn();

  assert.ok(env.banner());
  assert.equal(env.items().length, 1);
  assert.equal(env.items()[0].children[1].textContent, 'très tôt');
});

test('sans document.body même à DOMContentLoaded : aucun bandeau, aucune exception', () => {
  const env = load({ body: false });
  env.report('error', 'sans body');

  assert.doesNotThrow(() => env.domListeners[0].fn());
  assert.equal(env.banner(), null);
  assert.equal(env.errors.length, 1);
});

// --- Repli sans diagnostics -----------------------------------------------

test('sans IAOStartupDiagnostics : texte de repli générique', () => {
  const env = load({ diag: false });
  env.report('error', new Error('cassé'));

  const [t, d, h] = env.items()[0].children;
  assert.equal(t.textContent, 'Erreur au démarrage');
  assert.equal(d.textContent, 'Error: cassé');
  assert.equal(h.textContent, 'Voir le terminal.');
  assert.equal(env.errors[0], '[demarrage] Erreur au démarrage : Error: cassé');
});

test('IAOStartupDiagnostics sans describeStartupProblem : même repli', () => {
  const env = load({ diag: {} });
  env.report('rejection', 'raison');

  assert.equal(env.items()[0].children[0].textContent, 'Erreur au démarrage');
  assert.equal(env.items()[0].children[1].textContent, 'raison');
});

test('kind « preload » : titre du pont sécurisé', () => {
  const env = load();
  env.report('preload', 'window.iaoAPI indisponible');
  assert.match(env.items()[0].children[0].textContent, /preload/);
});

// --- Événement « error » ---------------------------------------------------

test('error : ressource <script> introuvable -> signalée avec son src', () => {
  const env = load();
  const target = makeElement('script');
  target.setAttribute('src', 'assets/absent.js');
  env.fire('error', { target });

  assert.equal(env.items().length, 1);
  assert.equal(env.items()[0].children[1].textContent, 'script introuvable : assets/absent.js');
});

test('error : <script> sans attribut src -> « ? »', () => {
  const env = load();
  env.fire('error', { target: makeElement('script') });
  assert.equal(env.items()[0].children[1].textContent, 'script introuvable : ?');
});

test('error : autre ressource (img) -> ignorée', () => {
  const env = load();
  env.fire('error', { target: makeElement('img') });
  assert.equal(env.banner(), null);
  assert.equal(env.errors.length, 0);
});

test('error : erreur JS avec fichier et ligne -> source raccourcie', () => {
  const env = load();
  env.fire('error', { error: new TypeError('x is not a function'), filename: 'file:///opt/IAO/assets/app.js', lineno: 120 });
  assert.equal(env.items()[0].children[1].textContent, 'TypeError: x is not a function (assets/app.js:120)');
});

test('error : fichier sans numéro de ligne', () => {
  const env = load();
  env.fire('error', { error: 'oups', filename: 'file:///opt/IAO/index.html' });
  assert.equal(env.items()[0].children[1].textContent, 'oups (IAO/index.html)');
});

test('error : sans diagnostics, le nom de fichier reste brut', () => {
  const env = load({ diag: false });
  env.fire('error', { error: 'oups', filename: 'file:///opt/IAO/assets/app.js', lineno: 7 });
  assert.equal(env.items()[0].children[1].textContent, 'oups');
  assert.equal(env.errors.length, 1);
});

test('error : message seul, sans ev.error', () => {
  const env = load();
  env.fire('error', { message: 'Script error.' });
  assert.equal(env.items()[0].children[1].textContent, 'Script error.');
});

test('error : événement vide ou absent -> « erreur inconnue »', () => {
  const env = load();
  env.fire('error', {});
  env.fire('error', undefined);
  // Même texte : dédoublonné en une seule ligne, mais journalisé deux fois.
  assert.equal(env.items().length, 1);
  assert.equal(env.items()[0].children[1].textContent, 'erreur inconnue');
  assert.equal(env.errors.length, 2);
});

test('error : cible = window -> traité comme une erreur JS', () => {
  const env = load();
  env.fire('error', { target: env.window, error: new Error('globale') });
  assert.equal(env.items()[0].children[1].textContent, 'globale');
});

// --- unhandledrejection ----------------------------------------------------

test('unhandledrejection : la raison est affichée avec le titre « asynchrone »', () => {
  const env = load();
  env.fire('unhandledrejection', { reason: new Error('promesse rompue') });

  assert.equal(env.items()[0].children[0].textContent, 'Une opération asynchrone a échoué au démarrage');
  assert.equal(env.items()[0].children[1].textContent, 'promesse rompue');
});

test('unhandledrejection : événement absent -> « rejet inconnu »', () => {
  const env = load();
  env.fire('unhandledrejection', undefined);
  assert.equal(env.items()[0].children[1].textContent, 'rejet inconnu');
});
