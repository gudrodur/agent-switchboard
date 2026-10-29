# The launch ledger every kitty tab launcher shares (opencode-tab.sh and
# claude-tab.sh). Sourced, not run: it defines functions and the STATE path.
#
# The caller defines die() and note() first, with its own prefix, and sets HERE.
#
# STATE is `$XDG_RUNTIME_DIR/opencode-tab-launched.<uid>`, one row per launched
# window: `WID PID @LAUNCHER TITLE`. The file was named `omp-tab-launched.<uid>`
# while omp was a launcher; a ledger under the old name is moved over (mv, one
# directory, so atomic) the first time any launcher resolves STATE and the new
# name is absent, which keeps the rows of tabs that are still open.
#
# Provided here so the two launchers cannot drift:
#   kitty_up, config_root, claim_cli, win_pid   helpers
#   tab_ledger_list                              --list: print live rows, prune gone ones,
#                                                release a gone window's brief claims
#   tab_ledger_close <id>                        --close: close only a window this ledger
#                                                recorded, refusing a stranger or a reused id
#
# Brief claims (agent-config task-claim.mjs). Two seats on ONE brief is the
# race task claims exist for: on 2026-09-25 overseer windows 29 and 31 ran the
# same brief and 29 reset the tree under 31. Every launch claims
# `brief:<basename>` in the --cwd repo for the new window (owner kitty:<id>),
# a launch whose brief another LIVE window holds is refused unless
# --slot-override, and --close releases the window's claims. A window closed by
# hand never reaches --close, so a gone window's claims are released wherever
# the script learns it is gone: the --list prune, and a --close on a gone id
# with or without its row (agent-config#994). The claims live in agent-config's
# store, reached through its CLI; a missing CLI is a loud skip, never a
# refusal. Test seam: SWITCHBOARD_TASK_CLAIM.

STATE="${XDG_RUNTIME_DIR:-/tmp}/opencode-tab-launched.$(id -u)"
_OLD_STATE="${XDG_RUNTIME_DIR:-/tmp}/omp-tab-launched.$(id -u)"
if [ ! -e "$STATE" ] && [ -e "$_OLD_STATE" ]; then
  mv "$_OLD_STATE" "$STATE" 2>/dev/null || true
fi

# kitty_up keeps kitty's own error: on 2026-10-02 a /tmp sweep deleted the live
# socket and the bare "unavailable" sent a session tracing the launcher instead
# of reading "no such file or directory" (agent-config#1026 row 1). On failure
# KITTY_DIAG holds that error, $KITTY_LISTEN_ON, and whether the socket path
# still exists; --list and --close append it to their refusal.
KITTY_DIAG=""
kitty_up() {
  local err sock
  err=$(kitty @ ls 2>&1 >/dev/null) && return 0
  KITTY_DIAG=$'\n        kitty said: '"${err:-<nothing>}"
  KITTY_DIAG+=$'\n        KITTY_LISTEN_ON='"${KITTY_LISTEN_ON:-<unset>}"
  case "${KITTY_LISTEN_ON:-}" in
    unix:@*) ;;  # abstract socket: no path to check
    unix:*)
      sock=${KITTY_LISTEN_ON#unix:}
      if [ ! -e "$sock" ]; then
        KITTY_DIAG+=$'\n        The socket path does not exist: something deleted it while kitty kept'
        KITTY_DIAG+=$'\n        listening on the unlinked inode; only restart kitty restores it (it closes every window).'
      fi ;;
  esac
  return 1
}

config_root() {
  if [ -n "${AGENT_CONFIG_HOME:-}" ]; then printf '%s' "$AGENT_CONFIG_HOME"
  elif [ -d "$HOME/agent-config" ]; then printf '%s' "$HOME/agent-config"
  else printf '%s' "$HOME/.claude"; fi
}
CLAIM_CLI="${SWITCHBOARD_TASK_CLAIM:-$(config_root)/scripts/task-claim.mjs}"
claim_cli() {
  if [ ! -r "$CLAIM_CLI" ]; then
    note "task-claim CLI not found at $CLAIM_CLI — brief claims skipped"
    return 0
  fi
  node "$CLAIM_CLI" "$@"
}

# WINDOW id -> its pid, empty if the window is gone.
# `--match id:N` is AMBIGUOUS: kitty numbers tabs and windows in one space and
# they overlap (measured 2026-08-28: tab ids 5,20 and window ids 5,20 on this
# machine). So identity is resolved here against `.tabs[].windows[]` only, never
# by a grep over the whole JSON, which would match a tab as readily as a window.
win_pid() {
  kitty @ ls 2>/dev/null \
    | jq -r --argjson id "$1" '.[].tabs[].windows[] | select(.id == $id) | .pid' 2>/dev/null \
    | head -1
}

