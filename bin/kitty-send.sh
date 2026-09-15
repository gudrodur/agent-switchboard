#!/usr/bin/env bash
# Send a message into another kitty window (a running agent, a REPL, a shell) and
# PROVE it arrived. Use it to steer a tab that is already running; `omp-tab.sh`
# is what LAUNCHES one and sends it its opening brief.
# `bin/agent-send.mjs` is the sender now; this file is the fallback it reaches for when the recipient window has no mailbox consumer.
#
# omp-tab.sh calls this file rather than reimplementing it,
# so the \r rule below exists once. It keeps a SEPARATE gate of its own, and the
# distinction is the point: this file proves the TEXT ARRIVED, omp-tab.sh then
# proves the agent STARTED WORKING on it. A tab can do the first and not the
# second.

# PROOF BY STATE FIRST. An omp tab writes every turn to
# a session jsonl file on disk, and omp-tab-state.sh links this window to
# that file. After the send this script polls that file for a NEW role:user
# message row past the pre-send line count: that row is the tab receiving
# the text, which no screen rendering can hide, wrap or scroll away. Nine
# retro rows in eight sessions (09-04 to 09-09) were the echo proof failing
# exactly that way, and eight single-case fixes each closed one shape while
# the class recurred. The echo proof below (tail or head fragment newly on
# screen) runs only when the window has no session file to read — not an
# omp tab, or the pty link is unproven — and its verdict is exit 10
# ("typed, not proven submitted"), never "delivered".
# Exit codes:
#   0  sent AND proven: a new role:user row in the tab's session file
#      (the only proof that names the tab receiving the text)
#   1  usage / precondition error (no kitty remote control, no such window)
#   3  could not prove it landed — sent but unconfirmed, or the screen could
#      not be read to attempt the proof (nothing is retried for you)
#   4  the target is showing a selection dialog — NOTHING WAS SENT (see below)
#   5  --wait-idle/--deadline ran out before the target went idle — NOTHING WAS SENT
#   6  --queue: a send is already queued for that window — NOTHING WAS SENT
#   7  the target is mid-turn and none of --wait-idle / --queue / --now was
#      given — NOTHING WAS SENT (the discard below is opt-in, never a default)
#   8  sent while the target was mid-turn (--now) and it is STILL mid-turn:
#      the message is pending in its steering queue — no role:user row can
#      reach the session file until the tool boundary. Truthful, not proven;
#      like exit 3 it must never invite a resend
#   9  the target's composer already holds an unsubmitted paste chip that is
#      NOT kitty-send's own leftover — NOTHING WAS SENT (it may be a human's
#      draft; the message prints the recovery command)
#   10 typed, not proven submitted: the window has no session file to read,
#      so the only proof is the screen. The text reached the window (it
#      echoed, or the screen changed on it) but nothing proves the target
#      submitted it — a composer echoes unsubmitted text too (measured
#      2026-09-15, agent-config#638 row 57: a Claude Code composer held the
#      burst as a paste chip while the echo proof said "delivered"). Never
#      "delivered", and never resend blind: the text may already sit in the
#      composer.
#
# A composer echo is NOT delivery. The host agent's
# composer collapses a send-text burst into a `[Pasted text #N +M lines]` chip
# and swallows the trailing \r inside it, so the text sits in the text box
# and the agent never sees it — while the fragment match would call it
# "echoed at the prompt". So in the no-session-file branch only (an omp tab
# proves by session row and never takes this path): a `[Pastedtext#` chip on
# the squashed screen after the send means NOT DELIVERED whatever the fragment
# match says — one Enter is pressed, at most once per send, and only a chip
# gone AND the fragment echoed confirms. A chip on screen BEFORE the send
# means the composer is dirty: with kitty-send's own stranded record for this
# window (chip numbers plus pid and created_at, beside the queue dir) it is
# recovered with Enter and then sent; without one it is exit 9, since
# pressing Enter blindly could submit a human's half-pasted draft.
#
# Four things make a hand-rolled `kitty @ send-text` unreliable, all measured:
#
#   * `send-text` exits 0 even when it matched NO window (`--match id:99999999`
#     -> exit 0). Its status is worthless. The tab's session file is the
#     first evidence (see PROOF BY STATE above); the screen read-back with
#     `get-text` is the fallback for windows that have no session file.
#   * A trailing newline is not a submit in every TUI. Text sent with "\n" can sit
#     in the prompt unsubmitted while the sender believes it was delivered.
#   * Sending the text and the carriage return as TWO calls is worse than either:
#     in an agent TUI with a steering queue the second call enqueues an EMPTY
#     message, and the agent then blocks every tool call waiting for an advisory
#     that never arrives. Measured 2026-09-02 on an omp tab: ~20 minutes and
#     ~$0.20 burned in a retry loop, zero work done, caused by exactly this.
#     The text and the \r go in ONE call. That is the whole rule.
#   * A SELECTION DIALOG eats the keystrokes. When the target's TUI is showing
#     its ask-the-user widget (omp: "Enter select · n note · ↑/↓ move · Esc
#     cancel"), send-text does not type into a prompt at all: every character
#     is a hotkey, and the \r is Enter on whatever option is highlighted.
#     Measured 2026-09-03 on an omp tab: the message contained an `n`, which
#     opened the note field; the rest of the text went into that note,
#     truncated at the field's width; the \r closed the note; and when the
#     human later answered the dialog, the agent received a mangled file path
#     labelled as a note and treated it as a prompt-injection attempt. Nothing
#     was selected only by luck of the letter order. So the screen is checked
#     for a dialog BEFORE anything is sent, and a dialog means exit 4 with
#     nothing sent. A dialog is a question to the HUMAN; the script never
#     answers it.
#
# Timing is a cost as well. A message sent to an agent that is mid-turn lands in
# its steering queue and is delivered at the next turn boundary — and the tool
# call in flight at that moment has its result DISCARDED ("Skipped due to queued
# user message. Do not count this skipped result as completed work", measured
# 2026-09-03). A cheap probe re-runs; a deploy watch or a long test run is lost.
# `--wait-idle N` polls for up to N seconds until the target's title carries no
# spinner and no dialog is open, and only then sends; `--queue` does the same
# from a detached waiter. Since 2026-09-06 a queued send WITHOUT
# a bound waits indefinitely: a tab inside a pre-push suite is never idle
# inside any fixed window, and four queued steers died after the old fixed
# 600 s default with "target still busy after 600s (nothing was sent)". The
# unbounded waiter logs a heartbeat every 5 min so a long wait reads as alive
# rather than stuck, and `--deadline N` (or `--wait-idle N`) caps the wait
# when the caller wants a cap. A busy target with NEITHER a bound nor --queue
# is refused, exit 7, nothing sent: until 2026-09-05 it was sent to anyway
# with a note on stderr naming the cost, and the note was read after the
# result was already gone (the senders never passed --wait-idle,
# because nothing made them). The one send that should land mid-turn —
# "stop", or a notice about something that is about to disappear — says so
# with `--now`, which accepts the discard in the command line where the next
# reader can see it.
#
# Title convention this relies on, measured on omp 2026-09-03: the window title
# starts "π ⠹ …" while a turn is running (a braille spinner, U+2800–U+28FF),
# "π > …" at an idle prompt, and "π ! …" while a dialog waits for the human.
# The spinner is what "busy" means here; the dialog is read off the screen.
#
# The spinner cannot tell WORKING from WAITING, and the difference matters: an
# agent looping on a `sleep`+poll (watching CI, waiting to be told what is next)
# spins forever with no tool result worth protecting, which is the one state
# where a steer lands perfectly. On 2026-09-07 a `--queue` steer waited 3 min
# 26 s and delivered nothing while the target printed "Bíð eftir næsta
# skilaboði." about twenty times and burned ~$0.10 looping; it had to be
# cancelled and re-sent with --now.
#
# `--idle-when REGEX` is the escape, and the pattern is the CALLER'S to supply
# rather than a marker list in here. That is not laziness: omp prints no stable
# waiting-state string to key on (measured 2026-09-07, `strings` over the
# launcher finds none) — the line above was the delegated agent's own prose, in
# Icelandic, because its brief was written that way. A list of markers would
# only ever match the briefs that happened to be written first. DIALOG_MARKERS
# below can be a fixed list because a dialog IS omp's own widget.
#
# Multi-line input is refused rather than guessed at: inside single quotes a
# backslash-newline is a literal backslash, and an embedded newline submits a
# truncated first line. Pass one line, or use --file for a path the target reads
# itself.
#
# Usage and options live in usage() below, which `--help` / `-h` prints:
# one copy, so the printed text cannot drift from a comment copy.


