#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# scripts/diagnostic-demarrage.sh - rapport de demarrage a coller dans une
# issue (#52, #58, #59, #184).
#
# Usage, depuis la racine du depot, IAO FERME :
#     bash scripts/diagnostic-demarrage.sh            # lance IAO 40 s puis le ferme
#     bash scripts/diagnostic-demarrage.sh --sans-lancer
#     IAO_DIAG_DUREE=90 bash scripts/diagnostic-demarrage.sh
#     bash scripts/diagnostic-demarrage.sh --publier 58   # + commentaire dans l'issue
#
# --publier <n> : apres affichage du rapport, demande confirmation puis le
# publie en commentaire de l'issue <n> avec la commande gh (gh auth login
# au prealable). Sans gh, le rapport reste a coller a la main.
#
# Le script ne modifie rien dans le dossier de donnees : il lit
# ~/.config/ai-manager (ou $XDG_CONFIG_HOME/ai-manager) et ecrit le rapport
# Markdown dans /tmp/iao-diagnostic-<date>.md (et sur la sortie standard).
# Aucun mot de passe ni cookie n'est lu : seuls les noms de fichiers
# n'appartenant pas au compte courant et les lignes du journal IAO sont repris.
# ---------------------------------------------------------------------------
set -u

RACINE="$(cd "$(dirname "$0")/.." && pwd)"
DONNEES="${XDG_CONFIG_HOME:-$HOME/.config}/ai-manager"
JOURNAL="$DONNEES/logs/iao.log"
DUREE="${IAO_DIAG_DUREE:-40}"
LANCER=1
PUBLIER=""
DEPOT="${IAO_DIAG_DEPOT:-Mathilde-Team/IAO}"
GH="${IAO_DIAG_GH:-gh}"
while [ $# -gt 0 ]; do
  case "$1" in
    --sans-lancer) LANCER=0 ;;
    --publier)
      PUBLIER="${2:-}"; shift
      case "$PUBLIER" in
        ''|*[!0-9]*) echo "--publier attend un numéro d'issue (ex. --publier 58)." >&2; exit 2 ;;
      esac ;;
    *) echo "Option inconnue : $1 (options : --sans-lancer, --publier <n>)" >&2; exit 2 ;;
  esac
  shift
done
RAPPORT="/tmp/iao-diagnostic-$(date +%Y%m%d-%H%M%S).md"
SORTIE_APP="$(mktemp /tmp/iao-diag-sortie.XXXXXX)"

compter() { # compter <motif> <fichier> : nombre de lignes correspondantes
  [ -f "$2" ] || { echo 0; return; }
  grep -c -- "$1" "$2" 2>/dev/null || true
}

instances() { pgrep -u "$(id -u)" -f "electron.*$RACINE|/IAO( |$)|ai-manager" 2>/dev/null | wc -l; }

{
  echo "## Diagnostic de démarrage IAO"
  echo
  echo "| Élément | Valeur |"
  echo "|---|---|"
  echo "| Date | $(date '+%d/%m/%Y %H:%M:%S %Z') |"
  echo "| Système | $(. /etc/os-release 2>/dev/null && echo "${PRETTY_NAME:-?}") — noyau $(uname -r) |"
  echo "| Session graphique | ${XDG_SESSION_TYPE:-?} (${XDG_CURRENT_DESKTOP:-?}) |"
  echo "| Compte | $(id -un) (uid $(id -u)) |"
  echo "| Node / npm | $(node -v 2>/dev/null || echo absent) / $(npm -v 2>/dev/null || echo absent) |"
  echo "| Electron | $(node -p "require('$RACINE/node_modules/electron/package.json').version" 2>/dev/null || echo 'non installé (npm ci)') |"
  echo "| Commit | $(git -C "$RACINE" log -1 --format='%h %cd %s' --date=short 2>/dev/null || echo ?) |"
  echo "| Branche | $(git -C "$RACINE" rev-parse --abbrev-ref HEAD 2>/dev/null || echo ?) |"
  echo "| Dossier de données | $DONNEES ($( [ -d "$DONNEES" ] && du -sh "$DONNEES" 2>/dev/null | cut -f1 || echo absent)) |"
  echo "| Instances IAO déjà ouvertes | $(instances) |"
  echo
  # --- Carte graphique (issue #52 : « vaInitialize failed ») -----------------
  echo "### Carte graphique"
  echo
  echo '```'
  if command -v lspci >/dev/null 2>&1; then
    lspci -nn 2>/dev/null | grep -Ei 'vga|3d|display' || echo "aucune carte trouvée par lspci"
  else
    echo "lspci absent (paquet pciutils)"
  fi
  if command -v vainfo >/dev/null 2>&1; then
    vainfo 2>&1 | grep -Ei 'driver version|vainitialize|error' | head -n 3
  else
    echo "vainfo absent (paquet vainfo) : pilote VA-API non vérifié"
  fi
  echo "LIBVA_DRIVER_NAME=${LIBVA_DRIVER_NAME:-non défini}"
  echo '```'
  echo

  # --- Droits sur le dossier de donnees (issue #184 / PR #197) --------------
  echo "### Fichiers n'appartenant pas à $(id -un)"
  echo
  if [ -d "$DONNEES" ]; then
    ETRANGERS="$(find "$DONNEES" -maxdepth 6 ! -user "$(id -u)" 2>/dev/null)"
    NB=$(printf '%s' "$ETRANGERS" | grep -c . || true)
    echo "Nombre : **$NB**"
    if [ "$NB" -gt 0 ]; then
      echo
      echo '```'
      printf '%s\n' "$ETRANGERS" | head -n 10 | while read -r f; do stat -c '%U:%G %a %n' "$f"; done
      echo '```'
      echo "Correction (à lancer IAO fermé) : \`sudo chown -R $(id -un): \"$DONNEES\"\`"
    fi
  else
    echo "Dossier absent (premier lancement)."
  fi
  echo
} > "$RAPPORT"

