// lib/i18n.js — internationalisation gettext (issue #51).
//
// Fonctions PURES (invariant 11), sans Electron ni DOM :
//   parseMo(buf)               lit un catalogue GNU .mo compilé par msgfmt
//   compilePluralForms(expr)   évalue « Plural-Forms » SANS eval/Function (CSP)
//   createTranslator(catalog)  gettext / ngettext / pgettext sur un catalogue
//   negotiateLocale(...)       choisit la locale parmi celles réellement livrées
//   requestedLocales(argv,env) langue demandée (--iao-lang, IAO_LANG)
//   preferredLocales(opts)     ordre de préférence : demande explicite,
//                              réglage, langues du système
//   parseLinguas(text)         lit lang/LINGUAS (liste centrale des locales)
//   translateText(text, tr)    traduit en conservant les espaces de bord
//   formatMessage(tpl, params) remplit les marqueurs {nom} d'un libellé traduit
//   extractHtmlMessages(html)  chaînes visibles d'index.html (extracteur POT)
//   blankTemplateText(src)     JavaScript sans texte de gabarit (pour xgettext)
//   loadCatalog(opts)          lit lang/<locale>/LC_MESSAGES/iao.mo (fs injecté)
//
// Le français est la langue SOURCE : les msgid sont les libellés français,
// une chaîne non traduite retombe donc toujours sur le texte d'origine.
// Aucune liste de langues n'est codée ici : la liste vit dans lang/LINGUAS et
// les catalogues présents sur disque font foi.