set -euo pipefail

# $1 is the message, $2 the exit code. Using "$*" here would print the code as
# part of the message ("... try --list) 1"), which omp-tab.sh's copy still does.
die()  { printf '%s\n' "kitty-send: $1" >&2; exit "${2:-1}"; }
note() { [ "${QUIET:-0}" = 1 ] || printf '%s\n' "kitty-send: $*" >&2; }
# The sibling that owns proof by state. Resolved from this file rather than
# $PATH so a copy of the pair in another directory keeps working; absent or
# failing, every state read below is "unknown" and the spinner decides.
STATE_SH="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/omp-tab-state.sh"
# One of busy|idle|exited|unknown. Anything the state script cannot answer —
# no such window, no session file, unreadable file — is unknown, never fatal
# here: the spinner fallback below is weaker but still available.
tab_state_of() { # $1 = window id
  [ -x "$STATE_SH" ] || { printf 'unknown'; return 0; }
  out=$("$STATE_SH" "$1" --json 2>/dev/null) || { printf 'unknown'; return 0; }
  printf '%s' "$out" | jq -r '.state // "unknown"' 2>/dev/null || printf 'unknown'
}
# The full --json verdict, or nothing with exit 1. The send proof below reads
# .session and .lines off it.
tab_state_json() { # $1 = window id
  [ -x "$STATE_SH" ] || return 1
  "$STATE_SH" "$1" --json 2>/dev/null || return 1
}
usage() {
  cat <<'KITTY_SEND_USAGE'
Usage:
  kitty-send.sh --to <window-id|title-substring> --text "one line"
  kitty-send.sh <window-id> --text "one line"  # a bare id is --to
  kitty-send.sh --to <target> --file /abs/path      # sends "Read /abs/path ..."
  kitty-send.sh --to <target> --text "..." --expect "substring"
  kitty-send.sh --to <target> --text "..." --wait-idle 600
  kitty-send.sh --to <target> --text "..." --queue        # returns at once
  kitty-send.sh --to <target> --text "..." --queue --deadline 3600
  kitty-send.sh --to <target> --text "..." --idle-when 'waiting for'  # spins, but idle
  kitty-send.sh --to <target> --text "stop" --now         # mid-turn, on purpose
  kitty-send.sh --cancel --to <target>                     # drop a queued send
  kitty-send.sh --list

Options:
  --to        window id, or a substring of the window/tab title (must match one)
  --text      the message, ONE line
  --file      absolute path; sends an instruction to read it (mutually exclusive
              with --text). The instruction names the sender and calls the file
              a note: an unattributed "carry it out in full, run the commands
              rather than reasoning" reads as an injection to a careful agent,
              which is exactly what one did on 2026-09-03.
  --expect    substring that must NEWLY appear on the target's screen as proof
              of arrival. Default: a distinctive tail of the message itself —
              EXCEPT for a `/`-command, whose echo is replaced by its effect;
              there the default proof is the screen CHANGING after the send
              (see the slash paragraph below the poll loop).
  --timeout   seconds to wait for the proof (default 20)
  --wait-idle seconds to wait for the target to be idle (no spinner in the
              title, no dialog on screen) before sending; 0 = do not wait
              (default). Runs out -> exit 5, nothing sent.
  --deadline  seconds. The same bound as --wait-idle, spelled for a caller
              who wants to cap an otherwise unbounded --queue wait. With
              --queue and NEITHER bound, the wait is UNBOUNDED: the detached
              waiter holds until the target goes idle, logging a heartbeat
              every 300 s (KITTY_SEND_HEARTBEAT_S overrides; a test seam) so
              a long wait reads as alive, not stuck. Added because a
              tab inside a pre-push suite is never idle inside 600 s.
  --queue     return at once; a background waiter holds the send until the
              target is idle and then delivers with the same proof. Since
              2026-09-06 the wait is UNBOUNDED by default,
              with a heartbeat every 5 min; --wait-idle N or --deadline N
              caps it. One queued send per window; the pid and the log path
              are printed, and the log carries the delivery verdict. Added after
              fourteen foreground --wait-idle timeouts cost
              23 minutes and one steer was never delivered, because the
              only other choice was a blind send that discards the target's
              in-flight tool result.
  --now       send even if the target is mid-turn, accepting that the tool
              call in flight has its result discarded. Without it, and
              without --wait-idle or --queue, a busy target is exit 7 and
              nothing is sent. Mutually exclusive with both.
  --idle-when an ERE. A spinning target whose bottom 15 screen lines match it
              counts as IDLE, so the send goes out (or a --wait-idle/--queue
              wait ends) instead of exit 5/7. For the tab that is looping on a
              poll or waiting to be told what is next: it spins, but there is
              no in-flight tool result to discard. Forwarded to the --queue
              waiter. A DIALOG still wins — that is the human's to answer, and
              no pattern overrides it.
  --cancel    with --to: kill that window's queued waiter, if any, and
              nothing else. It kills the pid recorded at --queue time, never
              a pattern: `pkill -f` with the target's own argv also matches
              the shell running the pkill (seen twice, exit 144).
  --quiet     only errors on stderr
KITTY_SEND_USAGE
}


