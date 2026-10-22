'use strict';

// lib/claude-adapter.js — fonctions PURES pour l'adaptateur d'automatisation
// Claude.ai (lot 18/09/2026, points 7-8, 10-13). Aucune dépendance à Electron
// ni au DOM -> testable par `node --test` (invariant 11, CLAUDE.md).
//
// Périmètre : seuls les jobs de service "claude" sont concernés (point 10).
// Ce module fournit :
//   - CLAUDE_SELECTORS : configuration des sélecteurs CSS candidats pour
//     chaque élément de la page Claude.ai (boutons, zone de chat, upload).
//   - detectQuotaMessage(text) : détecte le message « Vous n'avez plus de
//     messages gratuits jusqu'à HH:MM » dans un texte (point 7).
//   - buildClaudeDetectionScript() : génère le JS à exécuter dans la
//     <webview> via executeJavaScript pour détecter les éléments (point 7).
//   - buildPromptInjectionScript(prompt) : génère le JS pour coller le prompt
//     dans la zone de chat et déclencher l'envoi (point 8).
//   - buildFileUploadScript() : génère le JS pour trouver l'input file (point 8).
//   - parseClaudeResponse(html) : extrait le texte de la dernière réponse de
//     l'assistant pour analyse (point 13).
//
// IMPORTANT : les sélecteurs CSS de Claude.ai ne sont pas vérifiables dans
// l'environnement de développement (pas d'accès réseau aux services IA).
// Ils sont basés sur l'inspection de la structure DOM de Claude.ai et doivent
// être validés sur un compte réel avant une automatisation en production.
// Voir FEATURES.md P1 « Fenêtre d'automatisation dédiée ».

// ---------------------------------------------------------------------------
// Configuration des sélecteurs CSS pour Claude.ai (point 7).
// Chaque entrée est une liste de sélecteurs candidats essayés dans l'ordre.
// Le premier qui matche dans la page est utilisé. Cette approche multi-
// sélecteurs rend l'adaptateur résistant aux changements de classe CSS
// générés par le framework React de Claude.ai.
// ---------------------------------------------------------------------------
const CLAUDE_SELECTORS = {
  // Bouton « Continuer » (reprise d'une conversation existante)
  continueButton: [
    'button[aria-label="Continuer"]',
    'button[aria-label="Continue"]',
    'a[href*="/continue"]',
    'button:has(svg[data-testid="continue-icon"])'
  ],
  // Bouton « Télécharger » (téléchargement d'un fichier livré)
  downloadButton: [
    'button[aria-label="Télécharger"]',
    'button[aria-label="Download"]',
    'a[download]',
    'button:has(svg[data-testid="download-icon"])'
  ],
  // Bouton « Nouveau » dans le menu (nouvelle conversation)
  newChatButton: [
    'button[aria-label="Nouvelle conversation"]',
    'button[aria-label="New chat"]',
    'a[href="/new"]',
    'a[href*="/new"]',
    'button:has(span:contains("Nouveau"))',
    'button:has(span:contains("New"))'
  ],
  // Zone de chat où l'on écrit le prompt.
  // Claude utilise un ProseMirror contenteditable (PAS un textarea).
  // Sources : dev.to, deepwiki.com, greasyfork.org (2025-2026).
  chatInput: [
    'div[contenteditable="true"].ProseMirror',
    'div[contenteditable="true"][role="textbox"]',
    'div.ProseMirror[contenteditable="true"]',
    '[data-testid="chat-input"] [contenteditable]',
    'div[contenteditable="true"][data-testid]',
    'div[contenteditable="true"][placeholder]',
    'div[contenteditable="true"]'
  ],
  // Bouton « Ajouter des fichiers... » (upload de fichier)
  fileUpload: [
    'input[type="file"]',
    'button[aria-label="Ajouter des fichiers"]',
    'button[aria-label="Attach files"]',
    'button[aria-label="Add files"]',
    'label:has(input[type="file"])'
  ],
  // Bouton d'envoi du message.
  // Note : Claude utilise « Send Message » avec M majuscule.
  // Sources : github.com/h-ohsaki, scriptcat.org (2025-2026).
  sendButton: [
    'button[data-testid="send-button"]',
    'button[aria-label="Send Message"]',
    'button[aria-label="Send message"]',
    'button[aria-label="Envoyer le message"]',
    'button[type="submit"]:has(svg)',
    'button[aria-label*="Send"]'
  ],
  // Blocs de réponse de l'assistant.
  // Sources : deepwiki.com (stabilité HIGH), dev.to, recurate.ai (2025-2026).
  // Sélecteur combiné (stabilité HIGH) : l'élément assistant AVEC streaming.
  // .font-claude-response est le wrapper de contenu (stabilité MEDIUM).
  // Les sélecteurs larges suivants servent de repli si Claude change ses attributs.
  assistantMessages: [
    'div[data-testid="assistant-message"][data-is-streaming]',
    '[data-is-streaming]',
    'div[data-testid="assistant-message"]',
    '.font-claude-response',
    'div[class*="font-claude"]',
    'div[class*="assistant"]',
    'div[class*="response-content"]'
  ]
};

