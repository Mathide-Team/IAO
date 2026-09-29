// preload.js — pont sécurisé entre le renderer et le process principal.
//
// Issue #4 : migration vers contextIsolation: true + nodeIntegration: false.
// Ce script s'exécute dans le contexte ISOLÉ de la page (avant index.html).
//
// Issue #52 : ce preload est SANDBOXÉ (défaut Electron >= 20 dès que
// nodeIntegration vaut false). Il ne peut require() que 'electron',
// 'events', 'timers' et 'url' — un require('path') faisait échouer TOUT le
// preload (« module not found: path »), window.iaoAPI n'existait pas et
// l'interface restait vide (0 compte, 0 IA, aucune icône). N'ajouter ici
// AUCUN autre module : test/preload-sandbox.test.js le vérifie.
//
// Il expose une API MINIMALE via contextBridge.exposeInMainWorld :
//   window.iaoAPI.ipcInvoke(channel, ...args)  → ipcRenderer.invoke
//   window.iaoAPI.resolveMonacoBase()          → URL absolue de Monaco
//
// Aucun autre accès Node n'est exposé : le renderer ne peut appeler QUE
// les canaux IPC whitelistés par le process principal (main.js).

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('iaoAPI', {
  // Wrapper unique pour ipcRenderer.invoke : le renderer ne peut appeler
  // que des canaux IPC déjà enregistrés côté main.js (ipcMain.handle).
  // Aucune exposition de ipcRenderer.on/send/removeListener — l'app
  // n'utilise que invoke (requête/réponse, jamais push du main vers renderer).
  ipcInvoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),

  // URL absolue (file:///…/node_modules/monaco-editor/min/vs) du dossier
  // Monaco, calculée depuis l'URL de la page avec l'API URL standard (pas
  // besoin de path/url Node). Une URL file:// fonctionne pour le loader AMD
  // sous Linux comme sous Windows (un chemin « C:/… » y serait pris pour un
  // schéma d'URL), y compris dans l'app packagée (app.asar).
  resolveMonacoBase: () => {
    try {
      return new URL('node_modules/monaco-editor/min/vs', window.location.href).href;
    } catch (e) {
      return null;
    }
  }
});
