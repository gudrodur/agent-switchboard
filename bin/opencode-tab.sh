#!/usr/bin/env bash
# Launch the opencode TUI in its OWN titled kitty tab with a brief, and PROVE it started on the asked model.
#
# --help prints everything between HELP-BEGIN and HELP-END below, never from a second copy.
# HELP-BEGIN
# Usage:
#   opencode-tab.sh --title "opencode: <what this is>" --brief /abs/brief.md \
#                   --model PROVIDER/NAME [--out /abs/out.md] [--cwd /abs/repo]
#                   [--slot-override "<reason>"]
#   opencode-tab.sh --list | --close <window-id>     (omp-tab.sh's, on the same state file;
#                                                     --close also drops that window's beacon)
#   opencode-tab.sh --help | -h
#
# Exit codes, the same table as omp-tab.sh:
#   0  launched AND proven: presence beacon for the window, a new opencode
#      session in --cwd, and that session's model is --model
#   1  precondition failed (bad args, relative path, missing file, slot held)
#   2  kitty remote control unavailable — CALLER MUST FALL BACK TO HEADLESS AND SAY SO
#   3  launched but not proven (window id still printed; a wrong model closes it)
# HELP-END
#
# The smaller sibling of omp-tab.sh (agent-config#973). omp-tab.sh is 1000+
# lines because omp needs a provider table, a key step, a readiness poll and a
# send through kitty-send.sh; opencode needs none of them:
#
#   * The brief goes in as `--prompt`, so no keystrokes are sent at all, and
#     send-text's two silent failures (no matching window, no \r) cannot happen.
#   * The model is proven from opencode's own store: the `session` row it
#     writes for the new tab names its directory and its model, so the proof is
#     a row, not a status bar read off the screen.
#   * The Cloudflare MCP tokens come from agent-config's opencode-launch.sh,
#     which this execs rather than the bare binary.
#
# Shared with omp-tab.sh, on purpose: the state file and its row format
# (`WID PID @LAUNCHER TITLE`), so `omp-tab.sh --list` shows these tabs and
# `--close` refuses a window neither launched; the one-slot gate (#699), since
# a package tab is a package tab whichever agent runs in it; and the
# `brief:<basename>` claim in agent-config's task-claim.mjs.
#
# Test seams: OPENCODE_TAB_LAUNCH (the command the tab execs),
# OPENCODE_TAB_DB (the opencode store), OPENCODE_TAB_PRESENCE (a command that
# prints {"beacons":[...]} in place of the presence lib), OMP_TAB_TASK_CLAIM
# (as omp-tab.sh).

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE="${XDG_RUNTIME_DIR:-/tmp}/omp-tab-launched.$(id -u)"

die()  { printf '%s\n' "opencode-tab: $1" >&2; exit "${2:-1}"; }
note() { printf '%s\n' "opencode-tab: $*" >&2; }
kitty_up() { kitty @ ls >/dev/null 2>&1; }

config_root() {
  if [ -n "${AGENT_CONFIG_HOME:-}" ]; then printf '%s' "$AGENT_CONFIG_HOME"
  elif [ -d "$HOME/agent-config" ]; then printf '%s' "$HOME/agent-config"
  else printf '%s' "$HOME/.claude"; fi
}
LAUNCH="${OPENCODE_TAB_LAUNCH:-$(config_root)/scripts/opencode-launch.sh}"
DB="${OPENCODE_TAB_DB:-${XDG_DATA_HOME:-$HOME/.local/share}/opencode/opencode.db}"
PRESENCE_LIB="$HERE/../lib/presence.mjs"
# The beacons, as {"beacons":[...]}, from this checkout's presence lib: the
# same store the --close release writes to, whichever AGENT_SWITCHBOARD_DB the
# caller pinned (agent-config's delegator pins its own).
presence_json() {
  if [ -n "${OPENCODE_TAB_PRESENCE:-}" ]; then "$OPENCODE_TAB_PRESENCE"; return; fi
  node --input-type=module -e '
    const { readAllPresence } = await import(process.argv[1]);
    console.log(JSON.stringify({ beacons: readAllPresence() }));
  ' "$PRESENCE_LIB"
}
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
  --list) exec "$HERE/omp-tab.sh" "$@" ;;
  --close)
    # omp-tab.sh owns the refusal (a window it did not launch, a reused id).
    # After a close it made, drop the beacons naming that window: opencode's
    # plugin never sees the SIGHUP a closed window sends (its exit and signal
    # handlers did not run, measured 2026-09-27), so the beacon would
    # otherwise outlive the tab by the 20-minute presence TTL. A window
    # closed by hand needs no beacon release: the plugin records its pid on
    # the beacon and readers skip a dead one (lib/presence.mjs,
    # agent-config#979). Its brief claim is released by omp-tab.sh, on --close
    # or on the --list prune that finds it gone (agent-config#994).
    "$HERE/omp-tab.sh" "$@" || exit $?
    node --input-type=module -e '
      const { readAllPresence, releasePresence } = await import(process.argv[1]);
      const w = Number(process.argv[2]);
      for (const b of readAllPresence()) if (b.windowId === w && b.sessionId) releasePresence({ sessionId: b.sessionId });
    ' "$PRESENCE_LIB" "${2:-}" 2>/dev/null || note "beacon release for window ${2:-} failed; it ages out in 20 min"
    exit 0 ;;
esac

TITLE=""; BRIEF=""; OUT=""; MODEL=""; CWD="$PWD"; SLOT_OVERRIDE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --title) TITLE="${2:-}"; shift 2 ;;
    --brief) BRIEF="${2:-}"; shift 2 ;;
    --out) OUT="${2:-}"; shift 2 ;;
    --model|-m) MODEL="${2:-}"; shift 2 ;;
    --cwd) CWD="${2:-}"; shift 2 ;;
    --slot-override) SLOT_OVERRIDE="${2:-}"; shift 2 ;;
    *) die "unknown argument: $1 (see --help)" ;;
  esac
