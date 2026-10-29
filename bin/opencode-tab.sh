#!/usr/bin/env bash
# Launch the opencode TUI in its OWN titled kitty tab with a brief, and PROVE it started on the asked model.
#
# --help prints everything between HELP-BEGIN and HELP-END below, never from a second copy.
# HELP-BEGIN
# Usage:
#   opencode-tab.sh --title "opencode: <what this is>" --brief /abs/brief.md \
#                   --model PROVIDER/NAME [--out /abs/out.md] [--cwd /abs/repo]
#                   [--slot-override "<reason>"] [--server URL] [--no-probe]
#   opencode-tab.sh --list | --close <window-id>     (lib/tab-ledger.sh, shared with claude-tab.sh;
#                                                     --close also drops that window's beacon)
#   opencode-tab.sh --help | -h
#
# Options beyond the required ones:
#   --server URL   open the tab on that opencode server (http or https) instead
#                  of a private one (`--standalone`, the default), so a client
#                  attached to the shared background service, such as the phone
#                  app, can see the session. The URL has no default here: say it.
#   --no-probe     skip the pre-launch probe: one headless `opencode run` on
#                  --model that must answer, so a provider that returns 402 or
#                  hangs is refused before a tab opens (OPENCODE_TAB_PROBE_TIMEOUT
#                  seconds, default 60). It costs a few tokens and a few seconds.
#
# Exit codes, the same table as claude-tab.sh:
#   0  launched AND proven: presence beacon for the window, a new opencode
#      session in --cwd, and that session's model is --model
#   1  precondition failed (bad args, relative path, missing file, slot held,
#      the model's probe failed or hung)
#   2  kitty remote control unavailable — CALLER MUST FALL BACK TO HEADLESS AND SAY SO
#   3  launched but not proven (window id still printed; a wrong model closes it)
# HELP-END
#
# opencode needs no provider table, key step, readiness poll or send through
# kitty-send.sh (agent-config#973):
#
#   * The brief goes in as `--prompt`, so no keystrokes are sent at all, and
#     send-text's two silent failures (no matching window, no \r) cannot happen.
#   * The model is proven from opencode's own store: the `session` row it
#     writes for the new tab names its directory and its model, so the proof is
#     a row, not a status bar read off the screen.
#   * The Cloudflare MCP tokens come from agent-config's opencode-launch.sh,
#     which this execs rather than the bare binary.
#
# Shared with claude-tab.sh through lib/tab-ledger.sh, on purpose: the state
# file and its row format (`WID PID @LAUNCHER TITLE`), so `--list` shows both
# launchers' tabs and `--close` refuses a window neither launched; the
# one-slot gate (#699), since a package tab is a package tab whichever agent
# runs in it; and the `brief:<basename>` claim in agent-config's task-claim.mjs.
#
# The probe runs in a throwaway directory, so the session row it leaves in
# opencode's store names that directory and can never be taken for the tab's
# session; it also runs before the launch timestamp is taken.
#
# Test seams: OPENCODE_TAB_LAUNCH (the command the tab execs),
# OPENCODE_TAB_DB (the opencode store), OPENCODE_TAB_PRESENCE (a command that
# prints {"beacons":[...]} in place of the presence lib), SWITCHBOARD_TASK_CLAIM
# (lib/tab-ledger.sh).

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

die()  { printf '%s\n' "opencode-tab: $1" >&2; exit "${2:-1}"; }
note() { printf '%s\n' "opencode-tab: $*" >&2; }
# STATE, kitty_up, config_root, claim_cli, win_pid, tab_ledger_list/close.
. "$HERE/../lib/tab-ledger.sh"
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
PROBE_TIMEOUT="${OPENCODE_TAB_PROBE_TIMEOUT:-60}"

