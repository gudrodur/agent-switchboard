# Claude Code's own session state, for a kitty window running `claude`.
# Sourced by bin/kitty-send.sh and bin/omp-tab-state.sh; defines functions only.
#
# The `claude` process writes <config>/sessions/<pid>.json (sessionId, cwd,
# startedAt and statusUpdatedAt in epoch ms, status busy|idle) and every turn
# to <config>/projects/<cwd with every character outside [A-Za-z0-9-] as
# '-'>/<sessionId>.jsonl.
#
# Env seams: CLAUDE_CONFIG_DIR moves the whole tree; CLAUDE_SESSIONS_DIR and
# CLAUDE_PROJECTS_DIR override one half each. KITTY_SEND_CLAUDE_SESSIONS_DIR
# and KITTY_SEND_CLAUDE_PROJECTS_DIR (the older names) win when both are set.
CLAUDE_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
CLAUDE_SESSIONS_DIR="${KITTY_SEND_CLAUDE_SESSIONS_DIR:-${CLAUDE_SESSIONS_DIR:-$CLAUDE_DIR/sessions}}"
CLAUDE_PROJECTS_DIR="${KITTY_SEND_CLAUDE_PROJECTS_DIR:-${CLAUDE_PROJECTS_DIR:-$CLAUDE_DIR/projects}}"
# The session record of the claude process in this window, or exit 1. $2 is
# the `kitty @ ls` JSON when the caller already has it (saves a second ls).
claude_session_json() { # $1 = window id, $2 = optional kitty @ ls JSON
  local pid f ls="${2:-}"
  [ -n "$ls" ] || ls=$(kitty @ ls 2>/dev/null)
  pid=$(printf '%s' "$ls" | jq -r --argjson id "$1" '
    .[].tabs[].windows[] | select(.id == $id) | .foreground_processes[]?
    | select((.cmdline[0] // "") | test("(^|/)claude$")) | .pid' 2>/dev/null | head -1)
  [ -n "$pid" ] || return 1
  f="$CLAUDE_SESSIONS_DIR/$pid.json"
  jq -e '.sessionId and .cwd' "$f" >/dev/null 2>&1 || return 1
  cat "$f"
}
claude_state_of() { # $1 = window id; busy|idle|unknown
  local j
  j=$(claude_session_json "$1") || { printf 'unknown'; return 0; }
  case "$(printf '%s' "$j" | jq -r '.status // ""' 2>/dev/null)" in
    busy) printf 'busy' ;; idle) printf 'idle' ;; *) printf 'unknown' ;;
  esac
}
claude_transcript_of() { # $1 = session json
  local sid cwd
  sid=$(printf '%s' "$1" | jq -r '.sessionId')
  cwd=$(printf '%s' "$1" | jq -r '.cwd')
  printf '%s/%s/%s.jsonl' "$CLAUDE_PROJECTS_DIR" "$(printf '%s' "$cwd" | sed 's/[^A-Za-z0-9-]/-/g')" "$sid"
}
