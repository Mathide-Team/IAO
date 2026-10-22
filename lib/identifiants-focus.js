'use strict';

// lib/identifiants-focus.js — proposition d'identifiants au focus d'un champ
// de connexion (issue #278, lot 2). Logique du process principal, injectable
// (Menu, screen, horloge) pour être testée sans Electron.
//
// Principe (les secrets restent dans le process principal) : le preload de
// session signale le focus ('iao-identifiants:focus') ; ici, on lit l'URL
// RÉELLE du webContents émetteur (jamais une donnée de la page) ; s'il existe
// des identifiants pour cet hôte, un menu natif (Menu.popup) propose les
// logins ; au choix, le mot de passe est déchiffré et envoyé au webContents
// émetteur — et à lui seul — sur 'iao-identifiants:remplir'. Le renderer
// n'apparaît nulle part dans ce parcours.
//
// Anti-boucle : après une proposition, un délai (cooldown) bloque les
// propositions suivantes — fermer le menu rend le focus au champ, ce qui
// re-déclenche focusin.

const COOLDOWN_MS = 1200;

// Hôte https (et lui seul) d'une URL, en minuscules ; null sinon.
function hoteDepuisUrl(url) {
  try {
    const u = new URL(String(url));
    return u.protocol === 'https:' ? u.hostname.toLowerCase() : null;
  } catch (_) {
    return null;
  }
}

// Décide s'il faut proposer le menu : hôte https + au moins un identifiant
// enregistré + cooldown écoulé.
function doitProposer(o) {
  const hote = hoteDepuisUrl(o.url);
  if (!hote) return { proposer: false, hote: null };
  const logins = (o.lister && o.lister())[hote] || [];
  if (!logins.length) return { proposer: false, hote };
  if (o.maintenant - o.derniereProposition < o.cooldownMs) return { proposer: false, hote };
  return { proposer: true, hote, logins };
}

// Fabrique le gestionnaire branché sur ipcMain.on(CANAL_FOCUS).
function creer(o) {
  const journal = o.journal || (() => {});
  let derniereProposition = 0;
  const canalRemplir = o.canalRemplir || 'iao-identifiants:remplir';
  const remplir = (sender, hote, login) => {
    try {
      if (!sender || typeof sender.getURL !== 'function' || typeof sender.send !== 'function') return false;
      // La page peut avoir navigué depuis la proposition : l'origine doit
      // toujours être l'hôte proposé — sinon rien n'est déchiffré ni envoyé.
      if (hoteDepuisUrl(sender.getURL()) !== hote) {
        journal('warning', 'Identifiants : émetteur n\'est plus sur « ' + hote + ' », remplissage ignoré.');
        return false;
      }
      const motDePasse = o.identifiants.obtenir(hote, login);
      if (!motDePasse) {
        journal('warning', 'Identifiants : « ' + login + ' » introuvable pour ' + hote + ' (menu).');
        return false;
      }
      sender.send(canalRemplir, { login, motDePasse });
      journal('info', 'Identifiants : remplissage de « ' + login + ' » demandé pour ' + hote + '.');
      return true;
    } catch (e) {
      journal('warning', 'Identifiants : remplissage impossible (' + (e && e.message) + ').');
      return false;
    }
  };
  return {
    remplir,
    surFocus(event) {
      try {
        const sender = event && event.sender;
        if (!sender || typeof sender.getURL !== 'function' || typeof sender.send !== 'function') return false;
        const decision = doitProposer({
          url: sender.getURL(),
          lister: o.identifiants.lister.bind(o.identifiants),
          maintenant: o.maintenant ? o.maintenant() : Date.now(),
          derniereProposition,
          cooldownMs: o.cooldownMs || COOLDOWN_MS
        });
        if (!decision.proposer) return false;
        const fenetre = o.fenetrePour(sender);
        if (!fenetre || typeof o.Menu.buildFromTemplate !== 'function') return false;
        derniereProposition = o.maintenant ? o.maintenant() : Date.now();
        const items = [{ label: decision.hote, enabled: false }].concat(
          decision.logins.map((e) => ({
            label: e.login,
            click: () => remplir(sender, decision.hote, e.login)
          })));
        const options = { window: fenetre };
        if (o.pointeur) {
          const p = o.pointeur();
          if (p && typeof p.x === 'number' && typeof p.y === 'number') { options.x = p.x; options.y = p.y; }
        }
        o.Menu.buildFromTemplate(items).popup(options);
        journal('info', 'Identifiants : ' + decision.logins.length + ' identifiant(s) proposé(s) pour ' + decision.hote + '.');
        return true;
      } catch (e) {
        journal('warning', 'Identifiants : proposition impossible (' + (e && e.message) + ').');
        return false;
      }
    }
  };
}

module.exports = { COOLDOWN_MS, hoteDepuisUrl, doitProposer, creer };