// ---------------------------------------------------------------------------
// Détecte le message de quota gratuit épuisé (point 7).
// Claude.ai affiche : « Vous n'avez plus de messages gratuits jusqu'à HH:MM »
// ou en anglais : « You've run out of free messages until HH:MM AM/PM ».
// Renvoie { detected: true, time: "HH:MM" } si le message est trouvé, sinon
// { detected: false, time: null }.
// ---------------------------------------------------------------------------
function detectQuotaMessage(text) {
  if (typeof text !== 'string' || !text) return { detected: false, time: null };
  // Version française : « Vous n'avez plus de messages gratuits jusqu'à 22:10 »
  // Inclut les apostrophes courbes (U+2019) et droites (U+0027), et le « à »
  // français qui précède l'heure.
  const frMatch = text.match(/plus de messages gratuits jusqu[\u2019\u2018'\x27]\s*(?:\u00e0\s*)?(\d{1,2}:\d{2})/i);
  if (frMatch) return { detected: true, time: frMatch[1] };
  // Version anglaise : « You've run out of free messages until 10:10 PM »
  const enMatch = text.match(/free messages until\s+(\d{1,2}:\d{2}\s*(?:AM|PM)?)/i);
  if (enMatch) return { detected: true, time: enMatch[1].trim() };
  return { detected: false, time: null };
}

// ---------------------------------------------------------------------------
// Génère le script JavaScript à exécuter dans la <webview> Claude.ai pour
// détecter tous les éléments configurés (point 7). Le script renvoie un objet
// JSON avec le compte d'éléments trouvés pour chaque catégorie + des infos
// sur le message de quota et les popups.
//
// Le script est conçu pour être injecté via webContents.executeJavaScript().
// Il n'écrit rien dans la page — lecture pure.
// ---------------------------------------------------------------------------
function buildClaudeDetectionScript() {
  // On sérialise CLAUDE_SELECTORS en JSON pour l'embarquer dans le script.
  const selectorsJson = JSON.stringify(CLAUDE_SELECTORS);
  return `(function() {
    var selectors = ${selectorsJson};
    var result = {};
    for (var key in selectors) {
      var candidates = selectors[key];
      var found = false;
      var count = 0;
      var firstEl = null;
      for (var i = 0; i < candidates.length; i++) {
        try {
          var els = document.querySelectorAll(candidates[i]);
          if (els.length > 0) {
            found = true;
            count += els.length;
            if (!firstEl) firstEl = candidates[i];
          }
        } catch(e) { /* sélecteur invalide, on passe au suivant */ }
      }
      result[key] = { found: found, count: count, selector: firstEl };
    }
    // Détection du message de quota (point 7)
    var bodyText = document.body ? document.body.innerText || '' : '';
    var quotaFr = bodyText.match(/plus de messages gratuits jusqu['\\u2019\\u2018\\x27]\\s*(?:\\u00e0\\s*)?(\\d{1,2}:\\d{2})/i);
    var quotaEn = bodyText.match(/free messages until\\s+(\\d{1,2}:\\d{2}\\s*(?:AM|PM)?)/i);
    result.quotaMessage = {
      detected: !!(quotaFr || quotaEn),
      time: quotaFr ? quotaFr[1] : (quotaEn ? quotaEn[1].trim() : null)
    };
    // Détection des popups (dialogues modaux non désirés, point 7)
    result.popups = {
      count: document.querySelectorAll('div[role="dialog"], [class*="modal"], [class*="popup"]').length
    };
    return JSON.stringify(result);
  })();`;
}

// ---------------------------------------------------------------------------
// Génère le script JavaScript pour injecter le prompt dans la zone de chat
// de Claude.ai et déclencher l'envoi (point 8).
//
// Le script :
//   1. Trouve la zone de chat (contenteditable ou textarea)
//   2. Injecte le texte du prompt
//   3. Déclenche l'événement d'envoi (Enter ou clic sur le bouton Send)
//
// Le prompt est échappé pour être injecté en toute sécurité dans le JS.
// ---------------------------------------------------------------------------
function buildPromptInjectionScript(prompt) {
  // Échappe le prompt pour l'injection dans une chaîne JS
  var escaped = String(prompt || '')
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r');
  var selectorsJson = JSON.stringify(CLAUDE_SELECTORS);
  return `(function() {
    var promptText = '${escaped}';
    var selectors = ${selectorsJson};
    var chatInput = null;
    for (var i = 0; i < selectors.chatInput.length; i++) {
      try {
        chatInput = document.querySelector(selectors.chatInput[i]);
        if (chatInput) break;
      } catch(e) {}
    }
    if (!chatInput) return JSON.stringify({ ok: false, error: 'chat_input_not_found' });
    // Injection selon le type d'élément
    if (chatInput.tagName === 'TEXTAREA') {
      var nativeInputValue = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value');
      if (nativeInputValue && nativeInputValue.set) {
        nativeInputValue.set.call(chatInput, promptText);
      } else {
        chatInput.value = promptText;
      }
      chatInput.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      // contenteditable : on insère le texte comme contenu
      chatInput.focus();
      chatInput.textContent = promptText;
      chatInput.dispatchEvent(new InputEvent('input', { bubbles: true, data: promptText, inputType: 'insertText' }));
    }
    // Envoi : on cherche le bouton Send, sinon on simule Enter
    var sendBtn = null;
    for (var j = 0; j < selectors.sendButton.length; j++) {
      try {
        sendBtn = document.querySelector(selectors.sendButton[j]);
        if (sendBtn) break;
      } catch(e) {}
    }
    if (sendBtn) {
      sendBtn.click();
      return JSON.stringify({ ok: true, method: 'send_button' });
    }
    // Repli : simuler la touche Enter
    chatInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
    return JSON.stringify({ ok: true, method: 'enter_key' });
  })();`;
}

// ---------------------------------------------------------------------------
// Génère le script JavaScript pour trouver l'input[type=file] de Claude.ai
// et déclencher l'upload (point 8).
//
// NOTE : un <input type="file"> ne peut PAS recevoir un fichier via un simple
// executeJavaScript — c'est une restriction de sécurité du navigateur. L'upload
// réel doit se faire via CDP (webContents.debugger -> DOM.setFileInputFiles).
// Ce script localise juste l'input pour que le CDP puisse agir dessus.
// ---------------------------------------------------------------------------
function buildFileUploadScript() {
  var selectorsJson = JSON.stringify(CLAUDE_SELECTORS);
  return `(function() {
    var selectors = ${selectorsJson};
    var fileInput = null;
    for (var i = 0; i < selectors.fileUpload.length; i++) {
      try {
        fileInput = document.querySelector(selectors.fileUpload[i]);
        if (fileInput && fileInput.tagName === 'INPUT' && fileInput.type === 'file') break;
        fileInput = null;
      } catch(e) {}
    }
    if (!fileInput) return JSON.stringify({ ok: false, error: 'file_input_not_found' });
    // Marque l'input avec un attribut temporaire pour que le CDP puisse le cibler
    fileInput.setAttribute('data-iao-upload-target', 'true');
    return JSON.stringify({
      ok: true,
      selector: 'input[data-iao-upload-target="true"]',
      accept: fileInput.accept || ''
    });
  })();`;
}

// ---------------------------------------------------------------------------
// Génère un délai aléatoire (en millisecondes) à appliquer après une détection
// et avant de passer à l'action. Le délai est compris entre 30 000 ms (30 s)
// et 300 000 ms (300 s / 5 min). Ce délai rend l'automatisation moins prévisible
// et évite les déclenchements trop instantanés après détection.
//
// Accepte un injecteur de randomness pour les tests (par défaut Math.random).
// ---------------------------------------------------------------------------
function randomDetectionDelayMs(rng) {
  var rand = (typeof rng === 'function') ? rng() : Math.random();
  // Bornes : 30 000 ms (30s) à 300 000 ms (300s)
  var min = 30000;
  var max = 300000;
  return Math.floor(min + rand * (max - min + 1));
}

// ---------------------------------------------------------------------------
// Calcule le temps d'attente (en millisecondes) jusqu'à l'heure de quota.
// Prend l'heure extraite par detectQuotaMessage (ex: "13:40") et l'heure
// courante, renvoie le nombre de ms à attendre. Ajoute une marge de sécurité
// de 60 secondes pour éviter de relancer trop tôt.
//
// Renvoie 0 si l'heure cible est déjà passée ou si le parsing échoue.
// ---------------------------------------------------------------------------
function computeQuotaWaitMs(quotaTime, now) {
  if (typeof quotaTime !== 'string' || !quotaTime) return 0;
  var match = quotaTime.match(/(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
  if (!match) return 0;
  var hours = parseInt(match[1], 10);
  var minutes = parseInt(match[2], 10);
  var ampm = match[3];
  if (ampm) {
    var upper = ampm.toUpperCase();
    if (upper === 'PM' && hours !== 12) hours += 12;
    if (upper === 'AM' && hours === 12) hours = 0;
  }
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return 0;

  var nowDate = (now instanceof Date) ? now : new Date();
  var target = new Date(nowDate);
  target.setHours(hours, minutes, 0, 0);
  // Marge de sécurité : 60 secondes
  target.setSeconds(target.getSeconds() + 60);
  // Si l'heure cible est déjà passée aujourd'hui, on suppose demain
  if (target.getTime() <= nowDate.getTime()) {
    target.setDate(target.getDate() + 1);
  }
  var waitMs = target.getTime() - nowDate.getTime();
  return waitMs > 0 ? waitMs : 0;
}

// ---------------------------------------------------------------------------
// Génère le script JavaScript pour fermer les popups non destructifs sur la
// page Claude.ai. Ne clique que sur les boutons de fermeture explicites
// (aria-label contenant « close », « dismiss », « Fermer ») à l'intérieur des
// dialogues modaux. Ne clique jamais sur des boutons ambigus.
// ---------------------------------------------------------------------------
function buildPopupDismissScript() {
  return `(function() {
    var dismissed = 0;
    var dialogs = document.querySelectorAll('div[role="dialog"], [class*="modal"], [class*="popup"]');
    dialogs.forEach(function(dialog) {
      var closeBtns = dialog.querySelectorAll(
        'button[aria-label*="close" i], button[aria-label*="dismiss" i], ' +
        'button[aria-label*="Fermer" i], button[aria-label*="fermer" i], ' +
        'button[aria-label="\u00d7"], [data-testid="close-button"], ' +
        'button:has(svg[data-testid="close-icon"])'
      );
      closeBtns.forEach(function(btn) {
        try { btn.click(); dismissed++; } catch(e) {}
      });
    });
    return JSON.stringify({ ok: true, dismissed: dismissed });
  })();`;
}

// ---------------------------------------------------------------------------
// Génère le script JavaScript pour cliquer sur le bouton « Continuer » de
// Claude.ai (reprise d'une conversation existante).
// ---------------------------------------------------------------------------
function buildContinueActionScript() {
  var selectorsJson = JSON.stringify(CLAUDE_SELECTORS);
  return `(function() {
    var selectors = ${selectorsJson};
    var btn = null;
    for (var i = 0; i < selectors.continueButton.length; i++) {
      try {
        btn = document.querySelector(selectors.continueButton[i]);
        if (btn) break;
      } catch(e) {}
    }
    if (!btn) return JSON.stringify({ ok: false, error: 'continue_button_not_found' });
    btn.click();
    return JSON.stringify({ ok: true, method: 'continue_button' });
  })();`;
}

// ---------------------------------------------------------------------------
// Génère le script JavaScript pour cliquer sur le bouton « Télécharger » de
// Claude.ai (téléchargement d'un fichier livré).
// ---------------------------------------------------------------------------
function buildDownloadActionScript() {
  var selectorsJson = JSON.stringify(CLAUDE_SELECTORS);
  return `(function() {
    var selectors = ${selectorsJson};
    var btn = null;
    for (var i = 0; i < selectors.downloadButton.length; i++) {
      try {
        btn = document.querySelector(selectors.downloadButton[i]);
        if (btn) break;
      } catch(e) {}
    }
    if (!btn) return JSON.stringify({ ok: false, error: 'download_button_not_found' });
    btn.click();
    return JSON.stringify({ ok: true, method: 'download_button' });
  })();`;
}

// ---------------------------------------------------------------------------
// Génère le script JavaScript pour cliquer sur le bouton « Nouveau chat » de
// Claude.ai (démarrer une nouvelle conversation).
// ---------------------------------------------------------------------------
function buildNewChatActionScript() {
  var selectorsJson = JSON.stringify(CLAUDE_SELECTORS);
  return `(function() {
    var selectors = ${selectorsJson};
    var btn = null;
    for (var i = 0; i < selectors.newChatButton.length; i++) {
      try {
        btn = document.querySelector(selectors.newChatButton[i]);
        if (btn) break;
      } catch(e) {}
    }
    if (!btn) return JSON.stringify({ ok: false, error: 'new_chat_button_not_found' });
    btn.click();
    return JSON.stringify({ ok: true, method: 'new_chat_button' });
  })();`;
}

// ---------------------------------------------------------------------------
// Extrait le texte de la dernière réponse de l'assistant Claude (point 13).
// Prend en entrée le HTML de la page ou le texte de la zone de réponse, et
// renvoie le texte brut de la dernière réponse pour analyse.
// ---------------------------------------------------------------------------
function parseClaudeResponse(htmlOrText) {
  if (typeof htmlOrText !== 'string' || !htmlOrText) return null;
  // Si c'est du HTML, on extrait le texte des blocs assistant
  if (htmlOrText.includes('<')) {
    // Cherche plusieurs patterns de blocs assistant (par ordre de priorité) :
    // 1. data-is-streaming (conteneur principal, stabilité HIGH)
    // 2. data-testid="assistant-message" (ancien pattern)
    // 3. class="font-claude-response" (wrapper de contenu)
    var patterns = [
      /data-is-streaming[^>]*>([\s\S]*?)<\/div>/gi,
      /data-testid="assistant-message"[^>]*>([\s\S]*?)<\/div>/gi,
      /class="[^"]*font-claude-response[^"]*"[^>]*>([\s\S]*?)<\/div>/gi
    ];
    for (var p = 0; p < patterns.length; p++) {
      var matches = [];
      var m;
      patterns[p].lastIndex = 0;
      while ((m = patterns[p].exec(htmlOrText)) !== null) {
        var text = m[1].replace(/<[^>]+>/g, '').trim();
        if (text) matches.push(text);
      }
      if (matches.length > 0) return matches[matches.length - 1];
    }
  }
  // Sinon, on renvoie le texte tel quel (limité à 5000 caractères)
  var plain = htmlOrText.replace(/<[^>]+>/g, '').trim();
  return plain ? plain.slice(0, 5000) : null;
}

// ---------------------------------------------------------------------------
// Génère le script JavaScript pour collecter la dernière réponse de Claude
// dans la <webview> (point 13). Le script renvoie le texte brut de la
// dernière réponse de l'assistant, ou null si aucune réponse n'est trouvée.
// ---------------------------------------------------------------------------
function buildResponseCollectionScript() {
  var selectorsJson = JSON.stringify(CLAUDE_SELECTORS);
  return `(function() {
    var selectors = ${selectorsJson};
    var messages = [];
    // Génération en cours : Claude.ai marque le message qui streame avec
    // data-is-streaming (attribut retiré quand la génération est TERMINÉE).
    var streaming = false;
    try { streaming = !!document.querySelector('[data-is-streaming]'); } catch(e) {}
    for (var i = 0; i < selectors.assistantMessages.length; i++) {
      try {
        var els = document.querySelectorAll(selectors.assistantMessages[i]);
        els.forEach(function(el) {
          var text = el.innerText || el.textContent || '';
          if (text.trim()) messages.push(text.trim());
        });
        if (messages.length > 0) break;
      } catch(e) {}
    }
    if (messages.length === 0) return JSON.stringify({ ok: false, response: null, streaming: streaming });
    return JSON.stringify({ ok: true, response: messages[messages.length - 1].slice(0, 5000), streaming: streaming });
  })();`;
}

// ---------------------------------------------------------------------------
// Décide de la prochaine étape d'automatisation à partir du résultat de
// buildClaudeDetectionScript() (point 7-8, lot 18/09/2026 suite). Fonction
// PURE de PLANIFICATION : elle ne clique ni n'exécute rien elle-même — elle
// retourne une décision structurée que l'appelant (scheduler, absent de ce
// zip) doit exécuter en injectant le script correspondant dans la <webview>.
//
// Priorités (dans cet ordre, la première condition qui matche l'emporte) :
//   1. Quota détecté          -> action 'wait_quota' (aucun script, attendre waitMs)
//   2. Popup détectée         -> action 'dismiss_popups' (buildPopupDismissScript)
//   3. requestedAction fourni ET sélecteur correspondant disponible
//                              -> action demandée, avec délai anti-détection
//   4. requestedAction fourni MAIS sélecteur indisponible
//                              -> action 'blocked' (raison : élément absent)
//   5. Aucune requestedAction -> action 'none' (rien à faire)
//
// IMPORTANT : cette fonction NE CHOISIT JAMAIS d'elle-même entre Continuer /
// Télécharger / Nouveau chat / Envoyer un prompt / Ajouter un fichier —
// l'appelant DOIT préciser opts.requestedAction. Cliquer au hasard sur ces
// boutons pourrait interrompre une génération en cours ou perdre du travail.
//
// Paramètres :
//   detection : objet OU chaîne JSON — résultat de buildClaudeDetectionScript()
//               une fois exécuté dans la webview (JSON.parse déjà fait ou pas)
//   opts.requestedAction : 'continue' | 'download' | 'new_chat' | 'upload_file'
//                           | 'send_prompt' | undefined
//   opts.prompt   : texte du prompt, requis si requestedAction === 'send_prompt'
//   opts.rng      : injecteur de randomness pour randomDetectionDelayMs (tests)
//   opts.now      : Date courante pour computeQuotaWaitMs (tests)
//   opts.minDelayMs : borne min du délai anti-détection (défaut 30000)
//   opts.maxDelayMs : borne max du délai anti-détection (défaut 300000)
//
// Renvoie : { action, reason, waitMs?, delayMs?, script?, scriptName? }
// ---------------------------------------------------------------------------
function planClaudeAutomationStep(detection, opts) {
  var o = opts || {};
  var det;
  if (typeof detection === 'string') {
    try { det = JSON.parse(detection); } catch (e) {
      return { action: 'blocked', reason: 'invalid_detection_json' };
    }
  } else if (detection && typeof detection === 'object') {
    det = detection;
  } else {
    return { action: 'blocked', reason: 'invalid_detection_input' };
  }

  // 1. Quota détecté -> priorité absolue, on n'agit sur rien d'autre.
  if (det.quotaMessage && det.quotaMessage.detected) {
    var waitMs = computeQuotaWaitMs(det.quotaMessage.time, o.now);
    return {
      action: 'wait_quota',
      reason: 'quota_detected',
      quotaTime: det.quotaMessage.time,
      waitMs: waitMs
    };
  }

  // 2. Popups détectées -> on les ferme avant toute autre action.
  if (det.popups && det.popups.count > 0) {
    return {
      action: 'dismiss_popups',
      reason: 'popups_detected',
      popupCount: det.popups.count,
      scriptName: 'buildPopupDismissScript',
      script: buildPopupDismissScript()
    };
  }

  var requestedAction = o.requestedAction;
  if (!requestedAction) {
    return { action: 'none', reason: 'no_action_requested' };
  }

  // Table de correspondance : action demandée -> clé de détection + builder.
  var actionMap = {
    continue: { detKey: 'continueButton', scriptName: 'buildContinueActionScript', builder: buildContinueActionScript },
    download: { detKey: 'downloadButton', scriptName: 'buildDownloadActionScript', builder: buildDownloadActionScript },
    new_chat: { detKey: 'newChatButton', scriptName: 'buildNewChatActionScript', builder: buildNewChatActionScript },
    upload_file: { detKey: 'fileUpload', scriptName: 'buildFileUploadScript', builder: buildFileUploadScript },
    send_prompt: { detKey: 'chatInput', scriptName: 'buildPromptInjectionScript', builder: null }
  };

  var mapping = actionMap[requestedAction];
  if (!mapping) {
    return { action: 'blocked', reason: 'unknown_requested_action', requestedAction: requestedAction };
  }

  var detEntry = det[mapping.detKey];
  var elementFound = !!(detEntry && detEntry.found);
  if (!elementFound) {
    return {
      action: 'blocked',
      reason: 'element_not_found',
      requestedAction: requestedAction,
      detKey: mapping.detKey
    };
  }

  if (requestedAction === 'send_prompt' && (typeof o.prompt !== 'string' || !o.prompt)) {
    return { action: 'blocked', reason: 'missing_prompt', requestedAction: requestedAction };
  }

  // 3. Action demandée disponible -> on ajoute le délai anti-détection avant
  //    de renvoyer le script à exécuter (l'appelant doit attendre delayMs
  //    avant d'injecter script, cf. randomDetectionDelayMs point 10).
  var minDelay = (typeof o.minDelayMs === 'number') ? o.minDelayMs : 30000;
  var maxDelay = (typeof o.maxDelayMs === 'number') ? o.maxDelayMs : 300000;
  var delayMs = (maxDelay <= minDelay) ? minDelay : Math.floor((o.rng || Math.random)() * (maxDelay - minDelay)) + minDelay;
  var script = mapping.builder
    ? mapping.builder()
    : buildPromptInjectionScript(o.prompt);

  return {
    action: requestedAction,
    reason: 'action_available',
    delayMs: delayMs,
    scriptName: mapping.scriptName,
    script: script
  };
}


// Chargé à la fois via <script src="lib/claude-adapter.js"> dans index.html
// et via require() depuis test/ (même pattern que lib/escape-html.js).
if (typeof window !== 'undefined') {
  window.CLAUDE_SELECTORS = CLAUDE_SELECTORS;
  window.detectQuotaMessage = detectQuotaMessage;
  window.buildClaudeDetectionScript = buildClaudeDetectionScript;
  window.buildPromptInjectionScript = buildPromptInjectionScript;
  window.buildFileUploadScript = buildFileUploadScript;
  window.parseClaudeResponse = parseClaudeResponse;
  window.buildResponseCollectionScript = buildResponseCollectionScript;
  window.randomDetectionDelayMs = randomDetectionDelayMs;
  window.computeQuotaWaitMs = computeQuotaWaitMs;
  window.buildPopupDismissScript = buildPopupDismissScript;
  window.buildContinueActionScript = buildContinueActionScript;
  window.buildDownloadActionScript = buildDownloadActionScript;
  window.buildNewChatActionScript = buildNewChatActionScript;
  window.planClaudeAutomationStep = planClaudeAutomationStep;
} else if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    CLAUDE_SELECTORS, detectQuotaMessage, buildClaudeDetectionScript,
    buildPromptInjectionScript, buildFileUploadScript, parseClaudeResponse,
    buildResponseCollectionScript, randomDetectionDelayMs, computeQuotaWaitMs,
    buildPopupDismissScript, buildContinueActionScript,
    buildDownloadActionScript, buildNewChatActionScript, planClaudeAutomationStep
  };
}
