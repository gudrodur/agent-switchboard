#!/usr/bin/env bash
# Proof by STATE for a delegated agent tab: is the window busy, idle or
# unknown, and which session is it.
#
# Nothing on the screen is read and nothing is sent. Two kinds of tab are
# recognised, asked in this order:
#
# A Claude Code tab: when the window's foreground process is `claude`,
# <config>/sessions/<pid>.json decides: its status busy|idle is the state
# (anything else is unknown with reason=claude-status-<value>), session= is
# the transcript path, lines= its line count, age= the seconds since
# statusUpdatedAt, source=claude. A record whose startedAt predates the window
# is unknown reason=session-older-than-window. tool= is "-" and jobs are
# unknown. The record and transcript readers are lib/claude-session.sh, shared
# with kitty-send.sh.
#
# An OpenCode tab has no per-tab file: since v2.0.29 opencode writes its state
# into SQLite (opencode.db). The newest top-level `session_v2` row whose
# `directory` is this window's cwd and which was created no earlier than the
# window, then the newest decisive `session_message` row for it (`idle`,
# `user`, `assistant` or `shell`) decides idle/busy, and `lines` is the highest
# `seq` in that session: the counter a send proof watches grow.
#
# A window that is neither is state=unknown reason=no-session-file, and the
# caller falls back to the screen (the spinner), which is the weaker proof.
#
# Usage: tab-state.sh <window-id> [--json] [--watch [--interval=S]]
# --watch prints the first state, then each transition, until the window is
# gone (state=gone). An unproven link is never terminal under --watch: at tab
# startup the record appears seconds after launch, so unknown keeps polling
# instead of exiting.
# Exit codes:
#   0  state reported (including unknown with a reason: the link is merely
#      unproven, not an error)
#   1  usage error, or no such window (the window is gone; nothing to link)
#
# Env seams: CLAUDE_CONFIG_DIR, CLAUDE_SESSIONS_DIR and CLAUDE_PROJECTS_DIR
# locate Claude Code's records (see lib/claude-session.sh); OPENCODE_TAB_DB
# overrides the opencode store (defaults to opencode's own path under
# $XDG_DATA_HOME, because opencode writes it, not this repo); kitty is
# resolved from PATH so a stub can serve canned `ls`.

die()  { printf '%s\n' "tab-state: $1" >&2; exit "${2:-1}"; }
note() { printf '%s\n' "tab-state: $*" >&2; }

OPENCODE_TAB_DB="${OPENCODE_TAB_DB:-${XDG_DATA_HOME:-$HOME/.local/share}/opencode/opencode.db}"
SDIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
# A Claude Code tab's session record and transcript readers, shared with
# kitty-send.sh (it also fixes the CLAUDE_SESSIONS_DIR/CLAUDE_PROJECTS_DIR seams).
. "$SDIR/../lib/claude-session.sh"
WID=""; JSON=0; WATCH=0; INTERVAL=5
case "${1:-}" in ''|*[!0-9]*) die "usage: tab-state.sh <window-id> [--json] [--watch [--interval=S]]" ;; *) WID="$1"; shift ;; esac
while [ $# -gt 0 ]; do
  case "$1" in
    --json) JSON=1; shift ;;
    --watch) WATCH=1; shift ;;
    --interval=*) INTERVAL="${1#--interval=}"; shift ;;
    --interval) INTERVAL="${2:-}"; shift 2 || die "--interval needs a value" ;;
    *) die "unknown argument: $1" ;;
  esac
done
case "$INTERVAL" in ''|*[!0-9]*|0) die "--interval must be a positive number of seconds" ;; esac
JOBS_COUNT="unknown"; JOBS_JSON='"unknown"'; LINK_REASON=""; SOURCE=""; SESSION=""

# --- resolve the window -------------------------------------------------------
# window_info sets WPID WCWD WCREATED_NS from the live kitty table.
# Returns 0 with the window, 1 when the window is gone, 2 when kitty remote
# control itself is unavailable. The --watch loop re-calls it every interval
# so a closed window ends the watch with state=gone.
window_info() {
  WIN_JSON=$(kitty @ ls 2>/dev/null) || return 2
  WINFO=$(printf '%s' "$WIN_JSON" | jq -r --argjson id "$WID" \
    '.[].tabs[].windows[] | select(.id == $id) | "\(.pid)\t\(.cwd // "")\t\(.created_at // 0)"' 2>/dev/null | head -1)
  [ -n "$WINFO" ] || return 1
  WPID=$(printf '%s' "$WINFO" | cut -f1)
  WCWD=$(printf '%s' "$WINFO" | cut -f2)
  WCREATED_NS=$(printf '%s' "$WINFO" | cut -f3)
  return 0
}
window_info || case "$?" in
  1)
    if [ "$WATCH" = 1 ]; then
      printf 'window %s state=gone reason=no-such-window\n' "$WID"
      exit 0
    fi
    die "no such window: $WID (try opencode-tab.sh --list)" 1 ;;
  *) die "kitty remote control unavailable (is this a kitty terminal with allow_remote_control on?)" 1 ;;