# --list. Each live row also carries the tab's state (bin/tab-state.sh).
tab_ledger_list() {
  local live_ids pruned line id pid launcher title now s stab stline st tl ag
  local state_tab; state_tab="$(cd "$(dirname "${BASH_SOURCE[0]}")/../bin" && pwd)/tab-state.sh"
  kitty_up || die "kitty remote control unavailable.$KITTY_DIAG" 2
  [ -s "$STATE" ] || { echo "(no windows launched by this script)"; return 0; }
  # One `ls` for the whole listing, not one per row: this file is append-only,
  # so the per-row form cost a kitty subprocess per historical entry.
  live_ids=$(kitty @ ls 2>/dev/null | jq -r '.[].tabs[].windows[].id' 2>/dev/null | tr '\n' ' ')
  # Gone rows are pruned on every list, not kept: a gone id can never be acted
  # on again (--close on one just deletes the row and says "already gone"), and
  # without pruning the append-only file grows forever. Only ids ABSENT from
  # kitty are pruned; REUSED ids stay, since a stranger may own that id now and
  # the row is the evidence. (The loop holds the pre-prune fd, so deleting
  # mid-loop is safe; a concurrent launch appends new lines, which the
  # id-anchored pattern never matches.)
  pruned=0
  set -f
  while IFS= read -r line; do
    # shellcheck disable=SC2086: unquoted split is the parse; globbing off via set -f.
    set -- $line
    id=${1:-}; pid=${2:-}
    # New rows mark the launcher with @; anything without the marker is a row
    # an older script wrote, whatever its token count (a legacy title has
    # spaces, so counting fields misreads `WID PID legacy title` as a launcher
    # of `legacy`). Only known-collision: a legacy title whose FIRST word
    # starts with @ — no such title has ever been written.
    case "${3:-}" in
      @*) launcher=${3#@}; shift 3; title="$*" ;;
      *) launcher=unknown; shift 2 2>/dev/null; title="$*" ;;
    esac
    case " $live_ids " in
      *" $id "*)
        now=$(win_pid "$id")
        # An id can be REUSED: kitty's counter restarts with a new instance while
        # this file survives in tmpfs. Same id + different pid is a stranger.
        if [ "$now" = "$pid" ]; then s=live; else s="REUSED"; fi ;;
      *) s=gone ;;
    esac
    # Gone ids are dropped, not displayed; the stderr count below keeps the signal.
    if [ "$s" = "gone" ]; then
      [ -n "$id" ] && sed -i "/^$id /d" "$STATE" 2>/dev/null && pruned=$((pruned + 1))
      [ -n "$id" ] && claim_cli --release-owner "kitty:$id" >/dev/null 2>&1
      continue
    fi
    # Proof by state on every row. A missing script or a failed read keeps the
    # row but says so; a row is never dropped for it.
    stab="state=? tool=- age=-"
    if [ -x "$state_tab" ]; then
      stline=$("$state_tab" "$id" 2>/dev/null | sed -n 's/^window [0-9]* //p')
      st=$(printf '%s' "$stline" | grep -o 'state=[^ ]*' | head -1)
      if [ -n "$st" ]; then
        tl=$(printf '%s' "$stline" | grep -o 'tool=[^ ]*' | head -1)
        ag=$(printf '%s' "$stline" | grep -o 'age=[^ ]*' | head -1)
        stab="$st ${tl:-tool=-} ${ag:-age=-}"
      fi
    fi
    printf '%-6s %-8s %-12s %-28s %s\n' "$id" "$s" "$launcher" "$stab" "$title"
  done < "$STATE"
  set +f
  [ "$pruned" -gt 0 ] && note "pruned $pruned gone row(s) from $STATE"
  return 0
}

# --close <id>. Returns 0 when the window was closed or was already gone; dies
# (exit 1) for a window this ledger did not record or whose id was reused.
tab_ledger_close() {
  local id="${1:-}" row want_pid now_pid
  [ -n "$id" ] || die "--close needs a window id"
  case "$id" in *[!0-9]*|"") die "--close takes a numeric window id, got: $id" ;; esac
  kitty_up || die "kitty remote control unavailable.$KITTY_DIAG" 2

  # The whole point: only ever close what a launcher here started.
  row=$(grep "^$id " "$STATE" 2>/dev/null | head -1)
  # No row but no window either (the row was pruned by --list after a hand
  # close): nothing can be closed, so the refusal guards nothing, but the
  # window's brief claims would outlive it. Release them and say so.
  if [ -z "$row" ] && [ -z "$(win_pid "$id")" ]; then
    claim_cli --release-owner "kitty:$id" >/dev/null 2>&1 || true
    note "window $id is gone and has no state row — nothing to close; released its kitty:$id claims"
    return 0
  fi
  [ -n "$row" ] \
    || die "window $id was not launched by this script — refusing to close it.
        Another session's agent window looks identical in \`kitty @ ls\`;
        closing it interrupts work you cannot see."

  want_pid=$(printf '%s' "$row" | awk '{print $2}')
  now_pid=$(win_pid "$id")

  if [ -z "$now_pid" ]; then
    # Not an error worth an exit code, but it must not be reported as a closure.
    sed -i "/^$id /d" "$STATE" 2>/dev/null
    claim_cli --release-owner "kitty:$id" >/dev/null 2>&1 || true
    note "window $id was already gone — nothing to close (state row removed, claims released)"
    return 0
  fi

  # An id outlives the process that owned it. The state file lives in tmpfs and
  # survives a kitty restart, while kitty's id counter starts over, so a stale
  # row can name a window this script never launched. The pid is the identity
  # that cannot be recycled underneath us.
  if [ -n "$want_pid" ] && [ "$want_pid" != "$now_pid" ]; then
    die "window $id is NOT the one this script launched — id reused.
        state recorded pid $want_pid, that id now belongs to pid $now_pid.
        Refusing; remove the stale row by hand if you are sure."
  fi

  if kitty @ close-window --match "id:$id" 2>/dev/null; then
    note "closed window $id"
  else
    # Measured: close-window exits 1 with `Error: No matching windows` and the
    # old code discarded both the status and the message, then said "closed".
    note "close-window FAILED for $id — the window may still be open; go look"
  fi
  sed -i "/^$id /d" "$STATE" 2>/dev/null
  claim_cli --release-owner "kitty:$id" >/dev/null 2>&1 || true
  return 0
}