// Chargé en <script> classique : tout est enfermé dans une IIFE pour ne
// déclarer AUCUN nom global (lib/startup-diagnostics.js déclare déjà `api`,
// une redéclaration casse tout le script : SyntaxError au démarrage).
(function () {
'use strict';

const SOURCE_LOCALE = 'fr';
const DOMAIN = 'iao';
const CONTEXT_SEPARATOR = '\u0004';

// ---------------------------------------------------------------------------
// Lecture d'un .mo (format : https://www.gnu.org/software/gettext/manual/html_node/MO-Files.html)
// ---------------------------------------------------------------------------

function parseMo(buf) {
  if (!buf || typeof buf.readUInt32LE !== 'function' || buf.length < 28) {
    throw new Error('catalogue .mo invalide : tampon trop court');
  }
  const magic = buf.readUInt32LE(0);
  let read;
  if (magic === 0x950412de) read = (o) => buf.readUInt32LE(o);
  else if (magic === 0xde120495) read = (o) => buf.readUInt32BE(o);
  else throw new Error('catalogue .mo invalide : nombre magique inconnu');

  const count = read(8);
  const origTable = read(12);
  const transTable = read(16);
  if (origTable + count * 8 > buf.length || transTable + count * 8 > buf.length) {
    throw new Error('catalogue .mo invalide : tables hors du fichier');
  }
  const str = (table, i) => {
    const len = read(table + i * 8);
    const off = read(table + i * 8 + 4);
    if (off + len > buf.length) throw new Error('catalogue .mo invalide : chaîne hors du fichier');
    return buf.toString('utf8', off, off + len);
  };

  const messages = Object.create(null);
  let headerText = '';
  for (let i = 0; i < count; i++) {
    const original = str(origTable, i);
    const translation = str(transTable, i);
    if (original === '') { headerText = translation; continue; }
    // msgid\0msgid_plural -> clé = msgid ; msgstr[0]\0msgstr[1]... -> tableau
    const key = original.split('\0')[0];
    messages[key] = original.includes('\0') ? translation.split('\0') : translation;
  }
  const headers = parseHeaders(headerText);
  return { headers, messages, pluralForms: headers['plural-forms'] || '' };
}

function parseHeaders(text) {
  const headers = Object.create(null);
  for (const line of String(text).split('\n')) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
  }
  return headers;
}

// ---------------------------------------------------------------------------
// Plural-Forms : petit analyseur d'expressions C (n, entiers, ! * / % + -
// < <= > >= == != && || ?:, parenthèses). Pas d'eval : la CSP du renderer
// l'interdit et un catalogue ne doit jamais pouvoir exécuter de code.
// ---------------------------------------------------------------------------

function tokenize(expr) {
  const tokens = [];
  const re = /\s*(\d+|n|&&|\|\||==|!=|<=|>=|[-+*/%<>!?:()])/y;
  let pos = 0;
  const src = String(expr);
  while (pos < src.length) {
    if (/^\s*$/.test(src.slice(pos))) break;
    re.lastIndex = pos;
    const m = re.exec(src);
    if (!m) throw new Error('Plural-Forms invalide près de « ' + src.slice(pos, pos + 10) + ' »');
    tokens.push(m[1]);
    pos = re.lastIndex;
  }
  return tokens;
}

const BINARY = [
  ['||'], ['&&'], ['==', '!='], ['<', '<=', '>', '>='], ['+', '-'], ['*', '/', '%']
];

function applyBinary(op, a, b) {
  switch (op) {
    case '||': return (a || b) ? 1 : 0;
    case '&&': return (a && b) ? 1 : 0;
    case '==': return a === b ? 1 : 0;
    case '!=': return a !== b ? 1 : 0;
    case '<': return a < b ? 1 : 0;
    case '<=': return a <= b ? 1 : 0;
    case '>': return a > b ? 1 : 0;
    case '>=': return a >= b ? 1 : 0;
    case '+': return a + b;
    case '-': return a - b;
    case '*': return a * b;
    case '/': return b === 0 ? 0 : Math.trunc(a / b);
    default: return b === 0 ? 0 : a % b; // '%'
  }
}

function compileExpression(tokens) {
  let i = 0;
  const peek = () => tokens[i];
  const expect = (t) => {
    if (tokens[i] !== t) throw new Error('Plural-Forms invalide : « ' + t + ' » attendu');
    i++;
  };

  function primary() {
    const t = tokens[i++];
    if (t === undefined) throw new Error('Plural-Forms invalide : expression incomplète');
    if (t === 'n') return (n) => n;
    if (/^\d+$/.test(t)) { const v = Number(t); return () => v; }
    if (t === '!') { const f = primary(); return (n) => (f(n) ? 0 : 1); }
    if (t === '-') { const f = primary(); return (n) => -f(n); }
    if (t === '(') { const f = ternary(); expect(')'); return f; }
    throw new Error('Plural-Forms invalide : jeton inattendu « ' + t + ' »');
  }

  function binary(level) {
    if (level === BINARY.length) return primary();
    let left = binary(level + 1);
    while (BINARY[level].includes(peek())) {
      const op = tokens[i++];
      const l = left; const r = binary(level + 1);
      left = (n) => applyBinary(op, l(n), r(n));
    }
    return left;
  }

  function ternary() {
    const cond = binary(0);
    if (peek() !== '?') return cond;
    i++;
    const yes = ternary();
    expect(':');
    const no = ternary();
    return (n) => (cond(n) ? yes(n) : no(n));
  }

  const fn = ternary();
  if (i !== tokens.length) throw new Error('Plural-Forms invalide : jeton en trop « ' + tokens[i] + ' »');
  return fn;
}

// « nplurals=2; plural=(n > 1); » -> { nplurals, plural(n) }
function compilePluralForms(header) {
  const text = String(header || '');
  const np = /nplurals\s*=\s*(\d+)/.exec(text);
  const pl = /plural\s*=\s*([^;]+)/.exec(text);
  if (!np || !pl) {
    // Défaut gettext (germanique) : singulier pour 1, pluriel sinon.
    return { nplurals: 2, plural: (n) => (n === 1 ? 0 : 1) };
  }
  const nplurals = Number(np[1]);
  const fn = compileExpression(tokenize(pl[1]));
  return {
    nplurals,
    plural: (n) => {
      const idx = Number(fn(Math.abs(Math.trunc(Number(n) || 0))));
      return idx >= 0 && idx < nplurals ? idx : 0;
    }
  };
}

// ---------------------------------------------------------------------------
// Traducteur
// ---------------------------------------------------------------------------

function createTranslator(catalog) {
  const messages = (catalog && catalog.messages) || Object.create(null);
  const locale = (catalog && catalog.locale) || SOURCE_LOCALE;
  let plural;
  try {
    plural = compilePluralForms(catalog && catalog.pluralForms).plural;
  } catch (_) {
    plural = compilePluralForms('').plural;
  }
  const lookup = (key) => (Object.prototype.hasOwnProperty.call(messages, key) ? messages[key] : undefined);

  function gettext(msgid) {
    const t = lookup(msgid);
    if (typeof t === 'string' && t !== '') return t;
    if (Array.isArray(t) && t[0]) return t[0];
    return msgid;
  }
  function ngettext(msgid, msgidPlural, n) {
    const t = lookup(msgid);
    if (Array.isArray(t)) {
      const form = t[plural(n)];
      if (form) return form;
    }
    // Repli : règle de la langue source (français : 0 et 1 au singulier).
    return Math.abs(Number(n) || 0) > 1 ? msgidPlural : msgid;
  }
  function pgettext(context, msgid) {
    const t = lookup(context + CONTEXT_SEPARATOR + msgid);
    return typeof t === 'string' && t !== '' ? t : msgid;
  }
  return { locale, gettext, ngettext, pgettext, has: (msgid) => lookup(msgid) !== undefined };
}

// ---------------------------------------------------------------------------
// Locales
// ---------------------------------------------------------------------------

// lang/LINGUAS : une locale par ligne ou séparées par des espaces, # = commentaire.
function parseLinguas(text) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    for (const tok of line.replace(/#.*/, '').split(/\s+/)) {
      if (tok && !out.includes(tok)) out.push(tok);
    }
  }
  return out;
}

