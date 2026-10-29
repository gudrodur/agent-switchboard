#!/usr/bin/env bash
# Launch Claude Code in its OWN titled kitty tab with a brief, and PROVE it started on the asked model.
#
# --help prints everything between HELP-BEGIN and HELP-END below, never from a second copy.
# HELP-BEGIN
# Usage:
#   claude-tab.sh --title "claude: <what this is>" --brief /abs/brief.md \
#                 --model opus|sonnet|haiku|fable|<full model id> [--rc [NAME]]
#                 [--out /abs/out.md] [--cwd /abs/repo] [--slot-override "<reason>"]
#                 [--role NAME]
#   claude-tab.sh --seat --title "claude: <name>" --model ... [--rc [NAME]]
#                 [--brief /abs/brief.md] [--cwd /abs/repo]
#   claude-tab.sh --resume <session-id> --title "claude: <name>" --model ...
#                 [--rc [NAME]] [--brief /abs/brief.md]
#   claude-tab.sh --list | --close <window-id>       (lib/tab-ledger.sh, shared with opencode-tab.sh)
#   claude-tab.sh --help | -h
#
#   --rc [NAME]  start the session with Remote Control on, named NAME (default:
#                the --title), and require the bridge-session row as proof
#   --role NAME  start the session with AGENT_SEAT_ROLE=NAME in its environment:
#                its first prompt claims the seat role (mail for `--to role:NAME`
#                then follows this session; see agent-send.mjs --claim-role).
#                The session is also started with --name <title>, so the kitty
#                window title is the tab title, not the first prompt.
#   --seat       an overseer seat, not a package tab: no state row, so it never
#                holds the one-slot gate, no slot check and no brief claim, and
#                --brief is optional (without one a fixed greeting starts the
#                session, so the start can still be proven). For a tab that
#                lives all day, such as the login seat (claude-login-seats.sh).
#   --resume ID  reopen an existing session (claude --resume ID) as a seat. The
#                cwd is the session's own, read from its transcript (a --cwd
#                that differs is refused); a session live in another process
#                (its registry pid alive with the same procStart) is refused.
#                Without --brief a fixed greeting says the background work is
#                gone. Proof: an assistant row on --model written AFTER the
#                launch and, with --rc, the new process's registry record
#                holding a bridgeSessionId. claude-resume-set.sh replays a
#                whole snapshot of sessions through this.
#
# --cwd must be a folder Claude Code trusts, itself or through a folder above
# it; an untrusted one is refused (exit 1). A throwaway folder under /tmp is
# not trusted: make it under a trusted tree, e.g. mktemp -d ~/Development/.x-XXXX.
# --dangerously-skip-permissions does not skip the trust prompt (2026-09-29).
#
# Exit codes, the same table as opencode-tab.sh:
#   0  launched AND proven: a new Claude Code session file in --cwd whose first
#      assistant turn ran on --model (and, with --rc, a bridge-session row);
#      with --resume, the rows past the pre-launch offset, as above
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
# `message.model` on each assistant row, and a `bridge-session` row
# when Remote Control is on. A file that was not there before the launch is
# the tab's; nothing is read off the screen.
#
# Shared with opencode-tab.sh through lib/tab-ledger.sh, on purpose: the state
# file and its row format (`WID PID @LAUNCHER TITLE`), so `--list` shows
# these tabs and `--close` refuses a window none of them launched; the
# one-slot gate (#699); and the `brief:<basename>` claim in agent-config's
# task-claim.mjs.
#
# Test seams: CLAUDE_TAB_BIN (the command the tab execs), CLAUDE_TAB_PROJECTS
# (the transcripts root), CLAUDE_TAB_CONFIG (the .claude.json holding folder
# trust), SWITCHBOARD_TASK_CLAIM (lib/tab-ledger.sh).

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

die()  { printf '%s\n' "claude-tab: $1" >&2; exit "${2:-1}"; }
note() { printf '%s\n' "claude-tab: $*" >&2; }
# STATE, kitty_up, config_root, claim_cli, win_pid, tab_ledger_list/close.
. "$HERE/../lib/tab-ledger.sh"
CLAUDE_BIN="${CLAUDE_TAB_BIN:-claude}"
PROJECTS="${CLAUDE_TAB_PROJECTS:-${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects}"
CLAUDE_JSON="${CLAUDE_TAB_CONFIG:-${CLAUDE_CONFIG_DIR:-$HOME}/.claude.json}"

case "${1:-}" in
  --help|-h) sed -n '/^# HELP-BEGIN$/,/^# HELP-END$/p' "$0" | sed -e '1d;$d' -e 's/^# \?//'; exit 0 ;;
  # lib/tab-ledger.sh owns --list and --close, including the refusal of a
  # window no launcher recorded and the release of the window's brief claim.
  --list) tab_ledger_list; exit $? ;;
  --close) tab_ledger_close "${2:-}"; exit $? ;;
esac