esac

# One report, printed by report_state. Globals it reads: STATE TOOL REASON
# SESSION SOURCE LINES AGE_S JOBS_COUNT JOBS_JSON LINK_REASON. LINK_REASON
# survives read_state_once (which resets REASON per read): the link choice
# stands for the whole run, so an empty per-read REASON falls back to it.
report_state() {
  RSHOW="${REASON:-$LINK_REASON}"
  if [ "$JSON" = 1 ]; then
    if [ "$STATE" = "idle" ] || [ "$STATE" = "exited" ]; then
      jq -n --argjson window "$WID" --argjson pid "${WPID:-0}" \
        --arg state "$STATE" --arg tool "$TOOL" --arg reason "$RSHOW" \
        --arg session "$SESSION" --arg source "$SOURCE" \
        --argjson jobs "$JOBS_JSON" \
        --argjson lines "${LINES:-0}" --argjson age_s "${AGE_S:-0}" \
        '{window: $window, pid: $pid, state: $state, tool: $tool, jobs: $jobs, reason: $reason, session: $session, source: $source, lines: $lines, age_s: $age_s}'
    else
      jq -n --argjson window "$WID" --argjson pid "${WPID:-0}" \
        --arg state "$STATE" --arg tool "$TOOL" --arg reason "$RSHOW" \
        --arg session "$SESSION" --arg source "$SOURCE" \
        --argjson lines "${LINES:-0}" --argjson age_s "${AGE_S:-0}" \
        '{window: $window, pid: $pid, state: $state, tool: $tool, reason: $reason, session: $session, source: $source, lines: $lines, age_s: $age_s}'
    fi
  else
    if [ -n "$RSHOW" ]; then RSUFFIX=" reason=$RSHOW"; else RSUFFIX=""; fi
    if [ "$STATE" = "unknown" ]; then
      printf 'window %s state=unknown reason=%s source=%s session=%s\n' "$WID" "$RSHOW" "${SOURCE:-none}" "${SESSION:-none}"
    elif [ "$STATE" = "busy" ]; then
      printf 'window %s state=%s tool=%s age=%ss lines=%s session=%s%s\n' "$WID" "$STATE" "$TOOL" "$AGE_S" "$LINES" "$SESSION" "$RSUFFIX"
    else
      printf 'window %s state=%s tool=%s jobs=%s age=%ss lines=%s session=%s%s\n' "$WID" "$STATE" "$TOOL" "$JOBS_COUNT" "$AGE_S" "$LINES" "$SESSION" "$RSUFFIX"
    fi
  fi
}

# --- state from Claude Code's own session record -------------------------------
# read_claude_state answers for a window whose foreground process is `claude`
# (lib/claude-session.sh finds <pid>.json from the ls table window_info
# already fetched). Returns 1 having touched nothing when the window is not a
# Claude Code tab. Otherwise
# returns 0 with STATE/REASON set: busy|idle from the record's status, unknown
# reason=claude-status-<value> for any other status, and unknown
# reason=session-older-than-window when the record's startedAt predates the
# window (a pid reused by an older claude). SESSION is the transcript path, LINES its line count (0
# before the first turn), AGE_S the seconds since statusUpdatedAt. Background jobs
# are not tracked for it: unknown, never 0.
read_claude_state() {
  local cj st started updated now
  cj=$(claude_session_json "$WID" "$WIN_JSON") || return 1
  SOURCE="claude"; LINK_REASON=""; REASON=""; TOOL="-"; LINES=0; AGE_S=0
  JOBS_COUNT="unknown"; JOBS_JSON='"unknown"'
  SESSION=$(claude_transcript_of "$cj")
  [ -f "$SESSION" ] && LINES=$(wc -l < "$SESSION" | tr -d ' ')
  case "$LINES" in ''|*[!0-9]*) LINES=0 ;; esac
  started=$(printf '%s' "$cj" | jq -r '.startedAt // 0' 2>/dev/null)
  case "$started" in ''|*[!0-9]*) started=0 ;; esac
  WCREATED_S=$(( WCREATED_NS / 1000000000 ))
  if [ "$WCREATED_S" -gt 0 ] && [ $(( started / 1000 )) -lt "$WCREATED_S" ]; then
    STATE=unknown; REASON="session-older-than-window"; LINES=0
    return 0
  fi
  updated=$(printf '%s' "$cj" | jq -r '.statusUpdatedAt // 0' 2>/dev/null)
  case "$updated" in ''|*[!0-9]*) updated=0 ;; esac
  now=$(date +%s)
  if [ "$updated" -gt 0 ]; then AGE_S=$(( now - updated / 1000 )); [ "$AGE_S" -lt 0 ] && AGE_S=0; fi
  st=$(printf '%s' "$cj" | jq -r '.status // ""' 2>/dev/null)
  case "$st" in
    busy|idle) STATE="$st" ;;
    *) STATE=unknown; REASON="claude-status-${st:-none}" ;;
  esac
  return 0
}