kitty_up() { kitty @ ls >/dev/null 2>&1; }

# Every window as: <id>\t<window title>\t<tab title>
win_table() {
  kitty @ ls 2>/dev/null | jq -r '
    .[].tabs[] as $t | $t.windows[] |
    [ (.id|tostring), (.title // ""), ($t.title // "") ] | @tsv' 2>/dev/null
}

win_pid() {
  kitty @ ls 2>/dev/null \
    | jq -r --argjson id "$1" '.[].tabs[].windows[] | select(.id == $id) | .pid' 2>/dev/null \
    | head -1
}

win_title() {
  kitty @ ls 2>/dev/null \
    | jq -r --argjson id "$1" '.[].tabs[].windows[] | select(.id == $id) | .title // ""' 2>/dev/null \
    | head -1
}
win_created() {
  kitty @ ls 2>/dev/null \
    | jq -r --argjson id "$1" '.[].tabs[].windows[] | select(.id == $id) | .created_at // empty' 2>/dev/null \
    | head -1
}

# The one Enter the chip branches press. kitty before 0.33.0 ignored --match on
# `kitty @ send-key` (kitty changelog 0.33.0, iss 7192): measured 2026-09-13 on
# a CI runner with kitty 0.32.2, the Enter never reached the target window. So
# an older or unknown kitty gets a lone carriage return through send-text,
# which has always honoured --match; 0.33.0 and later keep send-key, the path
# proven live against a real composer.
kitty_at_least_033() {
  local v maj min
  v=$(kitty --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+' | head -1)
  [ -n "$v" ] || return 1
  maj=${v%%.*}; min=${v#*.}
  [ "$maj" -gt 0 ] || [ "$min" -ge 33 ]
}
press_enter() { # $1 = window id
  if kitty_at_least_033; then
    kitty @ send-key --match "id:$1" enter 2>/dev/null || true
  else
    kitty @ send-text --match "id:$1" $'\r' 2>/dev/null || true
  fi
}
enter_cmd_text() { # $1 = window id; the same Enter as a command a human can paste
  if kitty_at_least_033; then
    printf '%s' "kitty @ send-key --match id:$1 enter"
  else
    printf '%s' "kitty @ send-text --match id:$1 \$'\\r'"
  fi
}

# Stranded-chip ownership. When
# kitty-send leaves a chip it could not clear, it records, beside QUEUE_DIR:
# the window id (the filename), the chip NUMBER(S) it left, the window's pid
# and kitty created_at (the host agent restarts chip numbering with a new
# session, so a bare number can become false), and the time. `[Pastedtext#` is
# not an identity; the number is. Ownership is a SUBSET test: every chip on
# screen must be in this window's record, with pid and created_at matching.
stranded_file() { printf '%s/kitty-send-stranded/stranded-%s' "${XDG_RUNTIME_DIR:-${TMPDIR:-/tmp}}" "$1"; }
screen_chips() { # $1 = window id; sorted unique chip numbers on screen
  kitty @ get-text --match "id:$1" --extent all 2>/dev/null | grep -oE 'Pasted text #[0-9]+' | grep -oE '[0-9]+' | sort -nu
}

# Busy = a braille spinner glyph in the window title (see the header). grep -P
# with a UTF-8 locale is what makes the range match a character, not bytes.
title_busy() {
  LC_ALL=C.UTF-8 printf '%s' "$1" | LC_ALL=C.UTF-8 grep -qP '[\x{2800}-\x{28FF}]'
}

# Dialog = the footer/markers of an ask-the-user widget on the visible screen.
# The markers are omp's today; add a TUI's own footer text here when it shows
# one, rather than teaching a caller to know. Bottom 15 rows only: a dialog
# that was answered stays in the scrollback in full, and that must not count.
DIALOG_MARKERS='Enter select|Esc cancel|↑/↓ move|✎ note'
# 0 = dialog on screen, 1 = none, 2 = the screen could not be read. A failed
# read is NOT "no dialog": failing open here would type into exactly the
# widget this check exists to protect, so the callers treat 2 as fatal.
dialog_open() {
  local screen
  screen=$(kitty @ get-text --match "id:$1" --extent screen 2>/dev/null) || return 2
  printf '%s' "$screen" | tail -15 | grep -qE -- "$DIALOG_MARKERS"
}
# --idle-when: does the bottom of the screen say this target is waiting rather
# than working? Same window as DIALOG_MARKERS and for the same reason — an
# earlier turn's output must not count. 0 = matches (treat as idle), 1 = no
# match or no pattern given, 2 = the screen could not be read. Unlike the dialog
# check this one may fail CLOSED without harm: an unreadable screen just leaves
# the target busy, which is the existing behaviour.
steerable_screen() {
  local screen
  [ -n "$IDLE_WHEN" ] || return 1
  screen=$(kitty @ get-text --match "id:$1" --extent screen 2>/dev/null) || return 2
  printf '%s' "$screen" | tail -15 | grep -qE -- "$IDLE_WHEN"
}
# The busy decision every caller below shares. State first, spinner second:
# --idle-when is the caller's own parked proof and wins over every other
# busy signal, state included (its purpose is a tab that spins while waiting
# for input). A tab the state file says is idle is idle regardless of the
# spinner; an exited tab dies here, exit 1, naming it. Unknown (no session
# file: not an omp tab, or the pty link is unproven) keeps the existing
# spinner logic, which is the weaker proof. Kept as one function so the wait
# loop and the exit-7 precheck cannot drift apart.
target_busy() {  # $1 = title, $2 = window id
  steerable_screen "$2" && return 1
  case "$(tab_state_of "$2")" in
    busy) return 0 ;;
    idle) return 1 ;;
    exited) die "window $2 has exited (its omp session file ends in session_exit) — nothing was sent" 1 ;;
  esac
  title_busy "$1" || return 1
  return 0
}
# dialog_open with the read failure turned into the exit this script promises:
# nothing sent, exit 3, go look.
dialog_or_die() {
  local rc=0
  dialog_open "$1" || rc=$?
  case "$rc" in
    0|1) return "$rc" ;;
    *) die "could not read window $1's screen (nothing was sent) — look at the window first" 3 ;;
  esac
}

