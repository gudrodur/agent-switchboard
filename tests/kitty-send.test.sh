#!/usr/bin/env bash
# Verification for kitty-send.sh's delivery confirmation.
#
# The guard has now been wrong twice, in production, in the same direction:
# it reported "could not observe it" for a message that HAD arrived. Both
# failures were about what the TARGET renders, not about the send:
#
#   * The target wrapped the line, so a literal match on the last 40
#     characters spanned the wrap and failed.
#   * 2026-09-02 — the target was an agent mid-turn, so the message landed in
#     its steering queue, which renders HEAD-first and elided
#     ("PR is good work and it goes further than the brief…"). The tail is
#     not on screen in that form at all.
#
# A false negative is the dangerous direction: the documented remedy for a real
# failure is DO NOT RESEND, because a second send enqueues an empty steering
# entry and wedges the agent. A guard that fires on the normal case teaches its
# caller to ignore exit 3, and that caller resends at the one moment it matters.
#
# The opposite error is the one this suite added the fifth case for: a FALSE
# GREEN. A consumed message persists in full in the scrollback, so a head (or
# tail) match cannot date-stamp the send it is matched against. Two messages
# sharing their first 40 characters, plus a send-text that failed silently,
# would confirm on the first message's leftovers and exit 0 for a message that
# never arrived — suppressing the resend decision the guard exists to get
# right. kitty-send.sh answers that with a pre-send snapshot: a fragment only
# confirms when it was NOT on screen a moment before the send. Case 5 pins the
# leftover shape down: the same head already on screen must yield exit 3, and
# it is shown to fail against the pre-snapshot script. Case 6 pins the read
# failure: a pre-send snapshot that cannot be READ must send nothing and exit
# 3, because an empty snapshot from a failed read would re-admit that false
# green.
#
# Cases 7-9 pin the WHEN, added after 2026-09-03: a send into a target showing
# a selection dialog types hotkeys into the dialog (an `n` opened omp's note
# field and the message went in there, mangled), so a dialog on screen must
# refuse with nothing sent; and --wait-idle must hold a send until the title's
# spinner clears, and send nothing when it never does. Shown to fail against
# the pre-change script: cases 7 and 8 and the first half of 9.
#
# Cases 13-14 pin the DEFAULT for a mid-turn target, added after a measured failure: a plain
# send into a spinner-titled window used to go through with a stderr note that
# the in-flight tool result would be discarded, and the senders never passed
# --wait-idle because nothing made them. Now it is exit 7 with nothing sent,
# and --now is the one way to send anyway. Shown to fail against the
# pre-change script: case 13 (it sent, exit 0) and the first half of 14
# (--now was an unknown option).
#
# Case 15 pins the proof order: a window WITH a linked session
# file is proven by a new role:user row, never the echo. The fixture links
# its own pty to a fabricated session file through OMP_TAB_STATE_DIR, so no
# agent is involved.
#
# So this test drives REAL kitty windows rather than fixtures — the bugs were
# all about real rendering and a fixture would have reproduced none of them.
# It creates its own throwaway windows and never touches an agent's window.
#
#   bash tests/kitty-send.test.sh
#
# Exit 0 all passed, 1 a failure, 2 could not run (no kitty remote control).

set -uo pipefail
# Overridable so the test can be run against an OLD copy of the script and
# shown to FAIL — a test that has never failed has not been tested either.
SEND="${KITTY_SEND:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../bin/kitty-send.sh}"
[ -x "$SEND" ] || { echo "cannot run: $SEND missing or not executable" >&2; exit 2; }
kitty @ ls >/dev/null 2>&1 || { echo "cannot run: kitty remote control unavailable" >&2; exit 2; }

pass=0; fail=0
WINDOWS=()
# Every fixture is launched INTO ONE THROWAWAY TAB. `kitty @ launch
# --type=window` without --match splits whichever tab is FOCUSED, and on
# 2026-09-05 that was a live omp tab: twelve fixture panes appeared around the
# agent mid-run (harmless — no keystroke went to it — but it is somebody
# else's window). --match id:<holder> puts each fixture in the holder's tab.
HOLDER=$(kitty @ launch --type=tab --dont-take-focus --tab-title "kitty-send-selftest-$$" \
  --title "kitty-send-selftest-holder-$$" sh -c "sleep 600" 2>/dev/null)
