'use strict';

// lib/data-dir-check.js — diagnostic du dossier de données au démarrage
// (issue #184, lien possible avec #186).
//
// Erreurs relevées sur le portable HP (journal de #58, 12/10/2026) :
//   service_worker_storage.cc  Failed to delete the database: Database IO error
//   quota_database.cc          Could not open the quota database, resetting.
// Chromium échoue à SUPPRIMER puis à rouvrir ses bases. Causes connues (rapports
// Electron #35036 et suivants) : une autre instance tient les verrous (IAO est
// déjà en instance unique depuis #52), ou des fichiers que le compte courant ne
// peut pas modifier — typiquement créés par un lancement en root (sudo). Ce
// module recherche ce second cas, sans rien modifier : il écrit dans iao.log
// le nombre de fichiers concernés, des exemples et la commande de correction.
//
// Le système de fichiers est injecté (fs, path) : testable par `node --test`
// dans un dossier temporaire (invariant 11, CLAUDE.md).

// Caches volumineux et reconstruits par Chromium : inutile d'y descendre.
const SKIPPED_DIRS = Object.freeze(['Cache', 'Code Cache', 'GPUCache', 'DawnCache', 'DawnGraphiteCache', 'DawnWebGPUCache', 'GrShaderCache', 'ShaderCache', 'ScriptCache', 'Crashpad', 'logs']);
const DEFAULTS = Object.freeze({ maxDepth: 6, maxEntries: 20000, maxExamples: 5 });

// uid du processus (POSIX) ; null sous Windows, où le contrôle n'a pas de sens.
function currentUid(proc) {
  return proc && typeof proc.getuid === 'function' ? proc.getuid() : null;
}

// Parcourt `root` et relève les entrées dont le propriétaire n'est pas `uid`.
// Renvoie { checked, foreign, examples, truncated } ; null si uid est null ou
// si `root` est illisible (absent au premier lancement).
function findForeignEntries(root, deps) {
  const { fs, path, uid } = deps;
  if (uid === null || uid === undefined) return null;
  const opts = { ...DEFAULTS, ...(deps.options || {}) };
  const result = { checked: 0, foreign: 0, examples: [], truncated: false };
  try { fs.lstatSync(root); } catch (_) { return null; }
  const stack = [{ dir: root, depth: 0 }];
  while (stack.length > 0) {
    const { dir, depth } = stack.pop();
    let names;
    try { names = fs.readdirSync(dir); } catch (_) { continue; }
    for (const name of names) {
      if (result.checked >= opts.maxEntries) { result.truncated = true; return result; }
      const full = path.join(dir, name);
      let st;
      try { st = fs.lstatSync(full); } catch (_) { continue; }
      result.checked += 1;
      if (st.uid !== uid) {
        result.foreign += 1;
        if (result.examples.length < opts.maxExamples) result.examples.push({ path: full, uid: st.uid });
      }
      if (st.isDirectory() && depth + 1 < opts.maxDepth && !SKIPPED_DIRS.includes(name)) {
        stack.push({ dir: full, depth: depth + 1 });
      }
    }
  }
  return result;
}

// Message de journal (niveau warning) ; null si rien à signaler.
function describeForeignEntries(result, root) {
  if (!result || result.foreign === 0) return null;
  const examples = result.examples.map((e) => e.path + ' (uid ' + e.uid + ')').join(', ');
  return result.foreign + ' fichier(s) du dossier de données n\'appartiennent pas au compte courant' +
    (result.truncated ? ' (parcours limité à ' + result.checked + ' entrées)' : '') +
    ' : Chromium ne peut ni les modifier ni les supprimer (« Database IO error », comptes ou sessions qui disparaissent). ' +
    'Exemples : ' + examples + '. Correction : quitter IAO puis lancer « sudo chown -R "$USER": "' + root + '" » (issue #184).';
}

// Point d'entrée de main.js : un seul appel, sans branche côté main.js.
function reportForeignEntries(root, deps) {
  const message = describeForeignEntries(findForeignEntries(root, { ...deps, uid: currentUid(deps.proc) }), root);
  if (message) deps.log('demarrage', 'warning', message);
  return message;
}

module.exports = { SKIPPED_DIRS, currentUid, findForeignEntries, describeForeignEntries, reportForeignEntries };
