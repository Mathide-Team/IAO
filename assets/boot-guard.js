// assets/boot-guard.js — garde de démarrage du renderer (issue #52).
//
// Chargé TÔT dans index.html (juste après assets/icons.js et
// lib/startup-diagnostics.js, avant tout le reste) pour qu'une erreur au
// démarrage ne laisse plus jamais une interface vide et muette :
//   - toute erreur non rattrapée (window 'error') ou promesse rejetée
//     ('unhandledrejection') affiche un BANDEAU visible, avec une icône
//     d'alerte, le détail technique et une piste de dépannage ;
//   - le même texte part dans console.error, que main.js recopie dans le
//     terminal et dans <userData>/logs/iao.log ;
//   - window.__iaoReportStartupProblem(kind, err) permet à app.js de
//     signaler un problème connu (ex. preload absent) sans lever d'exception.
//
// Aucune donnée utilisateur n'est injectée en HTML : tout passe par
// textContent (invariant 1, CLAUDE.md). Pas de style inline (CSP, lot 9) :
// l'apparence vient des classes .boot-error* d'assets/app.css.
(function () {
  'use strict';

  var diag = window.IAOStartupDiagnostics;
  var shown = []; // dédoublonnage : une même erreur n'empile pas 50 lignes
  var MAX_ITEMS = 5;

  function describe(kind, err, source) {
    if (diag && typeof diag.describeStartupProblem === 'function') {
      return diag.describeStartupProblem(kind, err, source);
    }
    return { title: 'Erreur au démarrage', detail: String(err), hint: 'Voir le terminal.' };
  }

  function ensureBanner() {
    var banner = document.getElementById('bootError');
    if (banner) return banner;
    if (!document.body) return null;
    banner = document.createElement('div');
    banner.id = 'bootError';
    banner.className = 'boot-error';
    banner.setAttribute('role', 'alert');

    var head = document.createElement('div');
    head.className = 'boot-error__head';
    var icon = document.createElement('span');
    icon.className = 'ic boot-error__icon';
    icon.setAttribute('data-icon', 'triangle-exclamation');
    var title = document.createElement('strong');
    title.className = 'boot-error__title';
    title.textContent = 'IAO a rencontré un problème';
    var close = document.createElement('button');
    close.type = 'button';
    close.className = 'boot-error__close';
    close.setAttribute('aria-label', 'Masquer');
    close.textContent = '×';
    close.addEventListener('click', function () { banner.classList.add('boot-error--hidden'); });
    head.appendChild(icon);
    head.appendChild(title);
    head.appendChild(close);

    var list = document.createElement('ul');
    list.className = 'boot-error__list';
    banner.appendChild(head);
    banner.appendChild(list);
    document.body.insertBefore(banner, document.body.firstChild);
    if (typeof window.hydrateIcons === 'function') {
      try { window.hydrateIcons(banner); } catch (_) { /* icône facultative */ }
    }
    return banner;
  }

  function report(kind, err, source) {
    var info = describe(kind, err, source);
    var key = info.title + '|' + info.detail;
    // Toujours journalisé (recopié par main.js dans le terminal + logs/iao.log).
    console.error('[demarrage] ' + info.title + ' : ' + info.detail);
    if (shown.indexOf(key) !== -1 || shown.length >= MAX_ITEMS) return;
    shown.push(key);

    var render = function () {
      var banner = ensureBanner();
      if (!banner) return;
      banner.classList.remove('boot-error--hidden');
      var item = document.createElement('li');
      item.className = 'boot-error__item';
      var t = document.createElement('div');
      t.className = 'boot-error__item-title';
      t.textContent = info.title;
      var d = document.createElement('code');
      d.className = 'boot-error__detail';
      d.textContent = info.detail;
      var h = document.createElement('div');
      h.className = 'boot-error__hint';
      h.textContent = info.hint;
      item.appendChild(t);
      item.appendChild(d);
      item.appendChild(h);
      banner.querySelector('.boot-error__list').appendChild(item);
    };
    if (document.body) render();
    else document.addEventListener('DOMContentLoaded', render, { once: true });
  }

  window.__iaoReportStartupProblem = report;

  window.addEventListener('error', function (ev) {
    // Erreurs de chargement de ressources (img, script) : ev.error absent et
    // ev.target n'est pas window. Seul un <script> manquant nous intéresse.
    if (ev && ev.target && ev.target !== window) {
      if (ev.target.tagName === 'SCRIPT') report('error', 'script introuvable : ' + (ev.target.getAttribute('src') || '?'));
      return;
    }
    var src = ev && ev.filename ? (diag ? diag.shortSource(ev.filename) : ev.filename) + (ev.lineno ? ':' + ev.lineno : '') : '';
    report('error', (ev && (ev.error || ev.message)) || 'erreur inconnue', src);
  }, true);

  window.addEventListener('unhandledrejection', function (ev) {
    report('rejection', ev ? ev.reason : 'rejet inconnu');
  });
})();