[ -n "$HOLDER" ] || { echo "cannot run: could not open the fixture tab" >&2; exit 2; }
WINDOWS+=("$HOLDER")
IN_TAB=(--match "id:$HOLDER")
# Case 6 needs kitty-send's internal `kitty` calls to fail once on one window;
# a one-shot wrapper (below) sits in WRAPDIR ahead of the real kitty in PATH.
REAL_KITTY=$(command -v kitty)
WRAPDIR=$(mktemp -d "${TMPDIR:-/tmp}/kitty-send-wrap.XXXXXX")
cleanup() {
  # Reverse order: the holder is first in the list and its tab must outlive
  # the fixtures inside it.
  local i
  for (( i=${#WINDOWS[@]}-1; i>=0; i-- )); do w="${WINDOWS[$i]}"; [ -n "$w" ] && kitty @ close-window --match "id:$w" 2>/dev/null; done
  rm -rf "${WRAPDIR:-}"
}
trap cleanup EXIT

# A window that renders `pre` and then holds without echoing anything sent to
# it — the shape of an agent that is mid-turn: nothing new can appear on its
# screen after a send, so a match can only ever be a LEFTOVER.
launch_quiet() {
  local pre="$1"
  kitty @ launch --type=window --dont-take-focus "${IN_TAB[@]}" --title "kitty-send-selftest-$$" \
    sh -c "stty -echo 2>/dev/null; printf '%s\n' \"$pre\"; sleep 120" 2>/dev/null
}

# A window that renders, for every line it receives, only the line's first
# (MSG length - 41) characters plus an ellipsis — the shape of an agent's
# steering queue, which shows a message HEAD-first and elided and never shows
# its tail. Rendering fewer than MSG length - 40 characters guarantees the
# 40-character tail fragment can never be on this screen, so only the head
# match can fire; and nothing is rendered until a line arrives, so the head is
# a NEW appearance after the send, exactly as in a real busy agent.
launch_busy() {
  local elide=$(( ${#MSG} - 41 ))
  kitty @ launch --type=window --dont-take-focus "${IN_TAB[@]}" --title "kitty-send-selftest-$$" \
    sh -c "stty -echo 2>/dev/null; printf '%s\n' 'agent is mid-turn, working'; while IFS= read -r line; do printf '%.${elide}s…\n' \"\$line\"; done" 2>/dev/null
}

# A one-shot failure for exactly one get-text call on one window: the wrapper
# delegates everything else to the real kitty and logs every call, so the test
# can assert both that the pre-send read failed AND that no send-text was
# issued afterwards. Models a transient read failure: later reads work.
launch_poisoned() {
  local wid="$1"
  cat > "$WRAPDIR/kitty" <<EOF
#!/usr/bin/env bash
if [ "\${1:-}" = "@" ] && [ "\${2:-}" = "get-text" ] && [ "\${4:-}" = "id:$wid" ] && [ ! -f "$WRAPDIR/poison-fired" ]; then
  : > "$WRAPDIR/poison-fired"
  echo "poisoned get-text failed" >&2
  exit 3
fi
echo "\$*" >> "$WRAPDIR/calls.log"
exec "$REAL_KITTY" "\$@"
EOF
  chmod +x "$WRAPDIR/kitty"
}

check() { # name expected_exit expected_substring actual_exit actual_output
  local name="$1" wantrc="$2" wantsub="$3" rc="$4" out="$5"
  if [ "$rc" = "$wantrc" ] && printf '%s' "$out" | grep -qF -- "$wantsub"; then
    echo "  PASS  $name"; pass=$((pass+1))
  else
    echo "  FAIL  $name"
    echo "        wanted exit $wantrc containing: $wantsub"
    echo "        got    exit $rc: $(printf '%s' "$out" | tr '\n' ' ' | cut -c1-160)"
    fail=$((fail+1))
  fi
}

MSG="PR is good work and it goes further than the brief asked, correctly: you found the same read-then-write class"
HEAD_ELIDED="1. ${MSG:0:98}…"

echo "kitty-send.sh delivery confirmation"

# 1. IDLE TARGET — the text echoes at the prompt, so the tail is on screen.
#    This is the case that always worked; it is here so a change that fixes the
#    busy case by breaking the simple one cannot pass.
W1=$(kitty @ launch --type=window --dont-take-focus "${IN_TAB[@]}" --title "kitty-send-selftest-$$" cat 2>/dev/null)
WINDOWS+=("$W1")
sleep 1
OUT=$("$SEND" --to "$W1" --text "$MSG" --timeout 8 2>&1); RC=$?
check "idle target is typed, not proven submitted" 10 "typed, not proven submitted" "$RC" "$OUT"
# 2. BUSY TARGET — mid-turn, so the send lands in the steering queue, which
#    renders the message HEAD-first and elided. The head appears only AFTER the
#    send; the fixture never shows the tail, so only the head match can fire.
#    This is the case that used to report a false "not delivered".
W2=$(launch_busy); WINDOWS+=("$W2")
sleep 1
OUT=$("$SEND" --to "$W2" --text "$MSG" --timeout 8 2>&1); RC=$?
check "busy target is typed, not proven submitted" 10 "typed, not proven submitted" "$RC" "$OUT"

# 3. NEGATIVE CONTROL — a window that renders an UNRELATED elided line must NOT
#    confirm. Without this, a guard that returned 0 unconditionally would pass
#    both tests above, and a delivery guard that always says yes is no guard.
W3=$(launch_quiet "1. Some entirely unrelated steering entry about something else…")
WINDOWS+=("$W3")
sleep 1
OUT=$("$SEND" --to "$W3" --text "$MSG" --timeout 4 2>&1); RC=$?
check "unrelated screen does NOT confirm" 3 "could not observe" "$RC" "$OUT"

# 4. DEAD TARGET — a window that exits must be reported as died, not as a
#    silent success and not as an ordinary timeout.
W4=$(kitty @ launch --type=window --dont-take-focus "${IN_TAB[@]}" --title "kitty-send-selftest-$$" \
      sh -c "sleep 2" 2>/dev/null)
WINDOWS+=("$W4")
sleep 3
OUT=$("$SEND" --to "$W4" --text "$MSG" --timeout 4 2>&1); RC=$?
if [ "$RC" = 1 ] || printf '%s' "$OUT" | grep -qiE "died|no window"; then
  echo "  PASS  dead target is reported, not silently confirmed"; pass=$((pass+1))
else
  echo "  FAIL  dead target: exit $RC: $(printf '%s' "$OUT" | tr '\n' ' ' | cut -c1-120)"
  fail=$((fail+1))
fi

# 5. STALE HEAD — the FALSE GREEN. The target already shows THIS message's
#    head: the leftover of a previous identical send, which persists because
#    consumed messages stay in the scrollback in full. A second send whose
#    send-text fails silently must NOT confirm on that leftover: exit 0 here
#    would tell the caller a message arrived that never did, suppressing the
#    resend decision the guard exists to get right. Before the pre-send
#    snapshot this case exited 0 as "queued as steering"; it now must fall to
#    exit 3 ("go look"), the safe answer under the do-not-resend rule.
W5=$(launch_quiet "$HEAD_ELIDED"); WINDOWS+=("$W5")
sleep 1
OUT=$("$SEND" --to "$W5" --text "$MSG" --timeout 4 2>&1); RC=$?
check "same head already on screen does NOT confirm a second send" 3 "could not observe" "$RC" "$OUT"

# 6. UNREADABLE PRE-SEND SCREEN — fails CLOSED. A failed snapshot read is not
#    an empty screen: an empty screen is a real state and must stay sendable,
#    while an unreadable window makes the new-appearance test impossible. An
#    empty snapshot from a failed read would re-admit the case-5 false green —
#    stale head present, counted as new, exit 0 — so the guard must send
#    nothing and exit 3. The one-shot wrapper fails exactly the pre-send read;
#    had the send happened, later reads would have worked and the stale head
#    below would have confirmed on presence.
W6=$(launch_quiet "$HEAD_ELIDED"); WINDOWS+=("$W6")
sleep 1
launch_poisoned "$W6"
rm -f "$WRAPDIR/calls.log"
OUT=$(PATH="$WRAPDIR:$PATH" "$SEND" --to "$W6" --text "$MSG" --timeout 4 2>&1); RC=$?
check "unreadable pre-send screen sends nothing and exits 3" 3 "nothing was sent" "$RC" "$OUT"
if grep -q "send-text" "$WRAPDIR/calls.log" 2>/dev/null; then
  echo "  FAIL  unreadable pre-send screen: a send-text was issued with no proof possible"
  fail=$((fail+1))
else
  echo "  PASS  unreadable pre-send screen: no send-text was issued"
  pass=$((pass+1))
fi

# 7. DIALOG ON SCREEN — refuses, sends NOTHING. A target showing its ask-the-
#    user widget turns every keystroke into a hotkey and the \r into Enter on
#    the highlighted option (2026-09-03: an `n` in the message opened omp's note
#    field and the rest of the text went in there, mangled). The fixture prints
#    the widget's footer and then runs `cat`, so had anything been sent it
#    would echo on screen — the absence of the echo is the second assertion.
W7=$(kitty @ launch --type=window --dont-take-focus "${IN_TAB[@]}" --title "kitty-send-selftest-$$" \
      sh -c "printf '%s\n' '│ Enter select · n note · ↑/↓ move · Esc cancel │'; exec cat" 2>/dev/null)
WINDOWS+=("$W7")
sleep 1
OUT=$("$SEND" --to "$W7" --text "$MSG" --timeout 4 2>&1); RC=$?
check "dialog on screen refuses with exit 4 and nothing sent" 4 "nothing was sent" "$RC" "$OUT"
if kitty @ get-text --match "id:$W7" --extent all 2>/dev/null | tr -d '[:space:]' | grep -qF "$(printf '%s' "$MSG" | cut -c1-40 | tr -d '[:space:]')"; then
  echo "  FAIL  dialog on screen: the message was typed into the window anyway"; fail=$((fail+1))
else
  echo "  PASS  dialog on screen: no keystroke reached the window"; pass=$((pass+1))
fi

# 8. --wait-idle WAITS OUT A SPINNER, THEN SENDS. The fixture sets a busy title
#    (braille spinner, omp's convention), clears it after 3 s, and echoes. A
#    send that ignored the title would land while "busy" and the script would
#    not report the wait; a send that never came would fail to echo.
#    No --title on these two launches: a launch-time title PINS the window
#    title and the child's OSC 2 is then ignored (measured 2026-09-03), which
#    would leave the fixture "idle" from the start and the wait untested.
W8=$(kitty @ launch --type=window --dont-take-focus "${IN_TAB[@]}" \
      sh -c "printf '\033]2;π ⠹ selftest busy\007'; sleep 3; printf '\033]2;π > selftest idle\007'; exec cat" 2>/dev/null)
WINDOWS+=("$W8")
sleep 1
OUT=$("$SEND" --to "$W8" --text "$MSG" --timeout 8 --wait-idle 20 2>&1); RC=$?
check "--wait-idle sends once the title spinner clears" 10 "went idle after" "$RC" "$OUT"

# 9. --wait-idle RUNS OUT — sends NOTHING, exit 5. The fixture keeps the spinner
#    for longer than the wait; `cat` would echo anything that slipped through.
W9=$(kitty @ launch --type=window --dont-take-focus "${IN_TAB[@]}" \
      sh -c "printf '\033]2;π ⠹ selftest stays busy\007'; exec cat" 2>/dev/null)
WINDOWS+=("$W9")
sleep 1
OUT=$("$SEND" --to "$W9" --text "$MSG" --timeout 4 --wait-idle 3 2>&1); RC=$?
check "--wait-idle that runs out exits 5 with nothing sent" 5 "nothing was sent" "$RC" "$OUT"
if kitty @ get-text --match "id:$W9" --extent all 2>/dev/null | tr -d '[:space:]' | grep -qF "$(printf '%s' "$MSG" | cut -c1-40 | tr -d '[:space:]')"; then
  echo "  FAIL  --wait-idle timeout: the message was typed into the window anyway"; fail=$((fail+1))
else
  echo "  PASS  --wait-idle timeout: no keystroke reached the window"; pass=$((pass+1))
fi

# 10. TWO --file NOTES TO THE SAME WINDOW — the second must confirm. Every
#     --file send shares its head and tail; only the path differs. With the
#     default fragments the second note is "already on screen" and reports
#     exit 3 for a delivery that worked (2026-09-03, two notes twenty minutes
#     apart). The proof for --file is therefore the basename, distinctive per
#     note. Sending the SAME file twice must still fall to exit 3: that is a
#     leftover, and the rule that catches it is the one case 5 pins.
NOTE_A=$(mktemp "${TMPDIR:-/tmp}/kitty-send-note-a.XXXXXX.md"); echo "note a" > "$NOTE_A"
NOTE_B=$(mktemp "${TMPDIR:-/tmp}/kitty-send-note-b.XXXXXX.md"); echo "note b" > "$NOTE_B"
W10=$(kitty @ launch --type=window --dont-take-focus "${IN_TAB[@]}" --title "kitty-send-selftest-$$" cat 2>/dev/null)
WINDOWS+=("$W10")
sleep 1
OUT=$("$SEND" --to "$W10" --file "$NOTE_A" --timeout 8 2>&1); RC=$?
check "first --file note is typed, not proven submitted" 10 "typed, not proven submitted" "$RC" "$OUT"
OUT=$("$SEND" --to "$W10" --file "$NOTE_B" --timeout 8 2>&1); RC=$?
check "second --file note (different file) is typed, not proven submitted" 10 "typed, not proven submitted" "$RC" "$OUT"
OUT=$("$SEND" --to "$W10" --file "$NOTE_B" --timeout 4 2>&1); RC=$?
check "same --file note sent twice stays unconfirmed" 3 "could not observe" "$RC" "$OUT"
rm -f "$NOTE_A" "$NOTE_B"

# 11. --queue RETURNS AT ONCE AND DELIVERS LATER. Same fixture as case 8: busy
#     for 3 s, then idle and echoing. The call must return in under 2 s with a
#     pid and a log; the log must later carry the delivery verdict; and the
#     message must be on the window's screen — proof the waiter sent it.
W11=$(kitty @ launch --type=window --dont-take-focus "${IN_TAB[@]}" \
      sh -c "printf '\033]2;π ⠹ selftest busy\007'; sleep 3; printf '\033]2;π > selftest idle\007'; exec cat" 2>/dev/null)
WINDOWS+=("$W11")
sleep 1
t0=$(date +%s)
OUT=$("$SEND" --to "$W11" --text "$MSG" --timeout 8 --queue --wait-idle 20 2>&1); RC=$?
t1=$(date +%s)
check "--queue returns at once with a pid and a log" 0 "queued for window" "$RC" "$OUT"
if [ $((t1 - t0)) -le 2 ]; then
  echo "  PASS  --queue returned in $((t1 - t0))s"; pass=$((pass+1))
else
  echo "  FAIL  --queue blocked for $((t1 - t0))s"; fail=$((fail+1))
fi
LOG11=$(printf '%s' "$OUT" | grep -o 'log [^)]*' | head -1 | cut -d' ' -f2)
for _ in $(seq 1 20); do grep -qE 'typed, not proven submitted|could not observe|nothing was sent' "$LOG11" 2>/dev/null && break; sleep 1; done
check "the queued send is typed once the target went idle" 0 "typed, not proven submitted" 0 "$(cat "$LOG11" 2>/dev/null)"
if kitty @ get-text --match "id:$W11" --extent all 2>/dev/null | tr -d '[:space:]' | grep -qF "$(printf '%s' "$MSG" | tail -c 40 | tr -d '[:space:]')"; then
  echo "  PASS  the queued message is on the window's screen"; pass=$((pass+1))
else
  echo "  FAIL  the queued message never reached the window"; fail=$((fail+1))
fi

# 12. --cancel KILLS THE WAITER AND NOTHING IS SENT; a second --queue to the
#     same window is refused (exit 6). Stays-busy fixture; `cat` would echo
#     anything that slipped through, so an empty screen is the second proof.
W12=$(kitty @ launch --type=window --dont-take-focus "${IN_TAB[@]}" \
      sh -c "printf '\033]2;π ⠹ selftest stays busy\007'; exec cat" 2>/dev/null)
WINDOWS+=("$W12")
sleep 1
OUT=$("$SEND" --to "$W12" --text "$MSG" --timeout 4 --queue --wait-idle 60 2>&1); RC=$?
check "--queue on a busy window returns at once" 0 "queued for window" "$RC" "$OUT"
QPID=$(printf '%s' "$OUT" | grep -o 'pid [0-9]*' | head -1 | cut -d' ' -f2)
OUT=$("$SEND" --to "$W12" --text "$MSG" --timeout 4 --queue --wait-idle 60 2>&1); RC=$?
check "a second --queue to the same window is refused with exit 6" 6 "already queued" "$RC" "$OUT"
OUT=$("$SEND" --cancel --to "$W12" 2>&1); RC=$?
check "--cancel names the waiter it killed" 0 "cancelled the queued send" "$RC" "$OUT"
sleep 1
if [ -n "$QPID" ] && ! kill -0 "$QPID" 2>/dev/null; then
  echo "  PASS  --cancel: waiter pid $QPID is gone"; pass=$((pass+1))
else
  echo "  FAIL  --cancel: waiter pid '$QPID' is still alive"; fail=$((fail+1))
fi
OUT=$("$SEND" --cancel --to "$W12" 2>&1); RC=$?
check "--cancel with nothing queued says so" 1 "nothing is queued" "$RC" "$OUT"
if kitty @ get-text --match "id:$W12" --extent all 2>/dev/null | tr -d '[:space:]' | grep -qF "$(printf '%s' "$MSG" | cut -c1-40 | tr -d '[:space:]')"; then
  echo "  FAIL  --cancel: the message was typed into the window anyway"; fail=$((fail+1))
else
  echo "  PASS  --cancel: no keystroke reached the window"; pass=$((pass+1))
fi

# 13. MID-TURN TARGET, NO FLAG — refuses, sends NOTHING, exit 7. The spinner in
#     the title is what "busy" means; `cat` would echo anything that slipped
#     through. Before this send went out with a note on stderr and the
#     target's in-flight tool result was discarded.
W13=$(kitty @ launch --type=window --dont-take-focus "${IN_TAB[@]}" \
      sh -c "printf '\033]2;π ⠹ selftest stays busy\007'; exec cat" 2>/dev/null)
WINDOWS+=("$W13")
sleep 1
OUT=$("$SEND" --to "$W13" --text "$MSG" --timeout 4 2>&1); RC=$?
check "mid-turn target without a flag is refused with exit 7" 7 "nothing was sent" "$RC" "$OUT"
check "the refusal names all three ways out" 7 "--wait-idle N to hold, --queue to hold in the background, or --now" "$RC" "$OUT"
if kitty @ get-text --match "id:$W13" --extent all 2>/dev/null | tr -d '[:space:]' | grep -qF "$(printf '%s' "$MSG" | cut -c1-40 | tr -d '[:space:]')"; then
  echo "  FAIL  mid-turn refusal: the message was typed into the window anyway"; fail=$((fail+1))
else
  echo "  PASS  mid-turn refusal: no keystroke reached the window"; pass=$((pass+1))
fi

# 14. --now SENDS INTO A MID-TURN TARGET and says what that costs. Same fixture,
#     still busy; the echo is the proof it went out. --now with --wait-idle or
#     --queue is a usage error, because the two halves contradict each other.
OUT=$("$SEND" --to "$W13" --text "$MSG" --timeout 8 --now 2>&1); RC=$?
check "--now sends into a mid-turn target, typed not proven" 10 "typed, not proven submitted" "$RC" "$OUT"
check "--now says the in-flight result is discarded" 10 "DISCARDED" "$RC" "$OUT"
OUT=$("$SEND" --to "$W13" --text "$MSG" --timeout 4 --now --wait-idle 5 2>&1); RC=$?
check "--now with --wait-idle is a usage error" 1 "mutually exclusive" "$RC" "$OUT"
OUT=$("$SEND" --to "$W13" --text "$MSG" --timeout 4 --now --queue 2>&1); RC=$?
check "--now with --queue is a usage error" 1 "mutually exclusive" "$RC" "$OUT"
# 15. PROOF BY STATE ON A REAL WINDOW. The fixture is a plain `cat`
#     window, but OMP_TAB_STATE_DIR links its pty to a fabricated session
#     file, so the send is proven by a NEW role:user row rather than the
#     echo: a steer row appended in the background confirms the delivery
#     even though the echo proof is never consulted. Shown to fail against
#     the pre-change script: without the state poll the verdict below is the
#     echo proof, never "proved by session row".
W15=$(kitty @ launch --type=window --dont-take-focus "${IN_TAB[@]}" --title "kitty-send-selftest-$$" cat 2>/dev/null)
WINDOWS+=("$W15")
sleep 1
W15_PID=$(kitty @ ls 2>/dev/null | jq -r --argjson id "$W15" '.[].tabs[].windows[] | select(.id == $id) | .pid')
W15_CWD=$(kitty @ ls 2>/dev/null | jq -r --argjson id "$W15" '.[].tabs[].windows[] | select(.id == $id) | .cwd // ""')
W15_PTS=$(readlink "/proc/$W15_PID/fd/0" 2>/dev/null | sed 's|/dev/pts/||')
STATEDIR15=$(mktemp -d "${TMPDIR:-/tmp}/kitty-send-state15.XXXXXX")
NOW15=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
NOW15MS=$(($(date +%s%3N) - 5000))
printf '{"type":"session","version":3,"id":"01selftest15","timestamp":"%s","cwd":"%s"}\n' "$NOW15" "$W15_CWD" > "$STATEDIR15/tab.jsonl"
printf '{"type":"message","id":"a15","message":{"role":"assistant","content":[{"type":"text","text":"ok"}],"stopReason":"stop","timestamp":%s}}\n' "$NOW15MS" >> "$STATEDIR15/tab.jsonl"
printf '%s\n%s\n' "$W15_CWD" "$STATEDIR15/tab.jsonl" > "$STATEDIR15/pts-$W15_PTS"
( sleep 2; printf '{"type":"message","id":"u15","message":{"role":"user","content":[{"type":"text","text":"steer"}],"timestamp":%s}}\n' "$(($(date +%s%3N)))" >> "$STATEDIR15/tab.jsonl" ) &
OUT=$(OMP_TAB_STATE_DIR="$STATEDIR15" "$SEND" --to "$W15" --text "$MSG" --timeout 8 2>&1); RC=$?
wait
check "linked session file proves the send by state" 0 "proved by session row" "$RC" "$OUT"
rm -rf "$STATEDIR15"
# 16. UNSUBMITTED CHIP AFTER THE SEND — the composer false green. The
#     fixture behaves like the host agent's composer: the send-text burst lands
#     as a `[Pasted text #1 +1 lines]` chip (the \r swallowed inside it) and
#     only an Enter keypress submits it. Before the fix this confirmed as
#     "echoed at the prompt"; now one Enter goes out and the send confirms
#     only once the chip is gone AND the fragment is echoed.
W16=$(kitty @ launch --type=window --dont-take-focus "${IN_TAB[@]}" --title "kitty-send-selftest-$$" \
  sh -c 'read -r L; printf "%s\n" "[Pasted text #1 +1 lines]"; read -r _; printf "\033[3J\033c"; printf "%s\n" "$L"; exec cat' 2>/dev/null)
WINDOWS+=("$W16")
sleep 1
OUT=$("$SEND" --to "$W16" --text "$MSG" --timeout 10 2>&1); RC=$?
check "unsubmitted chip after the send clears on Enter, typed not proven" 10 "typed, not proven submitted" "$RC" "$OUT"
if kitty @ get-text --match "id:$W16" --extent all 2>/dev/null | tr -d '[:space:]' | grep -qF "[Pastedtext#"; then
  echo "  FAIL  unsubmitted chip still on screen after a confirmed send"; fail=$((fail+1))
else
  echo "  PASS  unsubmitted chip gone after a confirmed send"; pass=$((pass+1))
fi

# 17. UNSUBMITTED CHIP THAT NEVER CLEARS — the Enter goes out once and the
#     chip stays, so this is exit 3 naming the chip and the window (never an
#     invitation to resend), and the stranding is recorded for the next send.
W17=$(kitty @ launch --type=window --dont-take-focus "${IN_TAB[@]}" --title "kitty-send-selftest-$$" \
  sh -c 'read -r L; printf "%s\n" "[Pasted text #1 +1 lines]"; exec cat' 2>/dev/null)
WINDOWS+=("$W17")
sleep 1
T17=$(mktemp -d "${TMPDIR:-/tmp}/kitty-send-t17.XXXXXX")
OUT=$(XDG_RUNTIME_DIR="$T17" "$SEND" --to "$W17" --text "$MSG" --timeout 6 2>&1); RC=$?
check "unsubmitted chip that never clears exits 3 and names the chip" 3 "chips 1" "$RC" "$OUT"
check "the unsubmitted chip verdict names the window" 3 "window $W17" "$RC" "$OUT"
check "the unsubmitted chip verdict says not to resend" 3 "Do NOT send it again blind" "$RC" "$OUT"
if [ -f "$T17/kitty-send-stranded/stranded-$W17" ] && grep -q "chips=1" "$T17/kitty-send-stranded/stranded-$W17"; then
  echo "  PASS  unsubmitted chip stranding recorded for the next send"; pass=$((pass+1))
else
  echo "  FAIL  unsubmitted chip stranding not recorded"; fail=$((fail+1))
fi
rm -rf "$T17"

# 18. UNSUBMITTED CHIP BEFORE THE SEND WITH kitty-send's OWN RECORD — the
#     composer is dirty with the leftover case 17 strands. pid, created_at
#     and every chip number match the record, so Enter recovers it, the
#     record is dropped, the new message sends and confirms.
W18=$(kitty @ launch --type=window --dont-take-focus "${IN_TAB[@]}" --title "kitty-send-selftest-$$" \
  sh -c 'printf "%s\n" "[Pasted text #1 +1 lines]"; read -r _; printf "\033[3J\033c"; read -r L; printf "%s\n" "$L"; exec cat' 2>/dev/null)
WINDOWS+=("$W18")
sleep 1
T18=$(mktemp -d "${TMPDIR:-/tmp}/kitty-send-t18.XXXXXX")
mkdir -p "$T18/kitty-send-stranded"
P18=$(kitty @ ls 2>/dev/null | jq -r --argjson id "$W18" '.[].tabs[].windows[] | select(.id == $id) | .pid')
C18=$(kitty @ ls 2>/dev/null | jq -r --argjson id "$W18" '.[].tabs[].windows[] | select(.id == $id) | .created_at // empty')
printf 'pid=%s\ncreated=%s\ntime=%s\nchips=%s\n' "$P18" "$C18" "$(date +%s)" "1 " > "$T18/kitty-send-stranded/stranded-$W18"
OUT=$(XDG_RUNTIME_DIR="$T18" "$SEND" --to "$W18" --text "$MSG" --timeout 10 2>&1); RC=$?
check "unsubmitted chip before the send with own record recovers, typed not proven" 10 "typed, not proven submitted" "$RC" "$OUT"
check "the recovery says a stranded earlier message was recovered" 10 "a stranded earlier message was recovered" "$RC" "$OUT"
if [ ! -f "$T18/kitty-send-stranded/stranded-$W18" ]; then
  echo "  PASS  unsubmitted chip record dropped after recovery"; pass=$((pass+1))
else
  echo "  FAIL  unsubmitted chip record left behind after recovery"; fail=$((fail+1))
fi
rm -rf "$T18"

# 19. UNSUBMITTED CHIP BEFORE THE SEND WITH NO RECORD — it may be a human's
#     draft, so nothing is sent (exit 9, the distinct code) and the message
#     prints the recovery command verbatim, leaving the caller a way out.
W19=$(kitty @ launch --type=window --dont-take-focus "${IN_TAB[@]}" --title "kitty-send-selftest-$$" \
  sh -c 'printf "%s\n" "[Pasted text #1 +1 lines]"; exec cat' 2>/dev/null)
WINDOWS+=("$W19")
sleep 1
T19=$(mktemp -d "${TMPDIR:-/tmp}/kitty-send-t19.XXXXXX")
OUT=$(XDG_RUNTIME_DIR="$T19" "$SEND" --to "$W19" --text "$MSG" --timeout 6 2>&1); RC=$?
check "unsubmitted chip before the send with no record sends nothing (exit 9)" 9 "nothing was sent" "$RC" "$OUT"
check "the refusal prints the recovery command for that window" 9 "--match id:$W19" "$RC" "$OUT"
if kitty @ get-text --match "id:$W19" --extent all 2>/dev/null | tr -d '[:space:]' | grep -qF "$(printf '%s' "$MSG" | cut -c1-40 | tr -d '[:space:]')"; then
  echo "  FAIL  message reached a dirty composer it should not have been sent to"; fail=$((fail+1))
else
  echo "  PASS  nothing reached the dirty composer"; pass=$((pass+1))
fi
rm -rf "$T19"

# 20. OWNED #20 BESIDE UNOWNED #21 — ownership is a SUBSET test (fourth #638
#     comment): one chip kitty-send stranded next to a human's newer draft
#     must refuse (exit 9), not press Enter and submit the draft early.
W20=$(kitty @ launch --type=window --dont-take-focus "${IN_TAB[@]}" --title "kitty-send-selftest-$$" \
  sh -c 'printf "%s\n%s\n" "[Pasted text #20 +1 lines]" "[Pasted text #21 +1 lines]"; exec cat' 2>/dev/null)
WINDOWS+=("$W20")
sleep 1
T20=$(mktemp -d "${TMPDIR:-/tmp}/kitty-send-t20.XXXXXX")
mkdir -p "$T20/kitty-send-stranded"
P20=$(kitty @ ls 2>/dev/null | jq -r --argjson id "$W20" '.[].tabs[].windows[] | select(.id == $id) | .pid')
C20=$(kitty @ ls 2>/dev/null | jq -r --argjson id "$W20" '.[].tabs[].windows[] | select(.id == $id) | .created_at // empty')
printf 'pid=%s\ncreated=%s\ntime=%s\nchips=%s\n' "$P20" "$C20" "$(date +%s)" "20 " > "$T20/kitty-send-stranded/stranded-$W20"
OUT=$(XDG_RUNTIME_DIR="$T20" "$SEND" --to "$W20" --text "$MSG" --timeout 6 2>&1); RC=$?
check "owned chip beside an unowned one refuses instead of submitting it" 9 "chips 20 21" "$RC" "$OUT"
if [ -f "$T20/kitty-send-stranded/stranded-$W20" ]; then
  echo "  PASS  mixed-ownership record kept, no recovery attempted"; pass=$((pass+1))
else
  echo "  FAIL  mixed-ownership record dropped"; fail=$((fail+1))
fi
rm -rf "$T20"

echo
# 21. SLASH COMMAND TO A LINKED TAB. The window has a session file, so a
#     normal send is proven by a new role:user row; a slash command writes
#     none, so the proof is the screen changing. A plain `cat` window linked
#     to a fabricated session echoes the command, which changes the screen.
W21=$(kitty @ launch --type=window --dont-take-focus "${IN_TAB[@]}" --title "kitty-send-selftest-$$" cat 2>/dev/null)
WINDOWS+=("$W21")
sleep 1
W21_PID=$(kitty @ ls 2>/dev/null | jq -r --argjson id "$W21" '.[].tabs[].windows[] | select(.id == $id) | .pid')
W21_CWD=$(kitty @ ls 2>/dev/null | jq -r --argjson id "$W21" '.[].tabs[].windows[] | select(.id == $id) | .cwd // ""')
W21_PTS=$(readlink "/proc/$W21_PID/fd/0" 2>/dev/null | sed 's|/dev/pts/||')
STATEDIR21=$(mktemp -d "${TMPDIR:-/tmp}/kitty-send-state21.XXXXXX")
NOW21=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
NOW21MS=$(($(date +%s%3N) - 5000))
printf '{"type":"session","version":3,"id":"01selftest21","timestamp":"%s","cwd":"%s"}\n' "$NOW21" "$W21_CWD" > "$STATEDIR21/tab.jsonl"
printf '{"type":"message","id":"a21","message":{"role":"assistant","content":[{"type":"text","text":"ok"}],"stopReason":"stop","timestamp":%s}}\n' "$NOW21MS" >> "$STATEDIR21/tab.jsonl"
printf '%s\n%s\n' "$W21_CWD" "$STATEDIR21/tab.jsonl" > "$STATEDIR21/pts-$W21_PTS"
OUT=$(OMP_TAB_STATE_DIR="$STATEDIR21" "$SEND" --to "$W21" --text "/selftest-slash-$$" --timeout 6 2>&1); RC=$?
check "slash command to a linked tab is proven by the screen" 0 "slash command" "$RC" "$OUT"
rm -rf "$STATEDIR21"

echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
