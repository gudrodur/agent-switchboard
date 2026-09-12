#!/usr/bin/env bash
# Proof by STATE for a delegated omp tab.
#
# An omp tab writes its state to disk as it works: one JSON object per line in
# a session jsonl file under the sessions dir (OMP_TAB_STATE_SESSIONS_DIR). This script links a kitty
# window to that file and reports the tab's state from the tail of the file,
# last row wins. Nothing on the screen is read and nothing is sent.
#
# The link from window to file: bin/omp-tab.sh launches
# `bash -lc "eval... && exec omp..."` so the window pid IS the omp pid after
# exec. /proc/<pid>/fd/0 resolves to /dev/pts/N and
# terminal-sessions/pts-N line 2 holds the session jsonl path.
# Older runs wrote terminal-sessions/kitty-<window id> instead, which wins
# when present (it names the window directly) — unless the two files DISAGREE.
# A nested `omp -p` probe run on the tab's own pty rewrites kitty-<window id>
# to the probe's session file (omp names the link from KITTY_WINDOW_ID when
# stdin is not a TTY), and the probe ends in session_exit while the tab is
# mid-turn. So when both files exist and name different paths, the
# script arbitrates instead of letting kitty-<id> win on presence alone:
# prefer the file whose session has NOT ended, else the one under the
# canonical sessions dir rather than a --session-dir elsewhere, and say
# reason=link-disagreement. Pty numbers are reused, so a pts-N file can point
# at a dead session: the jsonl `session` row is validated
# against the window (cwd equal, session timestamp later than the window
# created_at) and a mismatch reports unknown, never another tab's state.
#
# State table, from the tail of the file, last row wins:
#   exited  a session_exit row (the process is gone; steering it is pointless)
#   idle    last message row is role:assistant with stopReason:stop (at rest)
#   busy    anything else: role:user (submitted, waiting), role:assistant with
#           stopReason:toolUse (mid-turn), role:toolResult, or a trailing
#           tool_execution_start custom row; tool= names the most recent tool
#   unknown the link is unproven (no file, cwd mismatch, session older than
#           the window); reason= says which, and the caller falls back to the
#           screen (the spinner), which is the weaker proof
#
# When the state is idle or exited the line also carries jobs=N, the
# background jobs still alive at end of file (jobs=0 when none; jobs=unknown
# when node or the audit script cannot run, never 0 for "could not check").
# --json carries jobs:[ids] (or "unknown") instead. A busy tab reports no
# jobs field: its jobs are its own business and the check would run every
# 20 s. Consumers grep state=<word>, so the field sits after tool=.
#
# Usage: omp-tab-state.sh <window-id> [--json] [--watch [--interval=S]]
# --watch prints the first state, then each transition, until the window is
# gone (state=gone). An unproven link is never terminal under --watch: at tab
# startup the session file appears seconds after launch, so unknown keeps
# polling instead of exiting.
# Exit codes:
#   0  state reported (including exited, and unknown with a reason: the link
#      is merely unproven, not an error)
#   1  usage error, or no such window (the window is gone; nothing to link)
#   2  the session file is unreadable (present but cannot be read or parsed)
#
# Store root: AGENT_SWITCHBOARD_DIR (default
# `${XDG_STATE_HOME:-$HOME/.local/state}/agent-switchboard`).
# Env seams: OMP_TAB_STATE_DIR overrides the terminal-sessions
# directory; OMP_TAB_STATE_SESSIONS_DIR overrides the canonical sessions dir
# the link arbitration prefers (both default under AGENT_SWITCHBOARD_DIR);
# kitty is resolved from PATH so a stub can serve canned `ls`.
# OMP_TAB_STATE_PTS_N overrides the /proc readlink (the test's own fd 0 is
# not a pty it controls).

die()  { printf '%s\n' "omp-tab-state: $1" >&2; exit "${2:-1}"; }
note() { printf '%s\n' "omp-tab-state: $*" >&2; }