case "${1:-}" in
  --help|-h) sed -n '/^# HELP-BEGIN$/,/^# HELP-END$/p' "$0" | sed -e '1d;$d' -e 's/^# \?//'; exit 0 ;;
  --list) tab_ledger_list; exit $? ;;
  --close)
    # tab_ledger_close owns the refusal (a window no launcher recorded, a reused id).
    # After a close it made, drop the beacons naming that window: opencode's
    # plugin never sees the SIGHUP a closed window sends (its exit and signal
    # handlers did not run, measured 2026-09-27), so the beacon would
    # otherwise outlive the tab by the 20-minute presence TTL. A window
    # closed by hand needs no beacon release: the plugin records its pid on
    # the beacon and readers skip a dead one (lib/presence.mjs,
    # agent-config#979). Its brief claim is released by tab_ledger_close, on --close
    # or on the --list prune that finds it gone (agent-config#994).
    ( tab_ledger_close "${2:-}" ) || exit $?
    node --input-type=module -e '
      const { readAllPresence, releasePresence } = await import(process.argv[1]);
      const w = Number(process.argv[2]);
      for (const b of readAllPresence()) if (b.windowId === w && b.sessionId) releasePresence({ sessionId: b.sessionId });
    ' "$PRESENCE_LIB" "${2:-}" 2>/dev/null || note "beacon release for window ${2:-} failed; it ages out in 20 min"
    exit 0 ;;
esac

TITLE=""; BRIEF=""; OUT=""; MODEL=""; CWD="$PWD"; SLOT_OVERRIDE=""; SERVER=""; PROBE=1
while [ $# -gt 0 ]; do
  case "$1" in
    --title) TITLE="${2:-}"; shift 2 ;;
    --brief) BRIEF="${2:-}"; shift 2 ;;
    --out) OUT="${2:-}"; shift 2 ;;
    --model|-m) MODEL="${2:-}"; shift 2 ;;
    --cwd) CWD="${2:-}"; shift 2 ;;
    --server) SERVER="${2:-}"; shift 2 ;;
    --no-probe) PROBE=0; shift ;;
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
# The shared brief lint (lib/brief-lint.sh), without a per-line byte cap: the brief goes in
# as --prompt here, and opencode does not cut a line.
. "$HERE/../lib/brief-lint.sh"
PLACEHOLDERS=$(brief_placeholder_lines "$BRIEF")
[ -z "$PLACEHOLDERS" ] || die "brief line(s) $PLACEHOLDERS carry a bare #N placeholder outside backticks: a tab copies it
        into a commit subject or PR body. Name the real issue number, or quote the example in backticks. Nothing launched."
TRAILERS=$(brief_trailer_lines "$BRIEF")
[ -z "$TRAILERS" ] || die "brief line(s) $TRAILERS ask for a Co-Authored-By trailer: the commit hooks refuse AI authorship
        trailers, so the tab's commit fails. Say \"Never add a Co-Authored-By line\" instead. Nothing launched."