TITLE=""; BRIEF=""; OUT=""; MODEL=""; CWD="$PWD"; CWD_SET=0; SLOT_OVERRIDE=""; RC=0; RC_NAME=""; SEAT=0; RESUME=""; ROLE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --title) TITLE="${2:-}"; shift 2 ;;
    --brief) BRIEF="${2:-}"; shift 2 ;;
    --out) OUT="${2:-}"; shift 2 ;;
    --model|-m) MODEL="${2:-}"; shift 2 ;;
    --cwd) CWD="${2:-}"; CWD_SET=1; shift 2 ;;
    --resume) RESUME="${2:-}"; shift 2 ;;
    --role) ROLE="${2:-}"; shift 2 ;;
    --slot-override) SLOT_OVERRIDE="${2:-}"; shift 2 ;;
    --seat) SEAT=1; shift ;;
    --rc)
      RC=1; shift
      case "${1:-}" in ""|--*) ;; *) RC_NAME="$1"; shift ;; esac ;;
    *) die "unknown argument: $1 (see --help)" ;;
  esac
done

[ -n "$TITLE" ] || die "--title is required"
if [ -n "$ROLE" ] && ! printf '%s' "$ROLE" | /usr/bin/grep -Eq '^[a-z0-9][a-z0-9-]{0,63}$'; then
  die "--role must match [a-z0-9][a-z0-9-]{0,63}, got: '$ROLE'"
fi
[ -n "$MODEL" ] || die "--model is required: a tab on the account default is the run nobody chose"
case "$MODEL" in
  opus|sonnet|haiku|fable|claude-*) ;;
  *) die "--model takes opus, sonnet, haiku, fable or a full claude-* id, got: $MODEL" ;;
esac
if [ -n "$RESUME" ]; then
  case "$RESUME" in
    *[!A-Za-z0-9-]*|"") die "--resume takes a session id (letters, digits and '-'), got: $RESUME" ;;
  esac
  # A resumed session reopens a tab that was already there: it is a seat, so
  # it neither checks nor holds the package-tab slot.
  SEAT=1
fi
[ -n "$BRIEF" ] || [ "$SEAT" = 1 ] || die "--brief is required"
if [ -n "$BRIEF" ]; then
  case "$BRIEF" in /*) ;; *) die "--brief must be absolute (it resolves against the tab's cwd): $BRIEF" ;; esac
  [ -r "$BRIEF" ] || die "--brief not readable: $BRIEF"
  # The shared brief lint (lib/brief-lint.sh), without a per-line byte cap: the brief goes in
  # as the initial prompt here, and Claude Code does not cut a line.
  . "$HERE/../lib/brief-lint.sh"
  PLACEHOLDERS=$(brief_placeholder_lines "$BRIEF")
  [ -z "$PLACEHOLDERS" ] || die "brief line(s) $PLACEHOLDERS carry a bare #N placeholder outside backticks: a tab copies it
        into a commit subject or PR body. Name the real issue number, or quote the example in backticks. Nothing launched."
  TRAILERS=$(brief_trailer_lines "$BRIEF")
  [ -z "$TRAILERS" ] || die "brief line(s) $TRAILERS ask for a Co-Authored-By trailer: the commit hooks refuse AI authorship
        trailers, so the tab's commit fails. Say \"Never add a Co-Authored-By line\" instead. Nothing launched."
fi
. "$HERE/../lib/claude-session.sh"
RESUME_FILE=""
if [ -n "$RESUME" ]; then
  RESUME_FILE=$(ls -1 "$PROJECTS"/*/"$RESUME.jsonl" 2>/dev/null | head -1)
  [ -n "$RESUME_FILE" ] || die "no transcript for session $RESUME under $PROJECTS — nothing launched"
  # The session's own cwd, off its first row that names one; grep, not jq,
  # because a long session's transcript runs to tens of MB.
  RCWD=$(grep -m1 -o '"cwd":"[^"]*"' "$RESUME_FILE" | sed 's/^"cwd":"//; s/"$//')
  [ -n "$RCWD" ] || die "transcript $RESUME_FILE names no cwd — nothing launched"
  if [ "$CWD_SET" = 1 ] && [ "$(readlink -f "$CWD")" != "$(readlink -f "$RCWD")" ]; then
    die "session $RESUME ran in $RCWD, not in $CWD — nothing launched"
  fi
  CWD=$RCWD
  # Two processes on one session both append to its transcript.
  if LIVE=$(claude_live_record_of "$RESUME"); then
    die "session $RESUME is live in pid $(printf '%s' "$LIVE" | jq -r .pid) — close that one first; nothing launched"
  fi
fi
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
        Run claude there once and accept, or launch in a trusted folder (a throwaway one: mktemp -d under a trusted tree)."
else
  note "no Claude Code config at $CLAUDE_JSON — folder trust not checked"
fi
kitty_up || die "kitty remote control unavailable.$KITTY_DIAG" 2
[ "$RC" = 1 ] && [ -z "$RC_NAME" ] && RC_NAME="$TITLE"

LAUNCHER="${CLAUDE_SESSION_ID:-${KITTY_WINDOW_ID:-}}"
LAUNCHER=$(printf '%s' "$LAUNCHER" | tr -d ' \t\r\n@')
[ -n "$LAUNCHER" ] || LAUNCHER=unknown

