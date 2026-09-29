#!/usr/bin/env bash
# Launch Claude Code in its OWN titled kitty tab with a brief, and PROVE it started on the asked model.
#
# --help prints everything between HELP-BEGIN and HELP-END below, never from a second copy.
# HELP-BEGIN
# Usage:
#   claude-tab.sh --title "claude: <what this is>" --brief /abs/brief.md \
#                 --model opus|sonnet|haiku|fable|<full model id> [--rc [NAME]]
#                 [--out /abs/out.md] [--cwd /abs/repo] [--slot-override "<reason>"]
#   claude-tab.sh --list | --close <window-id>       (omp-tab.sh's, on the same state file)
#   claude-tab.sh --help | -h
#
#   --rc [NAME]  start the session with Remote Control on, named NAME (default:
#                the --title), and require the bridge-session row as proof
#
# Exit codes, the same table as omp-tab.sh:
#   0  launched AND proven: a new Claude Code session file in --cwd whose first
#      assistant turn ran on --model (and, with --rc, a bridge-session row)
#   1  precondition failed (bad args, relative path, missing file, untrusted
#      folder, slot held)
#   2  kitty remote control unavailable — CALLER MUST FALL BACK TO HEADLESS AND SAY SO
#   3  launched but not proven (window id still printed; a wrong model closes it)
# HELP-END
#
# The Claude Code sibling of opencode-tab.sh (2026-09-29). Like opencode, the
# brief goes in as the initial prompt argument, so no keystrokes are sent. The
# proof is Claude Code's own transcript: it writes
# <config>/projects/<encoded cwd>/<session>.jsonl, whose rows carry `cwd`,
# `"model":"claude-…"` on each assistant message, and a `bridge-session` row
# when Remote Control is on. A file that was not there before the launch is
# the tab's; nothing is read off the screen.
#
# Shared with omp-tab.sh and opencode-tab.sh, on purpose: the state file and
# its row format (`WID PID @LAUNCHER TITLE`), so `omp-tab.sh --list` shows
# these tabs and `--close` refuses a window none of them launched; the
# one-slot gate (#699); and the `brief:<basename>` claim in agent-config's
# task-claim.mjs.
#
# Test seams: CLAUDE_TAB_BIN (the command the tab execs), CLAUDE_TAB_PROJECTS
# (the transcripts root), CLAUDE_TAB_CONFIG (the .claude.json holding folder
# trust), OMP_TAB_TASK_CLAIM (as omp-tab.sh).

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE="${XDG_RUNTIME_DIR:-/tmp}/omp-tab-launched.$(id -u)"

die()  { printf '%s\n' "claude-tab: $1" >&2; exit "${2:-1}"; }
note() { printf '%s\n' "claude-tab: $*" >&2; }
kitty_up() { kitty @ ls >/dev/null 2>&1; }

config_root() {
  if [ -n "${AGENT_CONFIG_HOME:-}" ]; then printf '%s' "$AGENT_CONFIG_HOME"
  elif [ -d "$HOME/agent-config" ]; then printf '%s' "$HOME/agent-config"
  else printf '%s' "$HOME/.claude"; fi
}
CLAUDE_BIN="${CLAUDE_TAB_BIN:-claude}"
PROJECTS="${CLAUDE_TAB_PROJECTS:-${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects}"
CLAUDE_JSON="${CLAUDE_TAB_CONFIG:-${CLAUDE_CONFIG_DIR:-$HOME}/.claude.json}"
CLAIM_CLI="${OMP_TAB_TASK_CLAIM:-$(config_root)/scripts/task-claim.mjs}"
claim_cli() {
  [ -r "$CLAIM_CLI" ] || { note "task-claim CLI not found at $CLAIM_CLI — brief claims skipped"; return 0; }
  node "$CLAIM_CLI" "$@"
}

# WINDOW id -> its pid, over windows only (kitty's tab and window ids overlap).
win_pid() {
  kitty @ ls 2>/dev/null \
    | jq -r --argjson id "$1" '.[].tabs[].windows[] | select(.id == $id) | .pid' 2>/dev/null \
    | head -1
}

case "${1:-}" in
  --help|-h) sed -n '/^# HELP-BEGIN$/,/^# HELP-END$/p' "$0" | sed -e '1d;$d' -e 's/^# \?//'; exit 0 ;;
  # omp-tab.sh owns --list and --close, including the refusal of a window it
  # did not launch and the release of the window's brief claim.
  --list|--close) exec "$HERE/omp-tab.sh" "$@" ;;
esac