_SWITCHBOARD="${AGENT_SWITCHBOARD_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/agent-switchboard}"
SESSDIR="${OMP_TAB_STATE_DIR:-$_SWITCHBOARD/terminal-sessions}"
# The sibling that owns the alive-jobs walk. Resolved from this file rather
# than $PATH so a copy of the pair in another directory keeps working, the
# same way kitty-send.sh resolves this script.
SDIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
WID=""; JSON=0; WATCH=0; INTERVAL=5
case "${1:-}" in ''|*[!0-9]*) die "usage: omp-tab-state.sh <window-id> [--json] [--watch [--interval=S]]" ;; *) WID="$1"; shift ;; esac
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
    die "no such window: $WID (try omp-tab.sh --list)" 1 ;;
  *) die "kitty remote control unavailable (is this a kitty terminal with allow_remote_control on?)" 1 ;;
esac

# --- resolve the session file -------------------------------------------------
# Both link files may exist and disagree: a nested `omp -p` probe run on the
# tab's own pty rewrites kitty-<id> to the probe's file. Read both
# candidates and arbitrate: prefer the one whose session has NOT ended, else
# the one under the canonical sessions dir; the choice says
# reason=link-disagreement. Either file alone still resolves as before.
SESSIONS_DIR="${OMP_TAB_STATE_SESSIONS_DIR:-$_SWITCHBOARD/sessions}"
SOURCE=""; SESSION=""; LINK_REASON=""
link_target() { # $1 = link file; prints its line 2, or nothing
  [ -f "$1" ] || return 0
  sed -n '2p' "$1" 2>/dev/null | tr -d ' \t\r\n'
}
link_ended() { # $1 = session path; true when its last row is session_exit
  [ -n "${1:-}" ] || return 1
  [ -f "$1" ] || return 0
  LAST=$(grep -v '^[[:space:]]*$' "$1" 2>/dev/null | tail -1) || return 1
  [ -n "$LAST" ] || return 1
  printf '%s' "$LAST" | grep -q '"customType"[[:space:]]*:[[:space:]]*"session_exit"'
}
under_sessions() { # $1 = session path; true when under the canonical dir
  case "${1:-}" in "$SESSIONS_DIR"/*) return 0 ;; *) return 1 ;; esac
}
resolve_candidates() { # sets SOURCE SESSION LINK_REASON from the link files
  SOURCE=""; SESSION=""; LINK_REASON=""
  K_CAND=$(link_target "$SESSDIR/kitty-$WID")
  if [ -n "${OMP_TAB_STATE_PTS_N:-}" ]; then PTS="/dev/pts/$OMP_TAB_STATE_PTS_N"; else PTS=$(readlink "/proc/$WPID/fd/0" 2>/dev/null || true); fi
  case "$PTS" in
    /dev/pts/*)
      N=${PTS#/dev/pts/}
      if [ -f "$SESSDIR/pts-$N" ]; then
        P_CAND=$(link_target "$SESSDIR/pts-$N")
      else
        P_CAND=""
      fi
      ;;
    *) P_CAND="" ;;
  esac
  if [ -n "$K_CAND" ] && [ -n "$P_CAND" ] && [ "$K_CAND" != "$P_CAND" ]; then
    if link_ended "$K_CAND" && ! link_ended "$P_CAND"; then
      SOURCE="pts-$N"; SESSION="$P_CAND"; LINK_REASON="link-disagreement"
    elif link_ended "$P_CAND" && ! link_ended "$K_CAND"; then
      SOURCE="kitty-$WID"; SESSION="$K_CAND"; LINK_REASON="link-disagreement"
    elif under_sessions "$P_CAND" && ! under_sessions "$K_CAND"; then
      SOURCE="pts-$N"; SESSION="$P_CAND"; LINK_REASON="link-disagreement"
    elif under_sessions "$K_CAND" && ! under_sessions "$P_CAND"; then
      SOURCE="kitty-$WID"; SESSION="$K_CAND"; LINK_REASON="link-disagreement"
    else
      SOURCE="kitty-$WID"; SESSION="$K_CAND"
    fi
  elif [ -n "$K_CAND" ]; then
    SOURCE="kitty-$WID"
    SESSION="$K_CAND"
  elif [ -n "$P_CAND" ]; then
    SOURCE="pts-$N"
    SESSION="$P_CAND"
  fi
}
resolve_candidates
# Alive background jobs at end of file, for idle and exited states only.
# Sets JOBS_COUNT (a number, or "unknown") and JOBS_JSON (a JSON array of
# ids, or the string "unknown"). Anything the probe cannot answer is
# unknown, never 0: 0 means the walk ran and found nothing alive.
JOBS_COUNT="unknown"; JOBS_JSON='"unknown"'
probe_alive_jobs() {
  JOBS_COUNT="unknown"; JOBS_JSON='"unknown"'
  case "$STATE" in idle|exited) ;; *) return 0 ;; esac
  AUDIT="$SDIR/omp-idle-audit.mjs"
  command -v node >/dev/null 2>&1 || return 0
  [ -f "$AUDIT" ] || return 0
  OUT=$(node "$AUDIT" --alive --format=json "$SESSION" 2>/dev/null) || return 0
  COUNT=$(printf '%s' "$OUT" | jq -r 'if type == "array" then length else empty end' 2>/dev/null) || return 0
  [ -n "$COUNT" ] || return 0
  IDS=$(printf '%s' "$OUT" | jq -c 'map(.id)' 2>/dev/null) || return 0
  JOBS_COUNT="$COUNT"; JOBS_JSON="$IDS"
}

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

# Link unproven but not an error: exit 0 with unknown. Callers fall back to
# the screen proof, which is weaker but still available.
unknown_link() { # $1 = reason
  STATE=unknown; TOOL="-"; REASON="$1"; LINES=0; AGE_S=0
  report_state
  exit 0
}

# validate_link checks the resolved SESSION file and sets STATE/REASON.
# Returns 0 with STATE idle/busy/exited to come (call read_state_once next),
# 1 with STATE=unknown and REASON naming the miss, 2 with STATE=unknown and
# REASON=unreadable-session-file (present but cannot be read or parsed).
validate_link() {
  [ -n "$SESSION" ] || { STATE=unknown; TOOL="-"; REASON="no-session-file"; LINES=0; AGE_S=0; return 1; }
  [ -f "$SESSION" ] || { STATE=unknown; TOOL="-"; REASON="no-session-file"; LINES=0; AGE_S=0; return 1; }
  [ -r "$SESSION" ] || { STATE=unknown; TOOL="-"; REASON="unreadable-session-file"; LINES=0; AGE_S=0; return 2; }
  SROW=$(grep -m1 '"type":"session"' "$SESSION" 2>/dev/null || true)
  [ -n "$SROW" ] || { STATE=unknown; TOOL="-"; REASON="unreadable-session-file"; LINES=0; AGE_S=0; return 2; }
  SCWD=$(printf '%s' "$SROW" | jq -r '.cwd // ""' 2>/dev/null)
  STS=$(printf '%s' "$SROW" | jq -r '.timestamp // ""' 2>/dev/null)
  [ -n "$STS" ] || { STATE=unknown; TOOL="-"; REASON="unreadable-session-file"; LINES=0; AGE_S=0; return 2; }
  if ! [ -n "$SCWD" ] || ! [ "$SCWD" = "$WCWD" ]; then
    STATE=unknown; TOOL="-"; REASON="cwd-mismatch"; LINES=0; AGE_S=0; return 1
  fi
  SEPOCH=$(date -d "$STS" +%s 2>/dev/null || echo 0)
  WCREATED_S=$(( WCREATED_NS / 1000000000 ))
  if [ "$WCREATED_S" -gt 0 ] && [ "$SEPOCH" -lt "$WCREATED_S" ]; then
    STATE=unknown; TOOL="-"; REASON="session-older-than-window"; LINES=0; AGE_S=0; return 1
  fi
  return 0
}

if [ "$WATCH" != 1 ]; then
  validate_link || case "$?" in
    1) unknown_link "$REASON" ;;
    *) STATE=unknown; TOOL="-"; REASON="unreadable-session-file"; LINES=0; AGE_S=0; report_state; exit 2 ;;
  esac
fi

# --- state from the tail, last row wins ------------------------------------------
read_state_once() {
  STATE=idle; TOOL="-"; REASON=""; AGE_S=0
  LINES=$(wc -l < "$SESSION" 2>/dev/null | tr -d ' ' || echo 0)
  [ -n "$LINES" ] || LINES=0
  TAIL_JSON=$(tail -60 "$SESSION" 2>/dev/null | jq -c -R 'fromjson? // empty' 2>/dev/null | jq -c -s '.' 2>/dev/null) || {
    STATE=unknown; TOOL="-"; REASON="unreadable-session-file"; report_state; exit 2
  }
  EVAL=$(printf '%s' "$TAIL_JSON" | jq -r '
    . as $rows
    | ([ $rows[] | select(.type == "custom" and .customType == "session_exit") ] | length) as $exits
    | ([ $rows[] | select(.type == "custom" and .customType == "tool_execution_start") | .data.toolName ] | last // "-") as $tool
    | ([ $rows[] | select(.type == "message") ] | last) as $last
    | ([ $rows[] | select(.type == "custom" and .customType == "session_exit") ] | last) as $exitrow
    | ($rows | last) as $tail
    | if ($tail.type == "custom" and $tail.customType == "session_exit") then
        {state: "exited", tool: "-", ts: ($tail.timestamp // $tail.data.recordedAt // "")}
      elif $last == null then
        {state: "busy", tool: $tool, ts: (($tail.message.timestamp // $tail.timestamp // "") | tostring)}
      elif $last.message.role == "assistant" and $last.message.stopReason == "stop" then
        {state: "idle", tool: "-", ts: (($last.message.timestamp // "") | tostring)}
      elif $last.message.role == "assistant" then
        {state: "busy", tool: $tool, ts: (($last.message.timestamp // "") | tostring)}
      elif $last.message.role == "user" then
        {state: "busy", tool: $tool, ts: (($last.message.timestamp // "") | tostring)}
      else
        {state: "busy", tool: $tool, ts: (($last.message.timestamp // "") | tostring)}
      end
    | "\(.state)\t\(.tool)\t\(.ts)"' 2>/dev/null) || {
    STATE=unknown; TOOL="-"; REASON="unreadable-session-file"
    if [ "$WATCH" = 1 ]; then return 2; fi
    report_state; exit 2
  }
  STATE=$(printf '%s' "$EVAL" | cut -f1)
  TOOL=$(printf '%s' "$EVAL" | cut -f2)
  TS=$(printf '%s' "$EVAL" | cut -f3)
  [ -n "$TOOL" ] || TOOL="-"
  NOW=$(date +%s)
  # Message timestamps are epoch millis; custom rows carry ISO. Accept both.
  case "$TS" in ''|null) AGE_S=0 ;; *[!0-9]*) E2=$(date -d "$TS" +%s 2>/dev/null || echo "$NOW"); AGE_S=$(( NOW - E2 )) ;; *) AGE_S=$(( NOW - TS / 1000 )) ;; esac
  [ "$AGE_S" -lt 0 ] && AGE_S=0
}

if [ "$WATCH" = 1 ]; then
  PREV=""
  while :; do
    if ! window_info; then
      printf 'window %s state=gone reason=no-such-window\n' "$WID"
      exit 0
    fi
    resolve_candidates
    if validate_link; then
      if read_state_once; then
        probe_alive_jobs
      else
        JOBS_COUNT="unknown"; JOBS_JSON='"unknown"'
      fi
    else
      JOBS_COUNT="unknown"; JOBS_JSON='"unknown"'
    fi
    SNAP="$STATE $TOOL ${REASON:-$LINK_REASON}"
    if [ "$SNAP" != "$PREV" ]; then
      report_state
      PREV="$SNAP"
    fi
    sleep "$INTERVAL"
  done
  exit 0
fi

read_state_once
probe_alive_jobs
report_state
exit 0
