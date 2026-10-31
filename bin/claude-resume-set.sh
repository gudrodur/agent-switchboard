#!/usr/bin/env bash
# Snapshot the live Claude Code sessions, and reopen them after a reboot through claude-tab.sh --resume.
#
# --help prints everything between HELP-BEGIN and HELP-END below, never from a second copy.
# HELP-BEGIN
# Usage:
#   claude-resume-set.sh --snapshot [FILE]
#   claude-resume-set.sh --replay [FILE] [--dry-run]
#   claude-resume-set.sh --help | -h
#
#   --snapshot  record every live interactive session: its registry record in
#               <config>/sessions/<pid>.json, with the pid alive and its
#               /proc start time equal to the record's procStart. Each row
#               holds sessionId, cwd, model (the process's --model, else the
#               transcript's last assistant model), Remote Control (on when
#               the process has --remote-control or the record a
#               bridgeSessionId; named by the flag's value, else the cwd's
#               basename) and the kitty tab title. Writes FILE (default
#               <dir>/latest.json), a timestamped copy beside it, and a .md
#               a person can follow by hand. A session with no assistant turn
#               and no --model is left out, and said so.
#   --replay    run claude-tab.sh --resume for each row of FILE (default
#               <dir>/latest.json), one at a time, skipping a row whose session
#               is live already, so a second replay reopens nothing.
#               A Remote Control name another seat holds (a live session, or an
#               earlier row) gets a suffix, NAME-2, and a note on stderr, since
#               two seats on one name cannot be told apart from the phone.
#   --dry-run   with --replay: print each command, launch nothing.
#
# <dir> is ${XDG_STATE_HOME:-$HOME/.local/state}/claude-resume-set.
#
# Exit codes:
#   0  snapshot written / every row proven or already live
#   1  bad arguments, unreadable or empty FILE, or a row claude-tab.sh refused
#   2  kitty remote control unavailable (replay stops at once)
#   3  a row was launched but not proven (go look at its window)
# HELP-END
#
# Test seams: CLAUDE_SESSIONS_DIR and CLAUDE_PROJECTS_DIR (lib/claude-session.sh),
# CLAUDE_RESUME_SET_DIR (the snapshot dir), CLAUDE_RESUME_SET_TAB (the
# launcher, default claude-tab.sh beside this script).

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../lib/claude-session.sh"
DIR="${CLAUDE_RESUME_SET_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/claude-resume-set}"
TAB="${CLAUDE_RESUME_SET_TAB:-$HERE/claude-tab.sh}"

die()  { printf '%s\n' "claude-resume-set: $1" >&2; exit "${2:-1}"; }
note() { printf '%s\n' "claude-resume-set: $*" >&2; }

# One process's argv, one argument per line.
argv_of() { tr '\0' '\n' < "/proc/$1/cmdline" 2>/dev/null; }
# The value after flag $2 in pid $1's argv, or nothing; a value starting with
# '-' is the next flag, not a value.
flag_value() {
  argv_of "$1" | awk -v f="$2" 'hit { if ($0 !~ /^-/) print; exit } $0 == f { hit = 1 }'
}
# Not grep -q: an early exit kills tr with SIGPIPE, and pipefail fails the match.
has_flag() { argv_of "$1" | grep -x -- "$2" >/dev/null; }