# --- state from opencode's store, for a tab with no per-tab file -----------------------
# read_opencode_state answers for an OpenCode tab (v2.0.29+), which writes no
# per-tab file: its session and message rows are in opencode.db. Sets STATE,
# TOOL, SESSION, SOURCE, LINES, AGE_S, REASON, LINK_REASON, JOBS_COUNT and
# JOBS_JSON on success and returns 0; on any miss it returns 1 having touched
# NOTHING, so the caller's own reason (cwd-mismatch, no-session-file) stands.
#
# Which session: the newest top-level row in `session_v2` whose directory is
# this window's cwd and whose time_created is no earlier than the window (5 s
# of slack for the two clocks), because pty numbers — and therefore this
# window's pid — are reused by the OS.
# Which state: the newest decisive `session_message` for that session, in the
# same sense as a decisive transcript row. `idle` is opencode saying the turn
# finished; anything else it wrote while working (user, assistant, shell) is
# busy, and the tool name comes from the last tool in the newest assistant
# row's content. `lines` is MAX(seq), the counter a send proof grows past.
read_opencode_state() {
  [ -n "${OPENCODE_TAB_DB:-}" ] && [ -r "$OPENCODE_TAB_DB" ] || return 1
  command -v node >/dev/null 2>&1 || return 1
  SINCE=$(( WCREATED_NS / 1000000 - 5000 ))
  OC=$(node - "$OPENCODE_TAB_DB" "$WCWD" "$SINCE" <<'JS' 2>/dev/null
process.emitWarning = () => {};
const { DatabaseSync } = require('node:sqlite');
const [db, cwd, since] = process.argv.slice(2);
const d = new DatabaseSync(db, { readOnly: true });
const s = d
  .prepare('SELECT id, time_idle FROM session_v2 WHERE directory = ? AND parent_id IS NULL AND time_created >= ? ORDER BY time_created DESC LIMIT 1')
  .get(cwd, Number(since));
if (!s) process.exit(1);
const rows = d
  .prepare('SELECT type, seq, time_created, data FROM session_message WHERE session_id = ? ORDER BY seq DESC, time_created DESC LIMIT 20')
  .all(s.id);
const lines = d.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM session_message WHERE session_id = ?').get(s.id).m;
const decisive = rows.find((r) => ['idle', 'user', 'assistant', 'shell'].includes(r.type));
let state = 'idle';
let tool = '-';
let ts = Number(s.time_idle || 0);
if (decisive) {
  ts = Number(decisive.time_created) || ts;
  state = decisive.type === 'idle' ? 'idle' : 'busy';
} else if (!s.time_idle) {
  state = 'busy';
}
if (state === 'busy') {
  const a = rows.find((r) => r.type === 'assistant');
  if (a) {
    try {
      const content = JSON.parse(a.data).content;
      if (Array.isArray(content)) {
        const last = [...content].reverse().find((c) => c && c.type === 'tool');
        if (last && last.name) tool = String(last.name);
      }
    } catch { /* unparseable data names no tool */ }
  }
}
console.log([state, tool, ts, s.id, lines].join('\t'));
JS
) || return 1
  OC_STATE=$(printf '%s' "$OC" | cut -f1)
  [ -n "$OC_STATE" ] || return 1
  STATE="$OC_STATE"
  TOOL=$(printf '%s' "$OC" | cut -f2); [ -n "$TOOL" ] || TOOL="-"
  OC_TS=$(printf '%s' "$OC" | cut -f3)
  SESSION="opencode:$(printf '%s' "$OC" | cut -f4)"
  LINES=$(printf '%s' "$OC" | cut -f5)
  case "$LINES" in ''|*[!0-9]*) LINES=0 ;; esac
  case "$OC_TS" in ''|*[!0-9]*) OC_TS=0 ;; esac
  SOURCE="opencode-db"; REASON=""; LINK_REASON=""
  # opencode's store names no background-job concept a probe could walk on this
  # tab's behalf, and its own row is the proof: 0 jobs alive, not "unknown".
  JOBS_COUNT="0"; JOBS_JSON="[]"
  NOW=$(date +%s)
  AGE_S=$(( (NOW * 1000 - OC_TS) / 1000 ))
  [ "$AGE_S" -lt 0 ] && AGE_S=0
  return 0
}

# Neither reader claimed the window: unproven, not an error.
no_record() {
  STATE=unknown; TOOL="-"; REASON="no-session-file"; LINES=0; AGE_S=0
  SOURCE=""; SESSION=""; LINK_REASON=""
  JOBS_COUNT="unknown"; JOBS_JSON='"unknown"'
}

if [ "$WATCH" != 1 ]; then
  if read_claude_state || read_opencode_state; then :; else no_record; fi
  report_state
  exit 0
fi

PREV=""
while :; do
  if ! window_info; then
    printf 'window %s state=gone reason=no-such-window\n' "$WID"
    exit 0
  fi
  if read_claude_state || read_opencode_state; then :; else no_record; fi
  SNAP="$STATE $TOOL ${REASON:-$LINK_REASON}"
  if [ "$SNAP" != "$PREV" ]; then
    report_state
    PREV="$SNAP"
  fi
  sleep "$INTERVAL"
done