function normalizeTag(tag) {
  return String(tag || '').trim().replace(/\..*$/, '').replace(/@.*$/, '').replace(/-/g, '_');
}

// preferred : liste ordonnée (ex. ['pt-BR', 'en-US']) ; available : locales
// livrées (ex. ['fr', 'en', 'pt']). Correspondance exacte, puis langue seule.
function negotiateLocale(preferred, available, fallback) {
  const avail = (available || []).map(normalizeTag);
  const fb = fallback || SOURCE_LOCALE;
  for (const raw of preferred || []) {
    const tag = normalizeTag(raw);
    if (!tag) continue;
    const exact = avail.find((a) => a.toLowerCase() === tag.toLowerCase());
    if (exact) return exact;
    const lang = tag.split('_')[0].toLowerCase();
    const base = avail.find((a) => a.toLowerCase() === lang);
    if (base) return base;
  }
  return fb;
}

// Langue demandée explicitement : --iao-lang=xx (ou --iao-lang xx) puis
// IAO_LANG. Sans demande, liste vide (voir preferredLocales).
function requestedLocales(argv, env) {
  const args = Array.isArray(argv) ? argv : [];
  const out = [];
  args.forEach((a, i) => {
    const s = String(a);
    if (s.startsWith('--iao-lang=')) out.push(s.slice('--iao-lang='.length));
    else if (s === '--iao-lang' && args[i + 1]) out.push(String(args[i + 1]));
  });
  const fromEnv = String((env && env.IAO_LANG) || '').trim();
  if (fromEnv) out.push(...fromEnv.split(':'));
  return out.filter(Boolean);
}

// Ordre de préférence complet (lot 3 de #51) : la demande explicite
// (--iao-lang, IAO_LANG) l'emporte, puis le réglage « Langue » s'il n'est pas
// « auto », puis les langues du système (Electron
// app.getPreferredSystemLanguages()). negotiateLocale choisit ensuite parmi
// les catalogues livrés ; rien de livré -> français.
function preferredLocales(opts) {
  const o = opts || {};
  const explicit = requestedLocales(o.argv, o.env);
  if (explicit.length) return explicit;
  const setting = typeof o.setting === 'string' ? o.setting.trim() : '';
  if (setting && setting !== 'auto') return [setting];
  return (Array.isArray(o.system) ? o.system : []).map(String).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Texte et HTML
// ---------------------------------------------------------------------------

function translateText(text, translator) {
  const s = String(text);
  const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(s);
  if (!m[2]) return s;
  const key = m[2].replace(/\s+/g, ' ');
  const translated = translator.gettext(key);
  return translated === key ? s : m[1] + translated + m[3];
}

// Les libellés construits en JavaScript gardent des marqueurs nommés
// (« {service} ouvert avec {account} ») : le traducteur peut les déplacer,
// ce qu'une concaténation interdirait. Un marqueur sans valeur reste tel quel
// (visible plutôt que « undefined »).
function formatMessage(template, params) {
  const s = String(template);
  if (!params) return s;
  return s.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (whole, name) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : whole);
}

