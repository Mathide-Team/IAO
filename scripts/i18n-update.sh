#!/usr/bin/env bash
# scripts/i18n-update.sh — catalogues gettext d'IAO (issue #51).
#
#   scripts/i18n-update.sh           régénère lang/messages.pot, met à jour
#                                    lang/<xx>.po (msgmerge, traductions
#                                    conservées) et compile les .mo
#   scripts/i18n-update.sh --check   ne modifie rien ; échoue si le .pot, un
#                                    .po ou un .mo n'est plus à jour ou si un
#                                    catalogue est invalide (mode CI)
#
# Sortie : tableau de l'état des traductions (aussi recopié dans
# $GITHUB_STEP_SUMMARY quand la variable existe).
# Prérequis : GNU gettext (xgettext, msgcat, msgmerge, msgattrib, msgfmt,
# msgunfmt) et Node.js.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
LANG_DIR=lang
DOMAIN=iao
POT="$LANG_DIR/messages.pot"
CHECK=0
[[ "${1:-}" == "--check" ]] && CHECK=1

for tool in xgettext msgcat msgmerge msgattrib msgfmt msgunfmt node; do
  command -v "$tool" >/dev/null || { echo "::error::$tool introuvable (installer gettext / Node.js)" >&2; exit 2; }
done

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
export LC_ALL=C.UTF-8

mapfile -t LOCALES < <(sed 's/#.*//' "$LANG_DIR/LINGUAS" | tr -s ' \t' '\n' | sed '/^$/d')