done

[ -n "$TITLE" ] || die "--title is required"
[ -n "$MODEL" ] || die "--model is required: a tab on the account default is the run nobody chose"
case "$MODEL" in */*) ;; *) die "--model takes PROVIDER/NAME, got: $MODEL" ;; esac
[ -n "$BRIEF" ] || die "--brief is required"
case "$BRIEF" in /*) ;; *) die "--brief must be absolute (it resolves against the tab's cwd): $BRIEF" ;; esac
[ -r "$BRIEF" ] || die "--brief not readable: $BRIEF"
case "$CWD" in /*) ;; *) die "--cwd must be absolute: $CWD" ;; esac
[ -d "$CWD" ] || die "--cwd is not a directory: $CWD"
if [ -n "$OUT" ]; then case "$OUT" in /*) ;; *) die "--out must be absolute: $OUT" ;; esac; fi
[ -x "$LAUNCH" ] || die "launcher not executable: $LAUNCH"
[ -r "$DB" ] || note "no opencode store at $DB yet — opencode creates it on first start"
kitty_up || die "kitty remote control unavailable" 2

LAUNCHER="${CLAUDE_SESSION_ID:-${KITTY_WINDOW_ID:-}}"
LAUNCHER=$(printf '%s' "$LAUNCHER" | tr -d ' \t\r\n@')
[ -n "$LAUNCHER" ] || LAUNCHER=unknown

# The one-slot gate (#699), the same test as omp-tab.sh's slot_holders: a live
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

MSG="Read $BRIEF and carry it out in full. Run the commands rather than reasoning about them. Use absolute paths and 'git -C <dir> ...'."
[ -n "$OUT" ] && MSG="$MSG Write your findings to $OUT"

START_MS=$(( $(date +%s) * 1000 ))
WID=$(kitty @ launch --type=tab --tab-title "$TITLE" --cwd "$CWD" \
        "$LAUNCH" --model "$MODEL" --prompt "$MSG" 2>/dev/null)
case "$WID" in *[!0-9]*|"") die "kitty @ launch did not return a plain window id, got: '$WID'" ;; esac
WPID=$(win_pid "$WID")
[ -n "$WPID" ] || { printf 'WINDOW_ID=%s\n' "$WID"; die "window $WID exited immediately after launch — run $LAUNCH --model $MODEL by hand" 3; }
printf '%s %s @%s %s\n' "$WID" "$WPID" "$LAUNCHER" "$TITLE" >> "$STATE"
note "launched window $WID (pid $WPID) — $TITLE"
claim_cli --claim "$CWD" "$BRIEF_REF" --owner "kitty:$WID" --note "$TITLE" >/dev/null 2>&1 || true

close_it() {
  kitty @ close-window --match "id:$WID" 2>/dev/null || true
  sed -i "/^$WID /d" "$STATE" 2>/dev/null || true
  claim_cli --release-owner "kitty:$WID" >/dev/null 2>&1 || true
}

# The newest top-level session opencode created in $CWD since the launch, as
# `id<TAB>provider/model`. Read-only; the store is WAL, so this never blocks it.
new_session() {
  [ -r "$DB" ] || return 0
  node - "$DB" "$CWD" "$START_MS" <<'JS' 2>/dev/null
process.emitWarning = () => {};
const { DatabaseSync } = require('node:sqlite');
const [db, cwd, since] = process.argv.slice(2);
const r = new DatabaseSync(db, { readOnly: true })
  .prepare('SELECT id, model FROM session WHERE directory = ? AND parent_id IS NULL AND time_created >= ? ORDER BY time_created DESC LIMIT 1')
  .get(cwd, Number(since) - 2000);
if (r) { let m = {}; try { m = JSON.parse(r.model || '{}'); } catch {} console.log(`${r.id}\t${m.providerID ?? '?'}/${m.id ?? '?'}`); }
JS
}

beacon=0; SESSION=""; GOT=""
for _ in $(seq 1 45); do
  sleep 2
  if [ -z "$(win_pid "$WID")" ]; then
    printf 'WINDOW_ID=%s\n' "$WID"
    sed -i "/^$WID /d" "$STATE" 2>/dev/null || true
    die "window $WID exited before it was proven started — run $LAUNCH --model $MODEL by hand to see why" 3
  fi
  if [ "$beacon" = 0 ] && presence_json 2>/dev/null | jq -e --argjson w "$WID" '.beacons[] | select(.windowId == $w)' >/dev/null 2>&1; then
    beacon=1
  fi
  line=$(new_session)
  if [ -n "$line" ]; then SESSION=${line%%$'\t'*}; GOT=${line#*$'\t'}; fi
  [ "$beacon" = 1 ] && [ -n "$SESSION" ] && break
done

printf 'WINDOW_ID=%s\n' "$WID"
if [ -n "$SESSION" ] && [ "$GOT" != "$MODEL" ]; then
  close_it
  die "session $SESSION is on model $GOT but was launched as $MODEL — the window was closed at once." 3
fi
if [ "$beacon" = 1 ] && [ -n "$SESSION" ]; then
  note "confirmed: presence beacon for window $WID, session $SESSION on $GOT"
  printf 'SESSION=%s\n' "$SESSION"
  [ -n "$OUT" ] && printf 'OUT=%s\n' "$OUT"
  printf 'CLOSE_WITH=%s --close %s\n' "$0" "$WID"
  exit 0
fi
note "not proven within 90 s (beacon=$beacon session=${SESSION:-none}) — go look at window $WID before assuming it is working"
exit 3