TITLE=""; BRIEF=""; OUT=""; MODEL=""; CWD="$PWD"; SLOT_OVERRIDE=""; RC=0; RC_NAME=""
while [ $# -gt 0 ]; do
  case "$1" in
    --title) TITLE="${2:-}"; shift 2 ;;
    --brief) BRIEF="${2:-}"; shift 2 ;;
    --out) OUT="${2:-}"; shift 2 ;;
    --model|-m) MODEL="${2:-}"; shift 2 ;;
    --cwd) CWD="${2:-}"; shift 2 ;;
    --slot-override) SLOT_OVERRIDE="${2:-}"; shift 2 ;;
    --rc)
      RC=1; shift
      case "${1:-}" in ""|--*) ;; *) RC_NAME="$1"; shift ;; esac ;;
    *) die "unknown argument: $1 (see --help)" ;;
  esac
done

[ -n "$TITLE" ] || die "--title is required"
[ -n "$MODEL" ] || die "--model is required: a tab on the account default is the run nobody chose"
case "$MODEL" in
  opus|sonnet|haiku|fable|claude-*) ;;
  *) die "--model takes opus, sonnet, haiku, fable or a full claude-* id, got: $MODEL" ;;
esac
[ -n "$BRIEF" ] || die "--brief is required"
case "$BRIEF" in /*) ;; *) die "--brief must be absolute (it resolves against the tab's cwd): $BRIEF" ;; esac
[ -r "$BRIEF" ] || die "--brief not readable: $BRIEF"
case "$CWD" in /*) ;; *) die "--cwd must be absolute: $CWD" ;; esac
[ -d "$CWD" ] || die "--cwd is not a directory: $CWD"
if [ -n "$OUT" ]; then case "$OUT" in /*) ;; *) die "--out must be absolute: $OUT" ;; esac; fi
command -v "$CLAUDE_BIN" >/dev/null 2>&1 || die "claude binary not found: $CLAUDE_BIN"
# A folder Claude Code has not trusted stops at the trust prompt, which no
# brief can answer: the first live launch sat there until the 90 s ran out
# (2026-09-29). Trust is inherited, so the cwd or any ancestor must carry
# hasTrustDialogAccepted in the user config.
trusted() {
  local d
  d=$(readlink -f "$CWD")
  while :; do
    [ "$(jq -r --arg d "$d" '.projects[$d].hasTrustDialogAccepted // false' "$CLAUDE_JSON" 2>/dev/null)" = true ] && return 0
    [ "$d" = / ] && return 1
    d=$(dirname "$d")
  done
}
if [ -r "$CLAUDE_JSON" ]; then
  trusted || die "Claude Code has not trusted $CWD or any folder above it, so the tab would stop at the trust prompt — nothing launched.
        Run claude there once and accept, or launch in a trusted folder."
else
  note "no Claude Code config at $CLAUDE_JSON — folder trust not checked"
fi
kitty_up || die "kitty remote control unavailable" 2
[ "$RC" = 1 ] && [ -z "$RC_NAME" ] && RC_NAME="$TITLE"

LAUNCHER="${CLAUDE_SESSION_ID:-${KITTY_WINDOW_ID:-}}"
LAUNCHER=$(printf '%s' "$LAUNCHER" | tr -d ' \t\r\n@')
[ -n "$LAUNCHER" ] || LAUNCHER=unknown

# The one-slot gate (#699), the same test as omp-tab.sh's slot_holders: a live
# row (id present, pid unchanged) whose launcher is not this one and which is
# not the caller's own window.
slot_holders() {
  [ -s "$STATE" ] || return 0
  local live_ids row_launcher
  live_ids=$(kitty @ ls 2>/dev/null | jq -r '.[].tabs[].windows[].id' 2>/dev/null | tr '\n' ' ')
  set -f
  while IFS= read -r row; do
    # shellcheck disable=SC2086: unquoted split is the parse; globbing off via set -f.
    set -- $row
    case "${3:-}" in @*) row_launcher=${3#@} ;; *) row_launcher=unknown ;; esac
    case " $live_ids " in *" ${1:-} "*) ;; *) continue ;; esac
    [ "$(win_pid "$1")" = "${2:-}" ] || continue
    [ "$row_launcher" = "$LAUNCHER" ] && continue
    [ -n "${KITTY_WINDOW_ID:-}" ] && [ "$1" = "$KITTY_WINDOW_ID" ] && continue
    printf '%s (launcher %s) ' "$1" "$row_launcher"
  done < "$STATE"
  set +f
}
BRIEF_REF="brief:$(basename "$BRIEF")"
if [ -z "$SLOT_OVERRIDE" ]; then
  holders=$(slot_holders)
  [ -z "$holders" ] || die "another seat holds the package-tab slot (#699) — nothing launched.
        live tab(s): $holders
        Re-run with --slot-override \"<reason>\" only when the overlap is deliberate."
  claim_out=$(claim_cli --check "$CWD" "$BRIEF_REF")
  if [ $? -eq 3 ]; then
    die "another live seat already holds $BRIEF_REF in $CWD — nothing launched.
        $(printf '%s' "$claim_out" | head -c 300)"
  fi
else
  note "slot override: $SLOT_OVERRIDE (another seat may hold the slot)"
fi

# Claude Code names the transcript dir after the resolved cwd with every
# character outside [A-Za-z0-9-] turned into '-' (scripts/lib/project-path.mjs
# in agent-config).
TDIR="$PROJECTS/$(readlink -f "$CWD" | sed 's/[^A-Za-z0-9-]/-/g')"
BEFORE=$(ls -1 "$TDIR" 2>/dev/null | grep '\.jsonl$' | tr '\n' ' ')

MSG="Read $BRIEF and carry it out in full. Run the commands rather than reasoning about them. Use absolute paths and 'git -C <dir> ...'."
[ -n "$OUT" ] && MSG="$MSG Write your findings to $OUT"

ARGS=("$CLAUDE_BIN" --model "$MODEL")
[ "$RC" = 1 ] && ARGS+=(--remote-control "$RC_NAME")
ARGS+=("$MSG")
WID=$(kitty @ launch --type=tab --tab-title "$TITLE" --cwd "$CWD" "${ARGS[@]}" 2>/dev/null)
case "$WID" in *[!0-9]*|"") die "kitty @ launch did not return a plain window id, got: '$WID'" ;; esac
WPID=$(win_pid "$WID")
[ -n "$WPID" ] || { printf 'WINDOW_ID=%s\n' "$WID"; die "window $WID exited immediately after launch — run $CLAUDE_BIN --model $MODEL by hand" 3; }
printf '%s %s @%s %s\n' "$WID" "$WPID" "$LAUNCHER" "$TITLE" >> "$STATE"
note "launched window $WID (pid $WPID) — $TITLE"
claim_cli --claim "$CWD" "$BRIEF_REF" --owner "kitty:$WID" --note "$TITLE" >/dev/null 2>&1 || true

close_it() {
  kitty @ close-window --match "id:$WID" 2>/dev/null || true
  sed -i "/^$WID /d" "$STATE" 2>/dev/null || true
  claim_cli --release-owner "kitty:$WID" >/dev/null 2>&1 || true
}

# An alias names a family: `opus` matches claude-opus-5-5. A full id matches
# itself, with or without a context suffix such as [1m].
model_ok() {
  case "$MODEL" in
    claude-*) [ "$1" = "${MODEL%%\[*}" ] ;;
    *) case "$1" in "claude-$MODEL"-*|"claude-$MODEL") return 0 ;; *) return 1 ;; esac ;;
  esac
}

SESSION=""; GOT=""; BRIDGE=0
for _ in $(seq 1 45); do
  sleep 2
  if [ -z "$(win_pid "$WID")" ]; then
    printf 'WINDOW_ID=%s\n' "$WID"
    sed -i "/^$WID /d" "$STATE" 2>/dev/null || true
    die "window $WID exited before it was proven started — run $CLAUDE_BIN --model $MODEL by hand to see why" 3
  fi
  if [ -z "$SESSION" ]; then
    for f in $(ls -1t "$TDIR" 2>/dev/null | grep '\.jsonl$'); do
      case " $BEFORE " in *" $f "*) continue ;; esac
      SESSION="$TDIR/$f"; break
    done
  fi
  [ -n "$SESSION" ] || continue
  # The first real model: Claude Code writes "<synthetic>" for its own notices.
  [ -n "$GOT" ] || GOT=$(grep -o '"model":"claude-[^"]*"' "$SESSION" 2>/dev/null | head -1 | sed 's/^"model":"//; s/"$//')
  [ "$RC" = 1 ] && grep -q '"type":"bridge-session"' "$SESSION" 2>/dev/null && BRIDGE=1
  [ -n "$GOT" ] && { [ "$RC" = 0 ] || [ "$BRIDGE" = 1 ]; } && break
done

printf 'WINDOW_ID=%s\n' "$WID"
if [ -n "$GOT" ] && ! model_ok "$GOT"; then
  close_it
  die "session $SESSION is on model $GOT but was launched as $MODEL — the window was closed at once." 3
fi
if [ -n "$GOT" ] && { [ "$RC" = 0 ] || [ "$BRIDGE" = 1 ]; }; then
  note "confirmed: session $(basename "$SESSION" .jsonl) on $GOT${RC_NAME:+, Remote Control \"$RC_NAME\"}"
  printf 'SESSION=%s\n' "$SESSION"
  [ -n "$OUT" ] && printf 'OUT=%s\n' "$OUT"
  printf 'CLOSE_WITH=%s --close %s\n' "$0" "$WID"
  exit 0
fi
note "not proven within 90 s (session=${SESSION:-none} model=${GOT:-none}$([ "$RC" = 1 ] && printf ' bridge=%s' "$BRIDGE")) — go look at window $WID before assuming it is working"
exit 3