# The one-slot gate (#699), the same test as opencode-tab.sh's: a live
# row (id present, pid unchanged) whose launcher is not this one and which is
# not the caller's own window.
# True when PID is this script or one of its ancestors: the seat that runs
# this launcher inside a tab another seat launched sees that tab's row with the
# other seat as launcher (agent-config#805 row 4). Walks /proc ppid links.
is_ancestor() { # $1 = pid
  local p=$$ n=0
  while [ -n "$p" ] && [ "$p" != 0 ] && [ $n -lt 64 ]; do
    [ "$p" = "$1" ] && return 0
    p=$(awk '{print $4}' "/proc/$p/stat" 2>/dev/null)
    n=$((n + 1))
  done
  return 1
}
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
    is_ancestor "${2:-}" && continue
    printf '%s (launcher %s) ' "$1" "$row_launcher"
  done < "$STATE"
  set +f
}
BRIEF_REF="brief:$(basename "${BRIEF:-none}")"
if [ "$SEAT" = 1 ]; then
  : # a seat is not a package tab: it neither checks nor holds the slot
elif [ -z "$SLOT_OVERRIDE" ]; then
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
# A resumed session appends to the transcript it already has, so its proof is
# read only past the byte offset the file had before the launch.
OFFSET=0
[ -n "$RESUME_FILE" ] && OFFSET=$(stat -c %s "$RESUME_FILE")

if [ -n "$BRIEF" ]; then
  MSG="Read $BRIEF and carry it out in full. Run the commands rather than reasoning about them. Use absolute paths and 'git -C <dir> ...'."
  [ -n "$OUT" ] && MSG="$MSG Write your findings to $OUT"
elif [ -n "$RESUME" ]; then
  MSG="This session was resumed by claude-tab.sh --resume${RC_NAME:+, with Remote Control \"$RC_NAME\"}. Every background command, watcher and wait you had started is gone. Check what is still true before going on, then reply with one line on where you stand."
else
  MSG="This tab was opened as an overseer seat by claude-tab.sh --seat${RC_NAME:+, with Remote Control \"$RC_NAME\"}. Reply with one line saying you are ready, then wait for instructions."
fi

ARGS=("$CLAUDE_BIN" --model "$MODEL" --name "$TITLE")
[ "$RC" = 1 ] && ARGS+=(--remote-control "$RC_NAME")
[ -n "$RESUME" ] && ARGS+=(--resume "$RESUME")
ARGS+=("$MSG")
ENV_ARGS=()
[ -n "$ROLE" ] && ENV_ARGS=(--env "AGENT_SEAT_ROLE=$ROLE")
WID=$(kitty @ launch --type=tab --tab-title "$TITLE" --cwd "$CWD" "${ENV_ARGS[@]}" "${ARGS[@]}" 2>/dev/null)
case "$WID" in *[!0-9]*|"") die "kitty @ launch did not return a plain window id, got: '$WID'" ;; esac
WPID=$(win_pid "$WID")
[ -n "$WPID" ] || { printf 'WINDOW_ID=%s\n' "$WID"; die "window $WID exited immediately after launch — run $CLAUDE_BIN --model $MODEL by hand" 3; }
if [ "$SEAT" = 0 ]; then
  printf '%s %s @%s %s\n' "$WID" "$WPID" "$LAUNCHER" "$TITLE" >> "$STATE"
  claim_cli --claim "$CWD" "$BRIEF_REF" --owner "kitty:$WID" --note "$TITLE" >/dev/null 2>&1 || true
fi
note "launched window $WID (pid $WPID) — $TITLE"

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

SESSION="$RESUME_FILE"; GOT=""; BRIDGE=0
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
  # The first assistant turn's model (lib/claude-session.sh says why no grep).
  [ -n "$GOT" ] || GOT=$(tail -c +"$((OFFSET + 1))" "$SESSION" 2>/dev/null | claude_assistant_models | head -1)
  if [ "$RC" = 1 ] && [ "$BRIDGE" = 0 ]; then
    if [ -n "$RESUME" ]; then
      # The transcript's bridge-session row carries no timestamp, so an old one
      # proves nothing; the live registry record of the new process does.
      claude_live_record_of "$RESUME" | jq -e '.bridgeSessionId | strings | length > 0' >/dev/null 2>&1 && BRIDGE=1
    else
      grep -q '"type":"bridge-session"' "$SESSION" 2>/dev/null && BRIDGE=1
    fi
  fi
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
  # --close refuses a window with no state row, so a seat names kitty's own close.
  if [ "$SEAT" = 1 ]; then printf 'CLOSE_WITH=kitty @ close-window --match id:%s\n' "$WID"
  else printf 'CLOSE_WITH=%s --close %s\n' "$0" "$WID"; fi
  exit 0
fi
note "not proven within 90 s (session=${SESSION:-none} model=${GOT:-none}$([ "$RC" = 1 ] && printf ' bridge=%s' "$BRIDGE")) — go look at window $WID before assuming it is working"
exit 3