# --- Lancement controle -------------------------------------------------------
if [ "$LANCER" = 1 ]; then
  if [ "$(instances)" -gt 0 ]; then
    echo "IAO est déjà ouvert : fermez toutes les fenêtres puis relancez ce script." >&2
    echo "Lancement non effectué : IAO était déjà ouvert." >> "$RAPPORT"
  else
    LIGNES_AVANT=$( [ -f "$JOURNAL" ] && wc -l < "$JOURNAL" || echo 0 )
    echo "Lancement d'IAO pendant $DUREE s (npm run start:debug)..." >&2
    ( cd "$RACINE" && exec npm run -s start:debug ) > "$SORTIE_APP" 2>&1 &
    PID=$!
    sleep 10
    # Seconde instance : doit rendre la main tout de suite (#53).
    ( cd "$RACINE" && timeout 20 npm run -s start ) > "$SORTIE_APP.2" 2>&1
    CODE2=$?
    sleep $(( DUREE > 10 ? DUREE - 10 : 0 ))
    pkill -TERM -P "$PID" 2>/dev/null; kill -TERM "$PID" 2>/dev/null
    sleep 3; pkill -KILL -P "$PID" 2>/dev/null
    {
      echo "### Lancement contrôlé ($DUREE s)"
      echo
      echo "| Contrôle | Résultat |"
      echo "|---|---|"
      echo "| « Failed to delete the database » (terminal) | $(compter 'Failed to delete the database' "$SORTIE_APP") |"
      echo "| « Could not open the quota database » (terminal) | $(compter 'Could not open the quota database' "$SORTIE_APP") |"
      echo "| « vaInitialize failed » (terminal, #52) | $(compter 'vaInitialize failed' "$SORTIE_APP") |"
      echo "| Seconde instance rendue (code, 124 = bloquée) | $CODE2 $( [ "$CODE2" = 124 ] && echo '— ANOMALIE' || echo '— ok') |"
      if [ -f "$JOURNAL" ]; then
        NOUVEAU="$(tail -n +"$((LIGNES_AVANT + 1))" "$JOURNAL")"
        echo "| « interface chargée » (iao.log) | $(printf '%s\n' "$NOUVEAU" | grep -c 'interface chargée' || true) |"
        echo "| Lignes [error] (iao.log) | $(printf '%s\n' "$NOUVEAU" | grep -ci 'error' || true) |"
        echo
        echo "Extrait du journal de ce lancement (60 dernières lignes) :"
        echo
        echo '```'
        printf '%s\n' "$NOUVEAU" | tail -n 60
        echo '```'
      else
        echo
        echo "Journal $JOURNAL absent après le lancement."
      fi
      echo
      echo "Sortie du terminal (30 dernières lignes) :"
      echo
      echo '```'
      tail -n 30 "$SORTIE_APP"
      echo '```'
    } >> "$RAPPORT"
  fi
else
  {
    echo "### Journal existant"
    echo
    echo "| Contrôle | Résultat |"
    echo "|---|---|"
    echo "| « Failed to delete the database » (iao.log) | $(compter 'Failed to delete the database' "$JOURNAL") |"
    echo "| Démarrages journalisés (iao.log) | $(compter 'interface chargée' "$JOURNAL") |"
  } >> "$RAPPORT"
fi
rm -f "$SORTIE_APP" "$SORTIE_APP.2"

echo
cat "$RAPPORT"
echo
echo "Rapport enregistré : $RAPPORT" >&2

# --- Publication dans l'issue (--publier <n>) ---------------------------------
if [ -z "$PUBLIER" ]; then
  echo "Collez-le dans l'issue avec une capture des comptes (ou relancez avec --publier <n>)." >&2
  exit 0
fi
if ! command -v "$GH" >/dev/null 2>&1; then
  echo "gh absent : collez le rapport à la main dans https://github.com/$DEPOT/issues/$PUBLIER" >&2
  exit 0
fi
if ! "$GH" auth status >/dev/null 2>&1; then
  echo "gh n'est pas connecté (gh auth login) : collez le rapport à la main dans https://github.com/$DEPOT/issues/$PUBLIER" >&2
  exit 0
fi
REPONSE="${IAO_DIAG_CONFIRMER:-}"
if [ -z "$REPONSE" ]; then
  printf "Publier ce rapport (noms de fichiers et journal compris) dans l'issue #%s de %s ? [o/N] " "$PUBLIER" "$DEPOT" >&2
  read -r REPONSE < /dev/tty || REPONSE=""
fi
case "$REPONSE" in
  o|O|oui|Oui|y|Y)
    if "$GH" issue comment "$PUBLIER" -R "$DEPOT" -F "$RAPPORT"; then
      echo "Rapport publié dans l'issue #$PUBLIER. Ajoutez-y une capture des comptes." >&2
    else
      echo "Publication impossible : collez le rapport à la main." >&2
      exit 1
    fi ;;
  *) echo "Rapport non publié." >&2 ;;
esac