# Sources JavaScript : tout le code applicatif, jamais les tests ni node_modules.
mapfile -t JS_SOURCES < <(ls main.js preload.js assets/*.js lib/*.js scheduler/*.js 2>/dev/null | LC_ALL=C sort)

# Règles de pluriel (gettext, CLDR) des locales de lang/LINGUAS. Une locale
# absente ici reçoit la règle germanique et doit être vérifiée à l'ajout.
plural_forms() {
  case "$1" in
    ar) echo 'nplurals=6; plural=(n==0 ? 0 : n==1 ? 1 : n==2 ? 2 : n%100>=3 && n%100<=10 ? 3 : n%100>=11 ? 4 : 5);' ;;
    id|ja|ko|th|vi|zh) echo 'nplurals=1; plural=0;' ;;
    fa|fr|pt) echo 'nplurals=2; plural=(n > 1);' ;;
    cs) echo 'nplurals=3; plural=(n==1) ? 0 : (n>=2 && n<=4) ? 1 : 2;' ;;
    pl) echo 'nplurals=3; plural=(n==1 ? 0 : n%10>=2 && n%10<=4 && (n%100<10 || n%100>=20) ? 1 : 2);' ;;
    ru|uk) echo 'nplurals=3; plural=(n%10==1 && n%100!=11 ? 0 : n%10>=2 && n%10<=4 && (n%100<10 || n%100>=20) ? 1 : 2);' ;;
    ro) echo 'nplurals=3; plural=n==1 ? 0 : (n==0 || (n%100 > 0 && n%100 < 20)) ? 1 : 2;' ;;
    *) echo 'nplurals=2; plural=(n != 1);' ;;
  esac
}

# --- 1. Extraction -> POT -------------------------------------------------
node scripts/i18n-extract-html.js index.html > "$WORK/html.pot"
xgettext --language=JavaScript --from-code=UTF-8 --add-comments=TRANSLATORS \
  --keyword=_ --keyword=gettext --keyword=ngettext:1,2 --keyword=pgettext:1c,2 \
  --sort-by-file --no-wrap -o "$WORK/js.pot" "${JS_SOURCES[@]}"
POT_PARTS=("$WORK/html.pot")
[[ -s "$WORK/js.pot" ]] && POT_PARTS+=("$WORK/js.pot")
{
  cat <<HDR
# Catalogue source d'IAO — généré par scripts/i18n-update.sh, ne pas éditer.
# Langue source : français.
msgid ""
msgstr ""
"Project-Id-Version: IAO\n"
"Report-Msgid-Bugs-To: https://github.com/Mathide-Team/IAO/issues\n"
"MIME-Version: 1.0\n"
"Content-Type: text/plain; charset=UTF-8\n"
"Content-Transfer-Encoding: 8bit\n"

HDR
  msgcat --use-first --no-wrap "${POT_PARTS[@]}" | awk 'BEGIN{h=1} h && /^$/ {h=0; next} !h'
} > "$WORK/messages.pot"

# --- 2. msgmerge sur chaque .po, 3. compilation ---------------------------
STATUS=0
report() { printf '%s\n' "$*"; [[ -n "${GITHUB_STEP_SUMMARY:-}" ]] && printf '%s\n' "$*" >> "$GITHUB_STEP_SUMMARY"; return 0; }
outdated() { echo "::error file=$1::$1 n'est plus à jour : lancer scripts/i18n-update.sh et commiter le résultat" >&2; STATUS=1; }

if (( CHECK )); then
  [[ -f "$POT" ]] && cmp -s "$WORK/messages.pot" "$POT" || outdated "$POT"
else
  cp "$WORK/messages.pot" "$POT"
fi

TOTAL=$(msgfmt --statistics -o /dev/null "$WORK/messages.pot" 2>&1 | grep -oE '[0-9]+ untranslated' | grep -oE '[0-9]+' || echo 0)
report "## Internationalisation"
report ""
report "| Locale | Traduites | Non traduites | Floues | Compilée |"
report "|---|---:|---:|---:|---|"
OK=0; COMPILED=0; SUM_T=0; SUM_U=0; SUM_F=0
for loc in "${LOCALES[@]}"; do
  po="$LANG_DIR/$loc.po"
  mo="$LANG_DIR/$loc/LC_MESSAGES/$DOMAIN.mo"
  if [[ -f "$po" ]]; then
    cp "$po" "$WORK/$loc.po"
  else
    # Nouvelle locale : copie du .pot (msgstr vides) + en-têtes Language et
    # Plural-Forms. Pas de msginit : pour en, il recopie les msgid français.
    plural="$(plural_forms "$loc")"
    awk -v loc="$loc" -v pf="$plural" '
      !done && /^"Content-Transfer-Encoding/ { print; print "\"Language: " loc "\\n\""; print "\"Plural-Forms: " pf "\\n\""; done=1; next }
      { print }' "$WORK/messages.pot" > "$WORK/$loc.po"
  fi
  # msgmerge conserve les traductions existantes ; nouvelles chaînes : msgstr "".
  msgmerge --quiet --update --backup=none --previous --no-wrap "$WORK/$loc.po" "$WORK/messages.pot"
  msgattrib --no-obsolete --no-wrap -o "$WORK/$loc.po" "$WORK/$loc.po"
  compiled="non"
  if msgfmt --check --statistics -o "$WORK/$loc.mo" "$WORK/$loc.po" 2>"$WORK/$loc.stats"; then
    compiled="oui"; COMPILED=$((COMPILED + 1))
  else
    echo "::error file=$po::catalogue invalide : $(cat "$WORK/$loc.stats")" >&2; STATUS=1
  fi
  stats="$(cat "$WORK/$loc.stats")"
  t=$(grep -oE '[0-9]+ translated' <<<"$stats" | grep -oE '[0-9]+' || echo 0)
  f=$(grep -oE '[0-9]+ fuzzy' <<<"$stats" | grep -oE '[0-9]+' || echo 0)
  u=$(grep -oE '[0-9]+ untranslated' <<<"$stats" | grep -oE '[0-9]+' || echo 0)
  SUM_T=$((SUM_T + t)); SUM_U=$((SUM_U + u)); SUM_F=$((SUM_F + f))
  [[ "$compiled" == "oui" ]] && OK=$((OK + 1))
  report "| $loc | $t | $u | $f | $compiled |"

  if (( CHECK )); then
    [[ -f "$po" ]] && cmp -s "$WORK/$loc.po" "$po" || outdated "$po"
    if [[ "$compiled" == "oui" ]]; then
      # Compare le CONTENU (msgunfmt) et non les octets : deux versions de
      # msgfmt peuvent produire des tables de hachage différentes.
      if [[ -f "$mo" ]] && diff -q <(msgunfmt --no-wrap "$mo") <(msgunfmt --no-wrap "$WORK/$loc.mo") >/dev/null; then :; else outdated "$mo"; fi
    fi
  else
    cp "$WORK/$loc.po" "$po"
    mkdir -p "$(dirname "$mo")"
    [[ "$compiled" == "oui" ]] && cp "$WORK/$loc.mo" "$mo"
  fi
done

# .po orphelins (locale retirée de LINGUAS)
for po in "$LANG_DIR"/*.po; do
  loc="$(basename "$po" .po)"
  if ! printf '%s\n' "${LOCALES[@]}" | grep -qx "$loc"; then
    echo "::error file=$po::$po ne correspond à aucune locale de lang/LINGUAS" >&2; STATUS=1
  fi
done

report ""
report "Langues : ${#LOCALES[@]} — messages : $TOTAL — traduits : $SUM_T — non traduits : $SUM_U — flous : $SUM_F"
report "Locales valides : $OK/${#LOCALES[@]} — catalogues compilés : $COMPILED/${#LOCALES[@]}"
exit $STATUS