TO=""; TEXT=""; FILE=""; EXPECT=""; EXPECT_GIVEN=0; TIMEOUT="${KITTY_SEND_TIMEOUT:-20}"; WAIT_IDLE=0; DEADLINE=""; QUIET=0; QUEUE=0; CANCEL=0; NOW=0; IDLE_WHEN=""
# KITTY_SEND_TIMEOUT overrides the --timeout default (test seam only, so the
# omp-tab suite can bound the session-row wait without passing a flag through
# omp-tab.sh; production never sets it).

# Queued sends live under the per-user runtime dir: one pid file and one log
# per target window, so --cancel can name exactly the waiter it kills.
QUEUE_DIR="${XDG_RUNTIME_DIR:-${TMPDIR:-/tmp}}/kitty-send"
queue_pidfile() { printf '%s/queue-%s.pid' "$QUEUE_DIR" "$1"; }
queue_logfile() { printf '%s/queue-%s.log' "$QUEUE_DIR" "$1"; }

# A bare window id as the first argument is --to:
# `kitty-send.sh 214 --text ...`. Only a bare integer is unambiguous enough
# to take; anything else still falls through to the "unknown argument" error.
case "${1:-}" in
  ''|*[!0-9]*) : ;;
  *) TO="$1"; shift ;;
esac

if [ "${1:-}" = "--list" ]; then
  kitty_up || die "kitty remote control unavailable (is this a kitty terminal with allow_remote_control on?)" 1
  printf '%-6s %s\n' "ID" "TITLE"
  win_table | while IFS=$'\t' read -r id wtitle ttitle; do
    printf '%-6s %s\n' "$id" "${ttitle:-$wtitle}"
  done
  exit 0
fi

while [ $# -gt 0 ]; do
  case "$1" in
    --to)        TO="${2:-}";        shift 2 || die "--to needs a value" ;;
    --text)      TEXT="${2:-}";      shift 2 || die "--text needs a value" ;;
    --file)      FILE="${2:-}";      shift 2 || die "--file needs a value" ;;
    --expect)    EXPECT="${2:-}"; EXPECT_GIVEN=1; shift 2 || die "--expect needs a value" ;;
    --timeout)   TIMEOUT="${2:-}";   shift 2 || die "--timeout needs a value" ;;
    --wait-idle) WAIT_IDLE="${2:-}"; shift 2 || die "--wait-idle needs a value (seconds)" ;;
    --deadline)  DEADLINE="${2:-}";  shift 2 || die "--deadline needs a value (seconds)" ;;
    --quiet)     QUIET=1; shift ;;
    --queue)     QUEUE=1; shift ;;
    --now)       NOW=1; shift ;;
    --idle-when) IDLE_WHEN="${2:-}"; shift 2 || die "--idle-when needs an ERE" ;;
    --help|-h)    usage; exit 0 ;;
    --cancel)    CANCEL=1; shift ;;
    *) die "unknown argument: $1 (try --help)" ;;
  esac
done

[ -n "$TO" ] || die "--to is required (window id or a title substring; --list shows both)"
if [ "$CANCEL" = 1 ]; then
  [ "$QUEUE" = 0 ] || die "--cancel and --queue are mutually exclusive"
  [ -z "$TEXT" ] && [ -z "$FILE" ] || die "--cancel takes only --to: it drops a queued send, it does not send"
else
  [ -n "$TEXT" ] || [ -n "$FILE" ] || die "one of --text or --file is required"
  [ -z "$TEXT" ] || [ -z "$FILE" ] || die "--text and --file are mutually exclusive"
fi
case "$WAIT_IDLE" in ''|*[!0-9]*) die "--wait-idle must be a number of seconds" ;; esac
# DEADLINE defaults to "" (unset): empty is fine, a non-number is not. The
# '' alternative above exists for WAIT_IDLE whose default is the number 0.
case "$DEADLINE" in *[!0-9]*) die "--deadline must be a number of seconds" ;; esac
# --deadline and --wait-idle are the SAME bound spelled twice (--deadline names
# the cap on an otherwise unbounded --queue wait); both given is a usage error.
if [ -n "$DEADLINE" ]; then
  [ "$WAIT_IDLE" = 0 ] || die "--wait-idle and --deadline both bound the wait — pass one, not both"
  WAIT_IDLE="$DEADLINE"
fi
if [ "$NOW" = 1 ]; then
  [ "$QUEUE" = 0 ] || die "--now and --queue are mutually exclusive (one sends into a busy target, the other waits for it)"
  [ "$WAIT_IDLE" = 0 ] || die "--now and --wait-idle/--deadline are mutually exclusive (one sends into a busy target, the other waits for it)"
fi

kitty_up || die "kitty remote control unavailable (is this a kitty terminal with allow_remote_control on?)" 1