// Une chaîne mérite traduction si elle contient au moins une lettre et n'est
// pas un identifiant technique (raccourci clavier, nom de produit seul...).
function isTranslatable(text) {
  return /[A-Za-zÀ-ÿ]{2,}/.test(text) && !/^(IAO|DEBUG|Ctrl\+[A-Z]|Email)$/.test(text);
}

// Attributs traduits à l'exécution (mêmes noms côté renderer).
const TRANSLATED_ATTRIBUTES = ['title', 'placeholder', 'aria-label', 'alt'];

// Chaînes visibles de index.html : nœuds texte du <body> (hors <script>,
// <style>, commentaires) et attributs TRANSLATED_ATTRIBUTES. Renvoie
// [{ msgid, line }] dans l'ordre du document, sans doublon.
function extractHtmlMessages(html) {
  const src = String(html);
  const bodyStart = src.search(/<body[\s>]/i);
  const start = bodyStart < 0 ? 0 : bodyStart;
  const lineAt = (idx) => src.slice(0, idx).split('\n').length;
  const seen = new Set();
  const out = [];
  const add = (raw, idx) => {
    const msgid = raw.replace(/\s+/g, ' ').trim();
    if (!msgid || !isTranslatable(msgid) || seen.has(msgid)) return;
    seen.add(msgid);
    out.push({ msgid, line: lineAt(idx) });
  };
  // Masque commentaires, scripts et styles en conservant les positions.
  const blank = (m) => m.replace(/[^\n]/g, ' ');
  const body = src.slice(0, start).replace(/[^\n]/g, ' ') + src.slice(start)
    .replace(/<!--[\s\S]*?-->/g, blank)
    .replace(/<script[\s\S]*?<\/script>/gi, blank)
    .replace(/<style[\s\S]*?<\/style>/gi, blank);

  const tagRe = /<[^>]+>/g;
  let last = start;
  let m;
  while ((m = tagRe.exec(body)) !== null) {
    if (m.index > last) add(decodeEntities(body.slice(last, m.index)), last);
    const attrRe = /\s([a-zA-Z-]+)="([^"]*)"/g;
    let a;
    while ((a = attrRe.exec(m[0])) !== null) {
      if (TRANSLATED_ATTRIBUTES.includes(a[1].toLowerCase())) add(decodeEntities(a[2]), m.index);
    }
    last = tagRe.lastIndex;
  }
  if (last < body.length) add(decodeEntities(body.slice(last)), last);
  return out;
}

// Préparation du JavaScript pour xgettext. Les versions de xgettext
// antérieures à 0.20 (Ubuntu 20.04, runners maison) ignorent les gabarits
// `...` : une apostrophe dans leur texte ouvre une fausse chaîne et des
// libellés _() plus loin sont perdus. On remplace donc le TEXTE des gabarits
// (et leurs délimiteurs) par des espaces, en gardant les expressions ${...},
// les chaînes, les commentaires (« TRANSLATORS: ») et chaque saut de ligne :
// les références fichier:ligne du .pot restent exactes. Aucun libellé n'est
// extrait d'un gabarit (règle de docs/i18n.md), rien n'est donc perdu.
const REGEX_PREV = new Set('(,=:[!&|?{};+-*%<>~^'.split(''));
const REGEX_KEYWORDS = /(?:^|[^\w$])(?:return|typeof|case|in|of|delete|void|throw|new|else|do|yield|await)$/;