snapshot() {
  local out="$1" rows="[]" f rec pid sid cwd model rc rc_name title transcript skipped=0 kls
  kls=$(kitty @ ls 2>/dev/null || printf '[]')
  for f in "$CLAUDE_SESSIONS_DIR"/*.json; do
    [ -f "$f" ] || continue
    [ "$(jq -r '.kind // ""' "$f" 2>/dev/null)" = interactive ] || continue
    claude_record_live "$f" || continue
    rec=$(cat "$f")
    pid=$(printf '%s' "$rec" | jq -r .pid)
    sid=$(printf '%s' "$rec" | jq -r '.sessionId // ""')
    cwd=$(printf '%s' "$rec" | jq -r '.cwd // ""')
    [ -n "$sid" ] && [ -n "$cwd" ] || continue
    model=$(flag_value "$pid" --model)
    if [ -z "$model" ]; then
      transcript=$(claude_transcript_of "$rec")
      model=$({ claude_assistant_models < "$transcript"; } 2>/dev/null | tail -1)
    fi
    if [ -z "$model" ]; then
      note "session $sid (pid $pid) has no --model and no assistant turn — left out"
      skipped=$((skipped + 1)); continue
    fi
    rc=false; rc_name=""
    if has_flag "$pid" --remote-control || printf '%s' "$rec" | jq -e '.bridgeSessionId | strings | length > 0' >/dev/null 2>&1; then
      rc=true
      rc_name=$(flag_value "$pid" --remote-control)
      [ -n "$rc_name" ] || rc_name=$(basename "$cwd")
    fi
    title=$(printf '%s' "$kls" | jq -r --argjson pid "$pid" '
      [.[].tabs[] | select(any(.windows[].foreground_processes[]?; .pid == $pid)) | .title] | first // ""' 2>/dev/null)
    [ -n "$title" ] || title="claude: $(basename "$cwd")"
    rows=$(printf '%s' "$rows" | jq -c --arg sid "$sid" --arg cwd "$cwd" --arg model "$model" \
      --argjson rc "$rc" --arg rcName "$rc_name" --arg title "$title" --argjson pid "$pid" \
      '. + [{sessionId: $sid, cwd: $cwd, model: $model, rc: $rc, rcName: (if $rc then $rcName else null end), title: $title, pid: $pid}]')
  done
  local n stamp tmp md
  n=$(printf '%s' "$rows" | jq length)
  mkdir -p "$(dirname "$out")" || die "cannot create $(dirname "$out")"
  stamp=$(LC_ALL=C date -u +%Y-%m-%dT%H:%M:%SZ)
  tmp="$out.tmp.$$"
  printf '%s' "$rows" | jq --arg at "$stamp" '{snapshotAt: $at, sessions: .}' > "$tmp" && mv "$tmp" "$out" \
    || die "could not write $out"
  cp "$out" "$(dirname "$out")/snapshot-$(LC_ALL=C date -u +%Y%m%dT%H%M%SZ).json"
  md="${out%.json}.md"
  {
    printf '# Claude Code sessions live at %s\n\n' "$stamp"
    printf 'Reopen them all, each proven on its model: `%s --replay %s`\n\n' "$0" "$out"
    printf 'By hand, one kitty tab per line:\n\n```bash\n'
    printf '%s' "$rows" | jq -r '.[] | "cd \(.cwd | @sh) && claude --model \(.model | @sh)\(if .rc then " --remote-control \(.rcName | @sh)" else "" end) --resume \(.sessionId)"'
    printf '```\n'
  } > "$md"
  note "snapshot of $n live session(s)$([ "$skipped" = 0 ] || printf ', %s left out' "$skipped") written to $out (and $md)"
  printf 'SNAPSHOT=%s\n' "$out"
}

# A name free among the taken ones, for a row whose own name is taken: NAME-2, NAME-3.
free_rc_name() { # $1 = the name; reads the caller's TAKEN_RC
  local k=2
  while [ -n "${TAKEN_RC["$1-$k"]:-}" ]; do k=$((k + 1)); done
  printf '%s-%s' "$1" "$k"
}

replay() {
  local file="$1" dry="$2" n i row sid live code worst=0 out rc_name f pid
  local -A TAKEN_RC=()
  [ -r "$file" ] || die "no snapshot at $file — take one with --snapshot before the reboot"
  n=$(jq '.sessions | length' "$file" 2>/dev/null) || die "$file is not a snapshot"
  [ "$n" -gt 0 ] || die "$file holds no sessions"
  # Names in use before anything opens: a seat started by hand since the reboot
  # (it is in no row), and a row that is live already wherever it sits in the file.
  for f in "$CLAUDE_SESSIONS_DIR"/*.json; do
    [ -f "$f" ] && claude_record_live "$f" || continue
    pid=$(jq -r .pid "$f")
    rc_name=$(flag_value "$pid" --remote-control)
    [ -z "$rc_name" ] || TAKEN_RC["$rc_name"]=1
  done
  for i in $(seq 0 $((n - 1))); do
    row=$(jq -c ".sessions[$i]" "$file")
    [ "$(printf '%s' "$row" | jq -r .rc)" = true ] || continue
    claude_live_record_of "$(printf '%s' "$row" | jq -r .sessionId)" >/dev/null || continue
    TAKEN_RC["$(printf '%s' "$row" | jq -r .rcName)"]=1
  done
  for i in $(seq 0 $((n - 1))); do
    row=$(jq -c ".sessions[$i]" "$file")
    sid=$(printf '%s' "$row" | jq -r .sessionId)
    if live=$(claude_live_record_of "$sid"); then
      printf 'SKIP %s live in pid %s\n' "$sid" "$(printf '%s' "$live" | jq -r .pid)"
      continue
    fi
    local args=(--resume "$sid" --title "$(printf '%s' "$row" | jq -r .title)" --model "$(printf '%s' "$row" | jq -r .model)")
    if [ "$(printf '%s' "$row" | jq -r .rc)" = true ]; then
      rc_name=$(printf '%s' "$row" | jq -r .rcName)
      if [ -n "${TAKEN_RC["$rc_name"]:-}" ]; then
        local wanted="$rc_name"
        rc_name=$(free_rc_name "$wanted")
        note "duplicate rc name '$wanted': session $sid opens as '$rc_name'"
      fi
      TAKEN_RC["$rc_name"]=1
      args+=(--rc "$rc_name")
    fi
    if [ "$dry" = 1 ]; then
      printf 'WOULD %s' "$TAB"; printf ' %q' "${args[@]}"; printf '\n'
      continue
    fi
    out=$("$TAB" "${args[@]}"); code=$?
    case "$code" in
      0) printf 'OK %s %s\n' "$sid" "$(printf '%s' "$out" | grep -m1 '^WINDOW_ID=')" ;;
      2) die "kitty remote control unavailable — nothing more launched" 2 ;;
      3) printf 'UNPROVEN %s %s\n' "$sid" "$(printf '%s' "$out" | grep -m1 '^WINDOW_ID=')"; worst=3 ;;
      *) printf 'REFUSED %s (exit %s)\n' "$sid" "$code"; [ "$worst" = 3 ] || worst=1 ;;
    esac
  done
  exit "$worst"
}

MODE=""; FILE=""; DRY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --help|-h) sed -n '/^# HELP-BEGIN$/,/^# HELP-END$/p' "$0" | sed -e '1d;$d' -e 's/^# \?//'; exit 0 ;;
    --snapshot|--replay)
      [ -z "$MODE" ] || die "--snapshot and --replay are one per run"
      MODE=${1#--}; shift
      case "${1:-}" in ""|--*) ;; *) FILE="$1"; shift ;; esac ;;
    --dry-run) DRY=1; shift ;;
    *) die "unknown argument: $1 (see --help)" ;;
  esac
done
[ -n "$MODE" ] || die "--snapshot or --replay is required (see --help)"
[ "$DRY" = 0 ] || [ "$MODE" = replay ] || die "--dry-run goes with --replay"
[ -n "$FILE" ] || FILE="$DIR/latest.json"
case "$FILE" in /*) ;; *) die "FILE must be absolute: $FILE" ;; esac
if [ "$MODE" = snapshot ]; then snapshot "$FILE"; else replay "$FILE" "$DRY"; fi