if [ -n "$FILE" ]; then
  case "$FILE" in /*) : ;; *) die "--file must be an absolute path: a relative one resolves against the TARGET's cwd, not yours" ;; esac
  [ -f "$FILE" ] || die "no such file: $FILE"
  # Attributed and descriptive on purpose. The earlier shape ("carry it out in
  # full. Run the commands rather than reasoning about them") is the right
  # opening for a LAUNCH brief, and omp-tab.sh still sends it for that; as a
  # mid-run steer from a path the agent has never seen it is the textbook shape
  # of a prompt injection, and on 2026-09-03 an omp agent said so and refused.
  # A note that says who wrote it and what it is gets read.
  TEXT="Note from ${AGENT_SWITCHBOARD_SENDER:-another agent session}: read $FILE, a note written for you, and act on what it says."
  TEXT="$TEXT Use absolute paths and 'git -C <dir> ...'; do NOT rely on 'cd'."
  # The proof fragment must be the one part of this template that differs
  # between two sends: the file. Head and tail are identical for every --file
  # send, so with the default fragments the SECOND note to the same window is
  # always "already on screen" and reports exit 3 for a delivery that worked
  # (measured 2026-09-03, two notes twenty minutes apart). The basename is
  # distinctive per note and still a leftover if the same file is sent twice,
  # which is the case the leftover rule exists for.
  [ -n "$EXPECT" ] || EXPECT=$(basename "$FILE")
fi

# The refusal that keeps the \r rule meaningful: an embedded newline or carriage
# return would submit a truncated first line and leave the rest in the prompt.
case "$TEXT" in
  *$'\n'*|*$'\r'*) die "--text must be a single line (an embedded newline submits a truncated message and hides the rest)" ;;
esac

# Resolve the target. A title substring must match exactly one window, because
# sending an instruction to the wrong agent is worse than not sending it.
case "$TO" in
  ''|*[!0-9]*)
    matches=$(win_table | awk -F'\t' -v pat="$TO" 'index($2, pat) || index($3, pat) { print $1 "\t" ($3 == "" ? $2 : $3) }')
    n=$(printf '%s' "$matches" | grep -c . || true)
    [ "$n" -ge 1 ] || die "no kitty window matches '$TO' (try --list)"
    if [ "$n" -gt 1 ]; then
      note "'$TO' matches $n windows:"
      printf '%s\n' "$matches" >&2
      die "ambiguous target — pass the window id instead" 1
    fi
    WID=$(printf '%s' "$matches" | cut -f1)
    ;;
  *) WID="$TO" ;;
esac

# --cancel: the waiter is what is being stopped, so a dead window is not an
# error here — its waiter (if any) is killed and the pid file removed either way.
if [ "$CANCEL" = 1 ]; then
  pf=$(queue_pidfile "$WID"); lf=$(queue_logfile "$WID")
  [ -f "$pf" ] || die "nothing is queued for window $WID" 1
  qpid=$(cat "$pf" 2>/dev/null || true)
  if [ -n "$qpid" ] && kill -0 "$qpid" 2>/dev/null; then
    kill -- "-$qpid" 2>/dev/null || kill "$qpid" 2>/dev/null || true
    rm -f "$pf"
    note "cancelled the queued send to window $WID (pid $qpid). Its log says whether anything went out before that: $lf"
    exit 0
  fi
  rm -f "$pf"
  note "the queued send to window $WID had already finished (pid ${qpid:-?} is gone); its verdict is in $lf"
  exit 0
fi

[ -n "$(win_pid "$WID")" ] || die "window $WID is not alive (try --list)" 1

# --queue: hand the wait to a detached waiter and return. The waiter is this
# same script (run with KITTY_SEND_WAIT_UNBOUNDED=1 when no bound was given,
# otherwise with --wait-idle), so it sends with the same dialog check and the
# same proof; its stdout/stderr go to the log, its pid to the pid file, and it
# removes the pid file when it finishes. setsid puts it in its own process
# group, which is what lets --cancel kill the waiter and its sleep together
# by pid and touch nothing else.
if [ "$QUEUE" = 1 ]; then
  # No bound -> UNBOUNDED. The old fixed 600 s default died
  # on any tab inside a pre-push suite ("target still busy after 600s", x4 on
  # 2026-09-05); an unbounded waiter delivers whenever the tab finally goes
  # idle, and the heartbeat below keeps a long wait readable as alive.
  unbounded=0
  [ "$WAIT_IDLE" -gt 0 ] || unbounded=1
  mkdir -p "$QUEUE_DIR"
  pf=$(queue_pidfile "$WID"); lf=$(queue_logfile "$WID")
  if [ -f "$pf" ]; then
    qpid=$(cat "$pf" 2>/dev/null || true)
    if [ -n "$qpid" ] && kill -0 "$qpid" 2>/dev/null; then
      die "a send is already queued for window $WID (pid $qpid, log $lf) — nothing was sent; --cancel it or let it finish" 6
    fi
    rm -f "$pf"
  fi
  args=(--to "$WID" --timeout "$TIMEOUT")
  if [ "$unbounded" = 1 ]; then
    args+=(--wait-idle 0)
  else
    args+=(--wait-idle "$WAIT_IDLE")
  fi
  if [ -n "$FILE" ]; then args+=(--file "$FILE"); else args+=(--text "$TEXT"); fi
  [ "$EXPECT_GIVEN" = 0 ] || args+=(--expect "$EXPECT")
  # Forward --idle-when or the waiter inherits the busy check this flag exists
  # to relax, and a queued steer waits out a tab that was never working.
  [ -z "$IDLE_WHEN" ] || args+=(--idle-when "$IDLE_WHEN")
  KITTY_SEND_WAIT_UNBOUNDED="$unbounded" setsid bash -c 'exec >"$1" 2>&1; pf=$2; shift 2; "$@"; rc=$?; rm -f "$pf"; exit $rc' \
    _ "$lf" "$pf" bash "$0" "${args[@]}" </dev/null &
  qpid=$!
  printf '%s\n' "$qpid" > "$pf"
  if [ "$unbounded" = 1 ]; then
    note "queued for window $WID: waits until it goes idle (no deadline; heartbeat every ${KITTY_SEND_HEARTBEAT_S:-300}s), then sends with the usual proof (pid $qpid, log $lf)."
  else
    note "queued for window $WID: waits up to ${WAIT_IDLE}s for it to go idle, then sends with the usual proof (pid $qpid, log $lf)."
  fi
  note "cancel with: kitty-send.sh --cancel --to $WID"
  exit 0
fi

# WHEN to send. Two states of the target are read before anything is typed:
# a dialog on screen (never send: exit 4) and a spinner in the title (never
# send by default: exit 7 — wait for it with --wait-idle/--deadline/--queue,
# or accept the discard with --now). The loop runs when a bound was given OR
# the waiter was spawned unbounded (KITTY_SEND_WAIT_UNBOUNDED=1, set by
# --queue with no bound is unbounded: it never times out and logs
# a heartbeat every KITTY_SEND_HEARTBEAT_S seconds (default 300, overridable
# so the heartbeat can be tested without waiting five minutes).
WAIT_UNBOUNDED=0
[ "${KITTY_SEND_WAIT_UNBOUNDED:-0}" = 1 ] && WAIT_UNBOUNDED=1
if [ "$WAIT_IDLE" -gt 0 ] || [ "$WAIT_UNBOUNDED" = 1 ]; then
  idle_deadline=$(( $(date +%s) + WAIT_IDLE ))
  waited=0
  heartbeat_every=${KITTY_SEND_HEARTBEAT_S:-300}
  next_beat=$(( $(date +%s) + heartbeat_every ))
  while :; do
    title=$(win_title "$WID")
    [ -n "$(win_pid "$WID")" ] || die "window $WID died while waiting for it to go idle (nothing was sent)" 1
    if ! target_busy "$title" "$WID" && ! dialog_or_die "$WID"; then
      [ "$waited" -eq 0 ] || note "target went idle after ${waited}s: $title"
      break
    fi
    if [ "$WAIT_UNBOUNDED" != 1 ] && [ "$(date +%s)" -ge "$idle_deadline" ]; then
      if dialog_or_die "$WID"; then
        die "target still shows a selection dialog after ${WAIT_IDLE}s (nothing was sent) — a dialog is the human's to answer" 5
      fi
      die "target still busy after ${WAIT_IDLE}s (nothing was sent): $title" 5
    fi
    sleep 2; waited=$((waited + 2))
    if [ "$WAIT_UNBOUNDED" = 1 ] && [ "$(date +%s)" -ge "$next_beat" ]; then
      note "still waiting for window $WID to go idle after ${waited}s (nothing sent yet) — the queued send is still held; cancel with: kitty-send.sh --cancel --to $WID"
      next_beat=$(( $(date +%s) + heartbeat_every ))
    fi
  done
fi

if dialog_or_die "$WID"; then
  note "window $WID is showing a selection dialog (${DIALOG_MARKERS//|/ / })."
  note "Keystrokes sent now are hotkeys in that dialog, and the \\r selects the highlighted option."
  die "refusing to type into a dialog (nothing was sent) — answer it in the window, or pass --wait-idle N" 4
fi

# A mid-turn target: the message would land in its steering queue and the tool
# call in flight would have its result DISCARDED. That is a cost only the
# caller can weigh, so it is never paid by default: refuse unless the
# command line says --now. `die` prints regardless of --quiet, so a caller that
# silenced the notes still sees why nothing went out.
title=$(win_title "$WID")
if title_busy "$title" && steerable_screen "$WID"; then
  note "window $WID has a spinner in its title but its screen matches --idle-when: treating it as parked, not working."
fi
if target_busy "$title" "$WID"; then
  if [ "$NOW" = 1 ]; then
    note "window $WID is mid-turn (spinner in the title); --now given, so the message lands in its steering queue"
    note "and the tool call in flight will have its result DISCARDED."
  else
    note "window $WID is busy (state file says busy, or a spinner in the title): $title"
    note "A message sent now would land in its steering queue and the tool call in flight would have its result DISCARDED."
    die "refusing to send into a mid-turn target (nothing was sent) — pass --wait-idle N to hold, --queue to hold in the background, or --now to accept the discard" 7
  fi
fi

# Idle at the send or not: the busy-transition proof in the poll
# loop below only means something when the target was idle here. A target that
# was already busy (--now) being busy afterwards proves nothing about this send.
if title_busy "$title"; then WAS_BUSY_BEFORE_SEND=1; else WAS_BUSY_BEFORE_SEND=0; fi

# Proof by state: where the tab's session file is linked, the post-send poll
# waits for a NEW role:user message row past this line count, and the echo
# proof below is skipped. Unknown (no link) keeps the echo proof, which is
# the weaker proof — its verdict says so.
TAB_SESSION=""; TAB_LINES=0; STATE_KNOWN=0
if state_json=$(tab_state_json "$WID"); then
  st=$(printf '%s' "$state_json" | jq -r '.state' 2>/dev/null)
  if [ "$st" = "busy" ] || [ "$st" = "idle" ]; then
    TAB_SESSION=$(printf '%s' "$state_json" | jq -r '.session' 2>/dev/null)
    TAB_LINES=$(printf '%s' "$state_json" | jq -r '.lines' 2>/dev/null)
    case "$TAB_LINES" in ''|*[!0-9]*) TAB_LINES=0 ;; esac
    if [ -n "$TAB_SESSION" ] && [ -f "$TAB_SESSION" ]; then STATE_KNOWN=1; fi
  fi
fi

# Proof to look for. Default to the tail of the message: distinctive enough to be
# this send, and short enough not to be diluted.
#
# The comparison STRIPS ALL WHITESPACE from both sides, and that is the whole
# trick. The target wraps a long line at its own width, so `get-text` returns the
# message broken across rows at a column that has nothing to do with word
# boundaries. Measured 2026-09-02 on a 108-column omp tab: the message arrived,
# the agent acknowledged it by name, and a literal `grep -F` on the last 40
# characters still failed, because the fragment spanned a wrap. Reporting "not
# delivered" for a delivery that worked is the one wrong answer here — it invites
# a resend, and a resend is what wedges an agent.
#
# A BUSY agent is the second way this went wrong (2026-09-02). When the target
# is mid-turn the message does not echo at the prompt at all: it lands in the
# agent's steering queue, which renders it HEAD-first and elided —
# "PR is good work and it goes further than the brief…". The tail is never
# on screen, so a tail-only match reports "not delivered" for every send to an
# agent that is actually working, which is most of them. A guard that cries wolf
# on the normal case is worse than no guard here, because the documented remedy
# for a real failure is "do not resend", and a caller who learns to ignore exit 3
# will resend exactly when it matters.
#
# So: match the tail OR the head — but only a NEW appearance of either. A
# fragment that is merely PRESENT proves nothing: a message the agent consumed
# persists in full in the scrollback, so its tail, and its head, sit on screen
# indefinitely after it is gone. Two messages sharing their first 40
# characters (the natural shape of a correction) plus a send-text that failed
# silently would otherwise confirm on the FIRST message's leftovers and report
# exit 0 for a message that never arrived. That is the one wrong answer this
# guard must not give: the documented remedy for a real failure is "do not
# resend", and a false green suppresses the resend decision the guard exists to
# get right. So the screen is snapshotted BEFORE the send and a match only
# confirms when it was not there a moment ago.

# A SLASH COMMAND is the third way a delivery can be real with no fragment on
# screen. Sent to an omp prompt, `/mcp reauth Neon` never echoes: the command's
# effect REPLACES its echo — the screen read "Waiting for browser
# authentication..." while the fragment match failed, and the script reported
# exit 3 for a delivery that landed (2026-09-07). A tail/head
# fragment is structurally unavailable for these, so for text starting with `/`
# (and no explicit --expect) the proof is the screen itself: CHANGED since the
# pre-send snapshot. Weaker than a fragment — an unrelated render would also
# count — but the send only happens against an idle target (the spinner gate),
# so a change within the timeout is attributable, and the alternative was
# teaching callers to ignore exit 3. --expect restores the fragment proof when
# a command's output is predictable.
EXPECT_HEAD="" # keep set for set -u. EXPECT is NOT reset here: it may carry
# a caller-supplied fragment (--expect, or the --file basename, the one part
# of a note template that differs between two sends). Only an empty EXPECT
# derives from TEXT below; a slash command with none still carries no
# fragment (SLASH_SEND).
SLASH_SEND=0
if [ -z "$EXPECT" ]; then
  if [ "${TEXT#/}" != "$TEXT" ]; then
    SLASH_SEND=1 # effect replaces the echo: no fragment to wait for (see above)
  else
    EXPECT=$(printf '%s' "$TEXT" | tail -c 40)
    EXPECT_HEAD=$(printf '%s' "$TEXT" | cut -c1-40)
  fi
else
  EXPECT_HEAD="$EXPECT"
fi
EXPECT_SQUASHED=$(printf '%s' "$EXPECT" | tr -d '[:space:]')
EXPECT_HEAD_SQUASHED=$(printf '%s' "$EXPECT_HEAD" | tr -d '[:space:]')

# Snapshot BEFORE the send. Same read and squashing the poll loop uses, so the
# absence test compares like with like. A FAILED read is not an empty screen:
# a window with nothing on it is a real state and must stay sendable, while an
# unreadable window makes the new-appearance test impossible. Failing open on
# a failed read would degrade to the presence check this guard exists to
# remove — empty snapshot, stale head on screen, false green — so a failed
# read sends nothing and exits 3: go look. The exit status of the read is the
# test, never the emptiness of its output.
# A slash command is snapshotted even on a linked tab: it writes no session
# row, so the screen changing is its only proof.
if [ "$STATE_KNOWN" = 0 ] || [ "$SLASH_SEND" = 1 ]; then
  if ! before_screen=$(kitty @ get-text --match "id:$WID" --extent all 2>/dev/null | tr -d '[:space:]'); then
    die "could not read window $WID's screen before the send (nothing was sent) — look at the window first" 3
  fi
else
  before_screen=""
fi
if [ "$STATE_KNOWN" = 0 ] && printf '%s' "$before_screen" | grep -qF -- '[Pastedtext#'; then
# A chip on screen BEFORE the send means the composer is dirty: send-text
# would concatenate onto whatever is already in it. Only in the no-session-file branch — an omp tab proves by session
# row and never takes this path. With kitty-send's own stranded record for
# this window the leftover is recovered (Enter, wait for clear, drop the
# record, then send); without one it may be a human's draft, so nothing is
# sent and the exit is 9 with the recovery command printed verbatim.
  _chips_before=$(printf '%s' "$before_screen" | grep -oE 'Pastedtext#[0-9]+' | grep -oE '[0-9]+' | sort -nu | tr '\n' ' ' || true)
  _rec=$(stranded_file "$WID")
  _owned_chips=""; _rec_pid=""; _rec_created=""
  if [ -f "$_rec" ]; then
    _rec_pid=$(grep -E '^pid=' "$_rec" 2>/dev/null | cut -d= -f2)
    _rec_created=$(grep -E '^created=' "$_rec" 2>/dev/null | cut -d= -f2)
    _owned_chips=$(grep -E '^chips=' "$_rec" 2>/dev/null | cut -d= -f2-)
  fi
  _cur_pid=$(win_pid "$WID"); _cur_created=$(win_created "$WID")
  _owned=1
  if [ -z "$_rec_pid" ] || [ "$_rec_pid" != "$_cur_pid" ] || [ "$_rec_created" != "$_cur_created" ]; then
    _owned=0
  else
    for _c in $_chips_before; do
      case " $_owned_chips " in *" $_c "*) ;; *) _owned=0 ;; esac
    done
  fi
  if [ "$_owned" = 1 ]; then
    note "window $WID's composer already holds unsubmitted pasted text (chips ${_chips_before}) left by an earlier kitty-send — pressing Enter once to recover it"
    press_enter "$WID"
    _rec_deadline=$(( $(date +%s) + TIMEOUT ))
    _cleared=0
    while [ "$(date +%s)" -lt "$_rec_deadline" ]; do
      sleep 1
      if [ -z "$(win_pid "$WID")" ]; then break; fi
      _s=$(kitty @ get-text --match "id:$WID" --extent all 2>/dev/null | tr -d '[:space:]' || true)
      if ! printf '%s' "$_s" | grep -qF -- '[Pastedtext#'; then _cleared=1; before_screen="$_s"; break; fi
    done
    if [ "$_cleared" = 1 ]; then
      rm -f "$_rec"
      note "a stranded earlier message was recovered in window $WID: the composer is clear, sending now"
    else
      die "window $WID's composer still holds unsubmitted pasted text (chips ${_chips_before}) after Enter — nothing was sent. Do NOT send it again blind: a second send is what enqueues an empty steering message and wedges an agent. Look at the window first." 3
    fi
  else
    die "window $WID's composer already holds unsubmitted pasted text (chips ${_chips_before}; owned by kitty-send: ${_owned_chips:-none}) — nothing was sent (exit 9): it may be a human's draft, and pressing Enter blindly could submit it early. To clear it by hand: $(enter_cmd_text "$WID")" 9
  fi
fi

# THE send. Text and carriage return in ONE call — see the header. Never split.
kitty @ send-text --match "id:$WID" "$TEXT"$'\r' 2>/dev/null || true

deadline=$(( $(date +%s) + TIMEOUT ))
confirmed=0
# Unsubmitted-paste-chip tracking: ENTER_SENT bounds the extra
# Enter to one per send; saw_chip remembers a chip was seen so the failure
# below records it instead of reporting a bare timeout.
ENTER_SENT=0; saw_chip=0; chip_now=""
while [ "$(date +%s)" -lt "$deadline" ]; do
  sleep 1
  if [ -z "$(win_pid "$WID")" ]; then
    note "window $WID died after the message was sent"
    break
  fi
  # Proof by state: a NEW role:user row past the pre-send line count is the
  # tab receiving the text. Runs in place of every echo proof below, never
  # beside them: with a linked session file the screen cannot add evidence.
  if [ "$STATE_KNOWN" = 1 ]; then
    if tail -n "+$((TAB_LINES + 1))" "$TAB_SESSION" 2>/dev/null | grep -q '"role":"user"'; then
      confirmed=1; where="proved by session row (a new role:user message reached the tab's session file)"; break
    fi
    # A slash command runs in the terminal client and writes no session row
    # (measured 2026-09-12: four /join sends reported "no new role:user row"
    # although each had run). Its proof is the screen changing since the snapshot.
    if [ "$SLASH_SEND" = 1 ]; then
      slash_screen=$(kitty @ get-text --match "id:$WID" --extent all 2>/dev/null | tr -d '[:space:]')
      if [ -n "$slash_screen" ] && [ "$slash_screen" != "$before_screen" ]; then
        confirmed=1; where="screen changed after the send (slash command: it writes no session row, so the screen is its proof; weaker than a session row)"; break
      fi
    fi
  fi
  # Echo proofs below run ONLY when the state was unknown (no linked session
  # file). With a linked file the session-row check above is the whole proof:
  # the screen cannot add evidence, and every paragraph below this gate is
  # the weaker proof the header names. A failed screen read here is harmless
  # (screen stays empty, no fragment matches); the pre-send read that guards
  # the false green already ran above and still fails closed.
  if [ "$STATE_KNOWN" = 0 ]; then
  screen=$(kitty @ get-text --match "id:$WID" --extent all 2>/dev/null | tr -d '[:space:]')
  if printf '%s' "$screen" | grep -qF -- '[Pastedtext#'; then
  # An unsubmitted paste chip after the send means NOT DELIVERED, whatever
  # the fragment match below says: the trailing \r was swallowed into the
  # chip instead of submitting it. One Enter is pressed, at
  # most once per send, and only a chip gone AND the fragment echoed confirms.
    chip_now=$(printf '%s' "$screen" | grep -oE 'Pastedtext#[0-9]+' | sort -u | tr '\n' ' ' || true)
    saw_chip=1
    if [ "$ENTER_SENT" = 0 ]; then
      press_enter "$WID"
      ENTER_SENT=1
    fi
    continue
  fi
  # A match only confirms when the fragment was NOT on screen before the send:
  # presence can be a leftover, a new appearance cannot (see the comment above
  # the snapshot). A duplicate of a still-displayed message stays unconfirmed,
  # which is exit 3 — "go look" — the safe answer under the do-not-resend rule.
  if [ -n "$EXPECT_SQUASHED" ] \
     && printf '%s' "$screen" | grep -qF -- "$EXPECT_SQUASHED" \
     && ! printf '%s' "$before_screen" | grep -qF -- "$EXPECT_SQUASHED"; then
    confirmed=1; where="echoed at the prompt (weaker proof: the window has no session file to read)"; break
  fi
  if [ -n "$EXPECT_HEAD_SQUASHED" ] \
     && printf '%s' "$screen" | grep -qF -- "$EXPECT_HEAD_SQUASHED" \
     && ! printf '%s' "$before_screen" | grep -qF -- "$EXPECT_HEAD_SQUASHED"; then
    confirmed=1; where="queued as steering, the agent is mid-turn (weaker proof: the window has no session file to read)"; break
  fi
  # Slash-command proof (see the paragraph above SLASH_SEND): the echo is
  # replaced by the command's effect, so the screen CHANGING is the evidence.
  # An unchanged screen still falls through to exit 3.
  if [ "$SLASH_SEND" = 1 ] && [ -n "$screen" ] && [ "$screen" != "$before_screen" ]; then
    confirmed=1; where="screen changed after the send (slash command: its echo is replaced by its effect; weaker proof: the window has no session file to read)"; break
  fi
  # Busy-transition proof: the send only goes out against an
  # idle target (the spinner gate above refused a busy one), so a spinner
  # appearing afterwards, with the screen changed since the pre-send
  # snapshot, means the text arrived and was submitted — the target started
  # a turn on it. Measured 2026-09-09: the fragment match failed for a send
  # that had landed, because the echo had left the readable screen while the
  # target was already executing the brief. Weaker than a fragment (it names
  # no text), so the verdict says exactly that — and it is skipped when the
  # target was already busy at the send (--now), where busy-afterwards
  # proves nothing.
  if [ "$WAS_BUSY_BEFORE_SEND" = 0 ]; then
    now_title=$(win_title "$WID" 2>/dev/null || true)
    if title_busy "$now_title" && [ -n "$screen" ] && [ "$screen" != "$before_screen" ]; then
      confirmed=1; where="target started working after the send (spinner appeared; the message fragment itself was not observed — weaker proof)"; break
    fi
  fi
  fi
done

if [ "$confirmed" = 1 ]; then
  if [ "$STATE_KNOWN" = 1 ]; then
    note "delivered to window $WID — ${where:-observed on screen}"
    exit 0
  fi
  # No session file: the screen is the only proof, and a composer echoes
  # unsubmitted text too — typed, not proven submitted, never "delivered"
  # (agent-config#638 row 57). Like every unproven send this must never
  # invite a resend: the text may already sit in the composer.
  note "typed, not proven submitted in window $WID — ${where:-observed on screen} (no session file to read: nothing proves the target submitted it; look at the window before resending)"
  exit 10
fi
# A chip survived the send (and the one Enter): the message reached the text
# box but was never submitted, so this is exit 3 with the chip named — not a
# bare timeout, and never an invitation to resend. The stranding is recorded
# (window id, chip numbers, pid, created_at, time) so the NEXT send can tell
# kitty-send's own leftover from a human's draft.
if [ "$saw_chip" = 1 ]; then
  _final_chips=$(screen_chips "$WID" | tr '\n' ' ' || true)
  [ -n "$_final_chips" ] || _final_chips="$chip_now"
  mkdir -p "$(dirname "$(stranded_file "$WID")")"
  printf 'pid=%s\ncreated=%s\ntime=%s\nchips=%s\n' "$(win_pid "$WID")" "$(win_created "$WID")" "$(date +%s)" "$_final_chips" > "$(stranded_file "$WID")"
  note "sent to window $WID but its composer still holds unsubmitted pasted text (chips ${_final_chips}) — the message reached the text box and was never submitted (this stranding is recorded for the next send)."
  note "Do NOT send it again blind: a second send is what enqueues an empty steering"
  note "message and wedges an agent. Look at the window first."
  exit 3
fi

# Mid-turn at the send and still mid-turn now: the message
# sits in the steering queue and no role:user row can reach the session file
# until the tool boundary, so "not reached" would be a timing artefact.
# Pending is the truthful verdict — and like every unproven send it must
# never invite a resend.
if [ "$STATE_KNOWN" = 1 ] && [ "$WAS_BUSY_BEFORE_SEND" = 1 ]; then
  end_title=$(win_title "$WID" 2>/dev/null || true)
  end_state="unknown"
  if end_json=$(tab_state_json "$WID"); then
    end_state=$(printf '%s' "$end_json" | jq -r '.state' 2>/dev/null)
  fi
  if title_busy "$end_title" || [ "$end_state" = "busy" ]; then
    note "sent to window $WID while it was mid-turn (--now); still mid-turn after ${TIMEOUT}s, so the message is pending in its steering queue — no new role:user row can reach its session file until the tool boundary ($TAB_SESSION, was $TAB_LINES lines)."
    note "Do NOT send it again blind: a second send is what enqueues an empty steering"
    note "message and wedges an agent. Look at the window first."
    exit 8
  fi
fi
if [ "$SLASH_SEND" = 1 ]; then
  note "sent the slash command to window $WID, but its screen did not change within ${TIMEOUT}s."
  note "A slash command writes no session row, so the screen is its only proof: look at the"
  note "window for the command's effect before sending it again."
  exit 3
fi
if [ "$STATE_KNOWN" = 1 ]; then
  note "sent to window $WID but no new role:user row reached its session file within ${TIMEOUT}s ($TAB_SESSION, was $TAB_LINES lines)."
else
  note "sent to window $WID but could not observe it on screen within ${TIMEOUT}s."
fi
note "Do NOT send it again blind: a second send is what enqueues an empty steering"
note "message and wedges an agent. Look at the window first."
exit 3