function blankTemplateText(src) {
  const s = String(src);
  let out = '';
  let i = 0;
  const stack = []; // profondeur d'accolades de chaque expression ${...} ouverte
  const blank = (c) => (c === '\n' ? '\n' : ' ');
  const prevSignificant = () => {
    const t = out.replace(/\s+$/, '');
    return { ch: t.slice(-1), text: t };
  };
  // Texte d'un gabarit, jusqu'au backtick fermant ou à une expression ${.
  function templateBody() {
    while (i < s.length) {
      const c = s[i];
      if (c === '\\') { out += blank(c) + (i + 1 < s.length ? blank(s[i + 1]) : ''); i += 2; continue; }
      if (c === '`') { out += ' '; i++; return; }
      if (c === '$' && s[i + 1] === '{') { out += '  '; i += 2; stack.push(0); return; }
      out += blank(c); i++;
    }
  }
  while (i < s.length) {
    const c = s[i];
    const d = s[i + 1];
    if (c === '/' && d === '/') {
      const end = s.indexOf('\n', i);
      const j = end === -1 ? s.length : end;
      out += s.slice(i, j); i = j; continue;
    }
    if (c === '/' && d === '*') {
      const end = s.indexOf('*/', i + 2);
      const j = end === -1 ? s.length : end + 2;
      out += s.slice(i, j); i = j; continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < s.length && s[j] !== c && s[j] !== '\n') j += s[j] === '\\' ? 2 : 1;
      out += s.slice(i, j + 1); i = j + 1; continue;
    }
    if (c === '`') { out += ' '; i++; templateBody(); continue; }
    if (c === '/') {
      const p = prevSignificant();
      if (p.ch === '' || REGEX_PREV.has(p.ch) || REGEX_KEYWORDS.test(p.text)) {
        let j = i + 1; let inClass = false;
        while (j < s.length && s[j] !== '\n') {
          if (s[j] === '\\') { j += 2; continue; }
          if (s[j] === '[') inClass = true;
          else if (s[j] === ']') inClass = false;
          else if (s[j] === '/' && !inClass) break;
          j++;
        }
        out += s.slice(i, j + 1); i = j + 1; continue;
      }
    }
    if (stack.length) {
      if (c === '{') stack[stack.length - 1]++;
      else if (c === '}') {
        if (stack[stack.length - 1] === 0) { stack.pop(); out += ' '; i++; templateBody(); continue; }
        stack[stack.length - 1]--;
      }
    }
    out += c; i++;
  }
  return out;
}

function decodeEntities(s) {
  return s.replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_, e) => (
    { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: ' ' }[e]
  ));
}

// ---------------------------------------------------------------------------
// Chargement (fs et chemin injectés : testable sans Electron)
// ---------------------------------------------------------------------------

// opts : { langDir, preferred: [], fs, join }. Renvoie un objet sérialisable
// (IPC) : { locale, available, messages, pluralForms }. Ne lève jamais : un
// catalogue absent ou corrompu retombe sur la langue source.
function loadCatalog(opts) {
  const { langDir, preferred, fs, join } = opts;
  let available = [SOURCE_LOCALE];
  try {
    available = parseLinguas(fs.readFileSync(join(langDir, 'LINGUAS'), 'utf8'));
    if (!available.includes(SOURCE_LOCALE)) available.unshift(SOURCE_LOCALE);
  } catch (_) { /* LINGUAS absent : langue source seule */ }
  const shipped = available.filter((l) => l === SOURCE_LOCALE ||
    fs.existsSync(join(langDir, l, 'LC_MESSAGES', DOMAIN + '.mo')));
  const locale = negotiateLocale(preferred, shipped, SOURCE_LOCALE);
  const empty = { locale: SOURCE_LOCALE, available: shipped, messages: {}, pluralForms: '', error: null };
  if (locale === SOURCE_LOCALE) return empty;
  try {
    const parsed = parseMo(fs.readFileSync(join(langDir, locale, 'LC_MESSAGES', DOMAIN + '.mo')));
    return { locale, available: shipped, messages: Object.assign({}, parsed.messages), pluralForms: parsed.pluralForms, error: null };
  } catch (e) {
    return Object.assign(empty, { error: locale + ' : ' + e.message });
  }
}

const api = {
  SOURCE_LOCALE,
  DOMAIN,
  TRANSLATED_ATTRIBUTES,
  parseMo,
  compilePluralForms,
  createTranslator,
  parseLinguas,
  negotiateLocale,
  requestedLocales,
  preferredLocales,
  translateText,
  formatMessage,
  isTranslatable,
  extractHtmlMessages,
  blankTemplateText,
  loadCatalog
};

// Même double chargement que lib/escape-html.js : <script src> dans le
// renderer (window d'abord), require() dans main.js et les tests.
if (typeof window !== 'undefined') {
  window.IAO_I18N = api;
} else if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
}
})();