case "$CWD" in /*) ;; *) die "--cwd must be absolute: $CWD" ;; esac
[ -d "$CWD" ] || die "--cwd is not a directory: $CWD"
if [ -n "$OUT" ]; then case "$OUT" in /*) ;; *) die "--out must be absolute: $OUT" ;; esac; fi
case "$SERVER" in ""|http://?*|https://?*) ;; *) die "--server takes a http(s) URL, got: $SERVER" ;; esac
[ -x "$LAUNCH" ] || die "launcher not executable: $LAUNCH"
[ -r "$DB" ] || note "no opencode store at $DB yet — opencode creates it on first start"
kitty_up || die "kitty remote control unavailable.$KITTY_DIAG" 2

LAUNCHER="${CLAUDE_SESSION_ID:-${KITTY_WINDOW_ID:-}}"
LAUNCHER=$(printf '%s' "$LAUNCHER" | tr -d ' \t\r\n@')
[ -n "$LAUNCHER" ] || LAUNCHER=unknown

# The one-slot gate (#699), the same test as claude-tab.sh's: a live
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

# The probe: one headless run on the asked model, before any tab opens. A
# provider with no credit answers 402 on the first turn and the tab would die
# there. The prompt is a positional argument and stdin is closed, as the
# headless guard requires. It runs in a throwaway directory (its session row
# names that directory, not $CWD) and always --standalone: it must not touch
# the shared service the tab may attach to. Exit 0 with a payment error in the
# last lines still fails, since a run can report a provider error and exit 0.
probe_model() {
  local probe_cwd out rc
  probe_cwd="$(mktemp -d "${TMPDIR:-/tmp}/opencode-tab-probe-XXXXXX")"
  out="$(cd "$probe_cwd" && timeout "$PROBE_TIMEOUT" "$LAUNCH" run --standalone -m "$MODEL" \
           "Reply with exactly the word OK and nothing else." </dev/null 2>&1)"; rc=$?
  rm -rf "$probe_cwd"
  if [ "$rc" -eq 124 ]; then
    die "probe of $MODEL hung for $PROBE_TIMEOUT s; nothing launched. A hang is the environment, not the provider. Re-run; if it repeats, run '$LAUNCH run --standalone -m $MODEL' by hand with stdin closed (< /dev/null)."
  fi
  if [ "$rc" -ne 0 ]; then
    die "probe of $MODEL failed: opencode exited $rc: $(printf '%s\n' "$out" | grep -v '^[[:space:]]*$' | tail -1); nothing launched. Use --no-probe to skip the probe."
  fi
  if printf '%s\n' "$out" | tail -5 | grep -qiE '\b402\b|payment required|insufficient|credit'; then
    die "probe of $MODEL failed: opencode exited 0 but reported: $(printf '%s\n' "$out" | grep -v '^[[:space:]]*$' | tail -1); nothing launched. Use --no-probe to skip the probe."
  fi
}
[ "$PROBE" = 1 ] && probe_model

if [ -n "$SERVER" ]; then ATTACH=(--server "$SERVER"); else ATTACH=(--standalone); fi
START_MS=$(( $(date +%s) * 1000 ))
WID=$(kitty @ launch --type=tab --tab-title "$TITLE" --cwd "$CWD" \
        "$LAUNCH" mini "${ATTACH[@]}" --model "$MODEL" --prompt "$MSG" 2>/dev/null)
case "$WID" in *[!0-9]*|"") die "kitty @ launch did not return a plain window id, got: '$WID'" ;; esac
WPID=$(win_pid "$WID")
[ -n "$WPID" ] || { printf 'WINDOW_ID=%s\n' "$WID"; die "window $WID exited immediately after launch — run $LAUNCH mini ${ATTACH[*]} --model $MODEL by hand" 3; }
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
# opencode v2.0.29+ writes to `session_v2` (#47); fall back to `session` when
# `session_v2` is absent or holds no newer matching row.
new_session() {
  [ -r "$DB" ] || return 0
  node - "$DB" "$CWD" "$START_MS" <<'JS' 2>/dev/null
process.emitWarning = () => {};
const { DatabaseSync } = require('node:sqlite');
const [db, cwd, since] = process.argv.slice(2);
const d = new DatabaseSync(db, { readOnly: true });
const tables = d
  .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('session_v2','session') ORDER BY CASE name WHEN 'session_v2' THEN 0 ELSE 1 END")
  .all()
  .map((row) => row.name);
let r = null;
for (const t of tables) {
  r = d
    .prepare(`SELECT id, model FROM ${t} WHERE directory = ? AND parent_id IS NULL AND time_created >= ? ORDER BY time_created DESC LIMIT 1`)
    .get(cwd, Number(since) - 2000);
  if (r) break;
}
if (r) { let m = {}; try { m = JSON.parse(r.model || '{}'); } catch {} console.log(`${r.id}\t${m.providerID ?? '?'}/${m.id ?? '?'}`); }
JS
}

beacon=0; SESSION=""; GOT=""
for _ in $(seq 1 45); do
  sleep 2
  if [ -z "$(win_pid "$WID")" ]; then
    printf 'WINDOW_ID=%s\n' "$WID"
    sed -i "/^$WID /d" "$STATE" 2>/dev/null || true
    die "window $WID exited before it was proven started — run $LAUNCH mini ${ATTACH[*]} --model $MODEL by hand to see why" 3
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
