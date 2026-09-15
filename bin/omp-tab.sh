#!/usr/bin/env bash
# Launch `omp` in its OWN titled kitty tab, hand it a brief, and CONFIRM it started.
#
# --help prints everything between HELP-BEGIN and HELP-END below, never from a second copy.
# HELP-BEGIN
# Usage:
#   omp-tab.sh --title "omp: <what this review is>" --brief /abs/brief.md \
#              [--out /abs/out.md] [--overwrite] [--cwd /abs/repo] \
#              [--profile NAME | --no-profile] [--model PROVIDER/NAME] [--fallback]
#              [--tools a,b,c] [--thinking low|medium|high|…]
#              [--no-ground-truth] [--mcp full] [--slot-override "<reason>"]
#   omp-tab.sh --close <window-id>
#   omp-tab.sh --list
#   omp-tab.sh --help | -h
#
# Exit codes, all meaningful:
#   0  launched AND confirmed running
#   1  precondition failed (bad args, relative path, missing file, no provider can serve)
#   A probe that hangs (timeout rc 124) is an environment hang, not a drained provider, so it also exits 1 with nothing launched and no fallback tried.
#   2  kitty remote control unavailable — CALLER MUST FALL BACK TO HEADLESS AND SAY SO
#   3  launched but could not confirm it started (window id still printed; go look)
# HELP-END
#
# Why this exists rather than the prose recipe in $AGENT_CONFIG_HOME/skills/local-agents:
# the recipe is six steps with four non-obvious failure modes, and a delegated
# agent following prose gets it right most of the time, which is the worst
# possible hit rate for something whose failures are all SILENT:
#
#   * `send-text` reports success even when it matched NO window. The man page
#     says so outright ("errors are not reported, for technical reasons"), so
#     confirming with `get-text` is the only evidence available and is the step
#     most often skipped.
#   * A missing trailing \r leaves the text sitting in the prompt, unsubmitted.
#     No error. The run simply never starts. Sending the \r as a SECOND call is
#     not the fix and is worse: against an agent TUI it enqueues an empty
#     steering message and wedges the agent. Both traps now live in one place,
#     `kitty-send.sh`, which this script calls rather than reimplements.
#   * `sleep 12` before sending is a guess at the MCP handshake. Too short and
#     the keystrokes land in a shell that is not omp yet; this polls instead.
#   * A relative path in the brief resolves against the tab's cwd, not yours.
#     Measured 2026-08-26: same brief, two runs, one found the evidence pack and
#     one reported it missing and reconstructed from GitHub instead.
#
# It also refuses to close a window it did not launch. Borrowing another
# session's omp window is the standing trap: measured on three consecutive days,
# the only omp window on this machine belonged to a different host-agent session.
#
# Ref: $AGENT_CONFIG_HOME/skills/local-agents/SKILL.md § "DEFAULT: send it to
# a visible omp terminal" (~/.claude/skills/... before the root move — same
# root contract as agent-config P2: $AGENT_CONFIG_HOME wins, else
# ~/agent-config, else ~/.claude).

set -uo pipefail

STATE="${XDG_RUNTIME_DIR:-/tmp}/omp-tab-launched.$(id -u)"

# The sibling that owns sending. Resolved from this file rather than $PATH so a
# copy of the pair in another directory keeps working.
SEND="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/kitty-send.sh"
[ -x "$SEND" ] || { printf '%s\n' "omp-tab: missing or non-executable $SEND — this script does not send on its own" >&2; exit 1; }
STATE_TAB="$(dirname "$SEND")/omp-tab-state.sh"
# Optional key step: a command whose stdout is `export ...` lines, evaluated
# before the probe and inside the tab. Unset (the default) means no key step.
# OMP_TAB_KEY_COMMAND wins over KEY_COMMAND when both are set.
KEY_COMMAND="${OMP_TAB_KEY_COMMAND:-${KEY_COMMAND:-}}"

# $1 is the message, $2 the exit code. "$*" would print the code as part of the
# message ("... 3"), which it once did.
die()  { printf '%s\n' "omp-tab: $1" >&2; exit "${2:-1}"; }
note() { printf '%s\n' "omp-tab: $*" >&2; }

kitty_up() { kitty @ ls >/dev/null 2>&1; }

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
# Print the Usage block + exit-code table from the header above
# (`--help` used to answer 'unknown argument'). Single-sourced: the text lives
# between HELP-BEGIN/HELP-END and is sedded out, never copied.
print_help() {
  sed -n '/^# HELP-BEGIN$/,/^# HELP-END$/p' "$0" | sed -e '1d;$d' -e 's/^# \?//'
}

# --- subcommands -------------------------------------------------------------

if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
  print_help
  exit 0
fi

if [ "${1:-}" = "--list" ]; then
  kitty_up || die "kitty remote control unavailable" 2
  [ -s "$STATE" ] || { echo "(no windows launched by this script)"; exit 0; }
  # One `ls` for the whole listing, not one per row: this file is append-only,
  # so the per-row form cost a kitty subprocess per historical entry.
  live_ids=$(kitty @ ls 2>/dev/null | jq -r '.[].tabs[].windows[].id' 2>/dev/null | tr '\n' ' ')
  # Gone rows are pruned on every list, not kept: a gone id can never be acted
  # on again (--close on one just deletes the row and says "already gone"), and
  # without pruning the append-only file grows forever — one audit found 8 dead
  # rows in it. Only ids ABSENT from kitty are pruned; REUSED ids stay, since a
  # stranger may own that id now and the row is the evidence. Deletion uses the
  # same sed idiom as --close below. (The loop holds the pre-prune fd, so
  # deleting mid-loop is safe; a concurrent launch appends new lines, which the
  # id-anchored pattern never matches.)
  pruned=0
  set -f
  while IFS= read -r line; do
    # shellcheck disable=SC2086: unquoted split is the parse; globbing off via set -f.
    set -- $line
    id=${1:-}; pid=${2:-}
    # New rows mark the launcher with @; anything without the marker is a row
    # the pre-launcher script wrote, whatever its token count (a legacy title
    # has spaces, so counting fields misreads `WID PID omp: legacy title` as a
    # launcher of `omp:`). Only known-collision: a legacy title whose FIRST
    # word starts with @ — no such title has ever been written.
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
    # Gone ids are dropped, not displayed: the id is absent from kitty so no
    # consumer can act on it (--close just deletes the row and says "already
    # gone"), and showing it re-creates the junk-drawer listing. The
    # stderr count below keeps the signal.
    if [ "$s" = "gone" ]; then
      [ -n "$id" ] && sed -i "/^$id /d" "$STATE" 2>/dev/null && pruned=$((pruned + 1))
      continue
    fi
    # Proof by state on every row: the tab's session file says idle,
    # busy (with the tool), exited or unknown. Missing script or a failed
    # read keeps the row but says so; a row is never dropped for it.
    stab="state=? tool=- age=-"
    if [ -x "$STATE_TAB" ]; then
      stline=$("$STATE_TAB" "$id" 2>/dev/null | sed -n 's/^window [0-9]* //p')
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
  exit 0
fi

if [ "${1:-}" = "--close" ]; then
  [ -n "${2:-}" ] || die "--close needs a window id"
  case "$2" in *[!0-9]*|"") die "--close takes a numeric window id, got: $2" ;; esac
  kitty_up || die "kitty remote control unavailable" 2

  # The whole point: only ever close what this script started.
  row=$(grep "^$2 " "$STATE" 2>/dev/null | head -1)
  [ -n "$row" ] \
    || die "window $2 was not launched by this script — refusing to close it.
        Another host-agent session's omp window looks identical in \`kitty @ ls\`;
        closing it interrupts work you cannot see."

  want_pid=$(printf '%s' "$row" | awk '{print $2}')
  now_pid=$(win_pid "$2")

  if [ -z "$now_pid" ]; then
    # Not an error worth an exit code, but it must not be reported as a closure.
    sed -i "/^$2 /d" "$STATE" 2>/dev/null
    note "window $2 was already gone — nothing to close (state row removed)"
    exit 0
  fi

  # An id outlives the process that owned it. The state file lives in tmpfs and
  # survives a kitty restart, while kitty's id counter starts over, so a stale
  # row can name a window this script never launched. The pid is the identity
  # that cannot be recycled underneath us.
  if [ -n "$want_pid" ] && [ "$want_pid" != "$now_pid" ]; then
    die "window $2 is NOT the one this script launched — id reused.
        state recorded pid $want_pid, that id now belongs to pid $now_pid.
        Refusing; remove the stale row by hand if you are sure."
  fi

  if kitty @ close-window --match "id:$2" 2>/dev/null; then
    note "closed window $2"
  else
    # Measured: close-window exits 1 with `Error: No matching windows` and the
    # old code discarded both the status and the message, then said "closed".
    note "close-window FAILED for $2 — the window may still be open; go look"
  fi
  sed -i "/^$2 /d" "$STATE" 2>/dev/null
  exit 0
fi

# --- launch ------------------------------------------------------------------

TITLE=""; BRIEF=""; OUT=""; CWD="$PWD"
# DEFAULT: no profile. `--profile NAME` is opt-in, and the reason is a defect
# this script shipped and then caught on 2026-08-28.
#
# Lean MCP is the default (see --mcp below): the tab starts with no MCP
# servers at all, so there is no handshake and no
# `Failed: Neon … HTTP 401 {"error":"invalid_token"}` line. That 401 was
# correct behaviour under full discovery, not a broken config: the Neon
# server is OAuth and omp holds no token where the host agent does.
#
# A profile was tried as the cure and is NOT one here. A headless
# `-p --profile NAME` run does emit zero MCP lines, which is what the
# local-agents skill measured and what sent me down this path -- but an
# INTERACTIVE tab launched with the same profile still ran the full handshake
# and still printed the Neon 401 (observed in the tab, 2026-08-28). Whatever a
# profile does for the headless form, it does not suppress MCP for this one.
#
# But a FRESH profile has never been through onboarding, so an INTERACTIVE
# launch lands on omp's five-step setup wizard rather than a prompt -- and the
# readiness and confirmation checks below both matched text INSIDE that wizard,
# so this script reported "confirmed running" about a tab that was blocked.
# (A headless `-p --profile` run skips the wizard, which is why the first test
# passed and hid this.) Worse, a fresh profile carries no modelRoles, so it came
# up on **DeepSeek V4 Pro** -- a silent model swap, which is a worse failure than
# a noisy handshake.
#
# Do NOT read that as "the bare launch gives Flash". A bare launch gives whatever
# `modelRoles.default` in ~/.omp/agent/config.yml says at that instant, and that
# is a value a human edits: on 2026-09-07 alone it read glm-5.3-flash, then
# muse-spark-1.3-contributor, then opencode-go/deepseek-v4-flash (measured 22:45,
# splash "DeepSeek V4 Flash / opencode-go"). Naming a model here would be stale
# within hours; the mechanism is the durable fact. Note also that the provider is
# part of the identity: `opencode-go/deepseek-v4-flash` is not
# `deepseek/deepseek-v4-flash`, and the skill's prices were measured on the
# latter.
#
# So: bare by default, and pin the model rather than trust the default. Use
# `--profile NAME` only with a profile you have already taken through setup once
# by hand — the pin below verifies the launch automatically, so neither a fresh
# profile's V4 Pro nor an edited `modelRoles.default` can pass unnoticed.
PROFILE=""
# Launch model: unset by default, so the tab inherits `modelRoles.default` from
# ~/.omp/agent/config.yml. Pass --model to override.
#
# This WAS pinned to deepseek/deepseek-v4-flash (3fb60a2), for two reasons that
# are both still true and neither of which survives the third:
#
#   1. An unpinned launch follows a value a human edits. On 2026-09-07 alone
#      `modelRoles.default` read opencode-go/glm-5.3-flash, then
#      opencode-go/muse-spark-1.3-contributor, then opencode-go/deepseek-v4-flash
#      A delegated run's model is therefore whatever was last typed.
#   2. The status-bar check below compares model NAMES, so it cannot tell
#      opencode-go/deepseek-v4-flash from deepseek/deepseek-v4-flash. It verifies
#      the model, never the provider. The `model:` line it prints is advisory.
#   3. But pinning a provider means pinning one that can run out, and on
#      2026-09-08 it did: DeepSeek at -$0.03, every delegated tab 402 on every
#      request, rescued only by a human noticing and typing /model
#      A pin cannot notice that; a default that follows the
#      account can at least be pointed somewhere solvent in one place.
#
# So: inherit, and make the failure loud instead. The preflight below proves the
# provider the launch resolves to can serve — whatever provider it is, by the
# check omp-providers.json names for it — and when the DEFAULT cannot, walks
# that file's `fallback` list and says so. An explicit --model that cannot serve
# is refused, not swapped: a --model is a contract, and --fallback is the caller
# saying the next usable entry is acceptable. The status line prints
# `launched as provider/model` because the status bar names the model and never
# the provider: opencode-go/deepseek-v4-flash and deepseek/deepseek-v4-flash
# render identically there.
# A second half: flash reports `images: no`, so a run that
# must look at screenshots passes a vision-capable model explicitly.
MODEL=""
# --fallback: when the --model above cannot serve, take the next usable entry in
# omp-providers.json instead of refusing. Off by default — see above.
FALLBACK=""
# --tools is an ALLOWLIST and omitting it enables EVERYTHING, including `todo`.
# Given a plan tool, omp plans: a 315-image describe run spent 40 minutes on 5
# images because it was maintaining a checklist and re-shelling per row, which
# projected to 42 hours (2026-08-28). The local-agents skill has warned about this
# since 2026-08-23; the launcher gave no way to act on the warning.
# --thinking is the other half: `high` is right for a review and wasteful for
# mechanical description, which is what an image sweep is.
TOOLS=""
THINKING=""
MCP_FULL=""
NO_GT=""
OVERWRITE=""
SLOT_OVERRIDE=""
LAUNCH_ARGV=("$@")
# Retry guard (agent-config#696): the first-turn-abort check below re-execs this
# script once with OMP_TAB_ATTEMPT=2. Internal only, never a CLI flag.
ATTEMPT="${OMP_TAB_ATTEMPT:-1}"
while [ $# -gt 0 ]; do
  case "$1" in
    # `shift 2` with one parameter left FAILS (status 1) and leaves $# UNCHANGED,
    # so without the `||` the loop re-enters on the same argument forever. It is
    # a hang with no output at all -- `set -u` cannot see it, because a failing
    # builtin is not an unbound variable. Measured 2026-08-28:
    # `timeout 2 omp-tab.sh --title` exited 124 having printed nothing.
    --title) TITLE="${2:-}"; shift 2 || die "--title needs a value" ;;
    --brief) BRIEF="${2:-}"; shift 2 || die "--brief needs a value" ;;
    --out)   OUT="${2:-}";   shift 2 || die "--out needs a value" ;;
    --cwd)   CWD="${2:-}";   shift 2 || die "--cwd needs a value" ;;
    --profile) PROFILE="${2:-}"; shift 2 || die "--profile needs a value" ;;
    --model) MODEL="${2:-}"; shift 2 || die "--model needs a value" ;;
    --tools) TOOLS="${2:-}"; shift 2 || die "--tools needs a value" ;;
    --thinking) THINKING="${2:-}"; shift 2 || die "--thinking needs a value" ;;
    --mcp) case "${2:-}" in full) MCP_FULL=1; shift 2 ;; *) die "--mcp takes one value: full (lean is the default; --mcp full restores today's full MCP discovery)" ;; esac ;;
    --no-profile) PROFILE=""; shift ;;
    --fallback) FALLBACK=1; shift ;;
    --overwrite) OVERWRITE=1; shift ;;
    --help|-h) print_help; exit 0 ;;
    --no-ground-truth) NO_GT=1; shift ;;
    --slot-override) SLOT_OVERRIDE="${2:-}"; [ -n "$SLOT_OVERRIDE" ] || die "--slot-override needs a reason (it is printed on launch, so the overlap is visible to the other seat)" ; shift 2 || die "--slot-override needs a value" ;;
    *) die "unknown argument: $1" ;;
  esac
done

[ -n "$TITLE" ] || die "--title is required. Name it after the WORK, not the tool:
        \"omp: nafnahefð yfirferð\" beats \"omp\". It is the only label the
        user gets while several things run at once."
[ -n "$BRIEF" ] || die "--brief is required (absolute path to the brief file)"

case "$BRIEF" in /*) ;; *) die "--brief must be ABSOLUTE, got: $BRIEF
        A relative path resolves against the tab's cwd, not yours." ;; esac
[ -f "$BRIEF" ] || die "brief not found: $BRIEF"
if [ -n "$OUT" ]; then
  case "$OUT" in /*) ;; *) die "--out must be ABSOLUTE, got: $OUT" ;; esac
fi
[ -d "$CWD" ] || die "--cwd is not a directory: $CWD"

# A newline in any of these silently breaks a one-line invariant: TITLE would
# write a second state row (a phantom id `--close` could later act on), and
# BRIEF/OUT would split the instruction at send time so the trailing \r submits
# a truncated path. Both are the same silent misdelivery the \r rule exists to
# prevent, so reject them here rather than discover them in the tab.
for v in "$TITLE" "$BRIEF" "$OUT"; do
  case "$v" in *$'\n'*|*$'\r'*) die "--title/--brief/--out must each be a single line" ;; esac
done
if [ -n "$OUT" ] && [ -z "$OVERWRITE" ] && [ -s "$OUT" ]; then
  die "--out $OUT already exists and is non-empty. Pass --overwrite to reuse it or choose a new path. Nothing was launched."
fi
# Preflight the provider before opening the tab. A 402 is cheap to detect here
# and expensive to discover forty minutes later in a tab that looks alive and
# produces nothing.
# omp itself never falls back across providers on a 402 (measured 2026-09-08:
# an explicit deepseek model dies exit 1), so this is the only fallback there is.
#
# Which check, per provider, comes from omp-providers.json beside this script:
#   balance  DeepSeek's balance endpoint — ~0.5 s, no tokens, and it reports the
#            figure and the top-up link.
#   probe    a one-word `omp -p` request on the model itself — ~4-5 s and a few
#            tokens (measured 2026-09-09: 4.4 s OK on opencode-go, 2.8 s and
#            `402 Insufficient Balance` on deepseek). The only honest check for a
#            provider with no entitlement endpoint, and it works for one the
#            table has never heard of, which is what makes adding one cheap.
# A provider with `enabled: false` is refused before any check and skipped by
# the fallback walk — that is how one is switched off.
PROVIDERS_JSON="${OMP_TAB_PROVIDERS:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../config/omp-providers.json}"
# Test seam only: seconds the probe below may run before `timeout` kills it
# with rc 124. Production always uses the 60 s default.
PROBE_TIMEOUT="${OMP_TAB_PROBE_TIMEOUT:-60}"
[ -r "$PROVIDERS_JSON" ] || die "provider table not readable: $PROVIDERS_JSON"
# tbl fallback | tbl enabled <provider> | tbl field <provider> <key> | tbl allowed | tbl has_allowed
tbl() {
  python3 - "$PROVIDERS_JSON" "$@" <<'PY'
import json, sys
t = json.load(open(sys.argv[1])); op = sys.argv[2]; a = sys.argv[3:]
p = t.get("providers", {})
if op == "fallback":
    print("\n".join(t.get("fallback", [])))
elif op == "enabled":
    print("yes" if p.get(a[0], {}).get("enabled", True) else "no")
elif op == "field":
    print(p.get(a[0], {}).get(a[1], ""))
elif op == "allowed":
    print("\n".join(t.get("allowedModels", [])))
elif op == "has_allowed":
    print("yes" if "allowedModels" in t else "no")
PY
}

# What a bare launch resolves to, so a refusal and the status line can name a
# provider/model rather than "the default". Read, not assumed: it is a value a
# human edits (three different models on 2026-09-07 alone).
OMP_CFG="${OMP_TAB_CONFIG:-$HOME/.omp/agent/config.yml}"
DEFAULT_MODEL="$(sed -n 's/^[[:space:]]*default:[[:space:]]*\([^[:space:]#]*\).*/\1/p' "$OMP_CFG" 2>/dev/null | head -1)"
DEFAULT_MODEL="${DEFAULT_MODEL%%:*}"   # `provider/model:high` carries the thinking level
# An emptied default reads as `""` or `''`, not empty — strip both so the
# refusal below sees them. (A missing `default:` line already reads empty.)
case "$DEFAULT_MODEL" in '""'|"''") DEFAULT_MODEL="" ;; esac

# A refusal, not a fallback: with no `modelRoles.default` and no
# --model, the tab launches on whatever omp picks and the status bar cannot
# name it — the script printed "model: <status bar names no model> — launched
# as <unreadable default>" and exited 0 while supervisor 6 ran 67 s on
# anthropic/claude-opus-4-8. A bare launch with no readable default launches
# nothing. There is nothing to fall back from, so --fallback does not apply.
if [ -z "$MODEL" ] && [ -z "$DEFAULT_MODEL" ]; then
  die "no modelRoles.default in $OMP_CFG and no --model was passed — nothing launched.
        A bare launch would run on a model this script cannot name or verify.
        Set modelRoles.default in $OMP_CFG or pass --model provider/model."
fi

# When KEY_COMMAND is set the tab runs `eval "$(KEY_COMMAND)" && exec omp`, so
# the probe runs in the same environment or it proves nothing about the tab.
# Unset means no key step: the probe and the tab inherit this environment.
KEY_FAILED=""
KEY_PREFIX=""
if [ -n "$KEY_COMMAND" ]; then
  if ! eval "$($KEY_COMMAND 2>/dev/null)"; then
    note "WARNING: KEY_COMMAND failed — a balance-checked launch will be refused below"
    KEY_FAILED=1
  fi
  KEY_PREFIX="eval \"\$($KEY_COMMAND)\" && "
fi

# Every headless probe below is a session-less omp run, and every omp run
# fires its session_start hook — so an unisolated probe registers a presence
# beacon with this shell's KITTY_WINDOW_ID (session id null), which makes
# window-addressed mail to the launcher ambiguous until it ages out. Run each
# probe with no window id and throwaway store paths, so even an older hook on
# any machine registers nothing and leaves nothing behind. Result handling
# stays with the caller; stdin/redirection pass through to omp.
probe_omp() {
  local probe_tmp rc
  probe_tmp="$(mktemp -d "${TMPDIR:-/tmp}/omp-tab-probe-XXXXXX")"
  env -u KITTY_WINDOW_ID \
    "AGENT_SWITCHBOARD_DB=$probe_tmp/state.db" \
    "AGENT_SWITCHBOARD_DIR=$probe_tmp/switchboard" \
    "XDG_STATE_HOME=$probe_tmp/xdg" \
    "AGENT_SWITCHBOARD_MAILBOX_DIR=$probe_tmp/mailbox" \
    "AGENT_MAILBOX_DIR=$probe_tmp/mailbox" \
    "AGENT_SWITCHBOARD_PRESENCE_FILE=$probe_tmp/presence.json" \
    "AGENT_MAILBOX_PRESENCE_FILE=$probe_tmp/presence.json" \
    timeout "$PROBE_TIMEOUT" omp "$@"
  rc=$?
  rm -rf "$probe_tmp"
  return "$rc"
}

# preflight MODEL — returns 0 if the provider can serve, else 1 with the reason
# in PF_REASON. An empty MODEL probes the bare launch, which is what the tab
# would run.
PF_REASON=""
preflight() {
  local m="$1" prov="" chk="" out rc url bal
  PF_REASON=""
  case "$m" in
    */*) prov="${m%%/*}" ;;
    "")  case "$DEFAULT_MODEL" in */*) prov="${DEFAULT_MODEL%%/*}" ;; esac ;;
  esac
  if [ -n "$prov" ] && [ "$(tbl enabled "$prov")" = no ]; then
    PF_REASON="provider $prov is switched off in $PROVIDERS_JSON"; return 1
  fi
  [ -n "$prov" ] && chk="$(tbl field "$prov" check)"
  case "$chk" in
    balance)
      if [ -n "$KEY_FAILED" ]; then PF_REASON="no key from KEY_COMMAND, so the balance cannot be read"; return 1; fi
      url="$(tbl field "$prov" balanceUrl)"
      out="$(curl -s -m 10 -H "Authorization: Bearer ${DEEPSEEK_API_KEY:-}" "$url" 2>/dev/null)"
      if [ -z "$out" ]; then PF_REASON="balance endpoint $url unreachable"; return 1; fi
      bal="$(printf '%s' "$out" | python3 -c 'import json,sys
try:
    d = json.load(sys.stdin)
    avail = d.get("is_available", False)
    infos = d.get("balance_infos", [{}])
    total = float(infos[0].get("total_balance", 0))
    print(("OK" if (avail and total > 0) else "DEAD") + " " + str(total))
except Exception:
    print("UNPARSEABLE")
' 2>/dev/null)"
      case "$bal" in
        OK*) return 0 ;;
        DEAD*) PF_REASON="balance ${bal#DEAD } and is_available false — top up at $(tbl field "$prov" topUp)"; return 1 ;;
        *) PF_REASON="balance endpoint returned something unparseable: $out"; return 1 ;;
      esac ;;
    *)
      # `--tools read` because --tools is an allowlist defaulting to ALL; the
      # probe must not be able to write. cwd is $CWD so the MCP config the tab
      # will see is what gets exercised (measured 2026-09-09: 5.4 s inside a
      # project with a .mcp.json, 4.4 s outside one).
      if [ -n "$m" ]; then
        out="$(cd "$CWD" && probe_omp -p --no-session --model "$m" --tools read \
               <<< "Reply with exactly the word OK and nothing else." 2>&1)"; rc=$?
      else
        out="$(cd "$CWD" && probe_omp -p --no-session --tools read \
               <<< "Reply with exactly the word OK and nothing else." 2>&1)"; rc=$?
      fi
      [ "$rc" -eq 0 ] && return 0
      if [ "$rc" -eq 124 ]; then
        die "preflight: probe of ${m:-"default $DEFAULT_MODEL"} hung for $PROBE_TIMEOUT s; nothing launched. A hang is the environment (MCP discovery has wedged headless omp before), not the provider, so no fallback was tried. Re-run; if it repeats, run 'omp -p --no-session --tools read' by hand and watch stderr."
      else
        PF_REASON="omp exited $rc: $(printf '%s\n' "$out" | grep -v '^[[:space:]]*$' | grep -v '^Working' | tail -1)"
      fi
      return 1 ;;
  esac
}

# Walk the table's fallback list, skipping the model that failed and any
# switched-off provider. Sets MODEL so the tab is launched with --model
# explicitly and the post-launch status-bar check verifies it took.
fallback_walk() {
  local failed="$1" why="$2" c tried
  tried="$failed — $why"
  while IFS= read -r c; do
    [ -n "$c" ] || continue
    [ "$c" = "$failed" ] && continue
    if preflight "$c"; then
      MODEL="$c"; EFFECTIVE="$c"
      note "FALLBACK: $failed cannot serve ($why) — launching on $c instead"
      return 0
    fi
    tried="$tried
        $c — $PF_REASON"
  done < <(tbl fallback)
  die "no provider can serve — nothing launched. Tried, in order:
        $tried
        Edit $PROVIDERS_JSON to add or re-enable one."
}

if [ -n "$MODEL" ]; then
  EFFECTIVE="$MODEL"
  if preflight "$MODEL"; then
    note "preflight: $MODEL can serve"
  elif [ -n "$FALLBACK" ]; then
    fallback_walk "$MODEL" "$PF_REASON"
  else
    die "--model $MODEL cannot serve: $PF_REASON
        Nothing launched. A --model is a contract, so it is refused rather than
        swapped. Pass --fallback to take the next usable entry in
        $PROVIDERS_JSON, or launch without --model for the account default."
  fi
else
EFFECTIVE="$DEFAULT_MODEL"   # non-empty: the refusal above guarantees it
  if preflight ""; then
    note "preflight: default $EFFECTIVE can serve"
  else
    fallback_walk "$EFFECTIVE" "$PF_REASON"
  fi
fi
# The allowlist tabs under an agent run
# the allowlisted model only, and modelRoles.default is a
# value a human edits, so the check runs on EFFECTIVE — whatever the launch
# resolved to, whether from --model, the default, or the fallback walk — and
# BEFORE anything is launched. A missing allowedModels key means no allowlist
# (old behaviour), said once so the absence is visible rather than silent.
if [ "$(tbl has_allowed)" = yes ]; then
  ALLOWED_HIT=0
  while IFS= read -r _allow; do
    [ -n "$_allow" ] || continue
    [ "$_allow" = "$EFFECTIVE" ] && ALLOWED_HIT=1
  done < <(tbl allowed)
  if [ "$ALLOWED_HIT" != 1 ]; then
    die "model $EFFECTIVE is not in allowedModels in $PROVIDERS_JSON — nothing launched.
        Tabs under an agent run the allowlisted model only. Set modelRoles.default
        in $OMP_CFG to an allowlisted model, or pass --model with one."
  fi
else
  note "no allowedModels key in $PROVIDERS_JSON: no allowlist, any model may launch (old behaviour)"
fi

kitty_up || die "kitty remote control unavailable.
        Fall back to a headless run and SAY SO to the user, rather than letting
        a silent headless run look like the default:
          omp -p --no-session --profile <name> \\
            ${MODEL:+--model $MODEL }--thinking high \\
            --tools read,grep,glob,lsp,bash,web_search \\
            < $BRIEF > ${OUT:-out.md} 2> err.log" 2

# Advisory, never fatal. An idle omp holds ~350 MB; on 2026-08-26 one left open
# beside two host-agent sessions helped fill 8 GB of swap and a CI job was OOM-killed.
avail=$(awk '/MemAvailable/{printf "%.1f", $2/1048576}' /proc/meminfo 2>/dev/null || echo "?")
case "$avail" in ?*) awk -v a="$avail" 'BEGIN{exit !(a+0 < 1.5)}' \
  && note "WARNING: only ${avail} GiB available. omp needs ~350 MB; consider closing something first." ;; esac

# A refusal, not a warning: an agent's first turn is the expensive
# one to get wrong (it infers a date, a branch, what is already fixed), and a
# note printed beside the launch scrolls by as commentary. So a brief without
# the literal words GROUND TRUTH launches nothing. --no-ground-truth overrides
# deliberately at the call site, the same shape as kitty-send.sh's --now.
# BREAKING: callers whose briefs lack the block must add it or pass the flag.
if grep -q 'GROUND TRUTH' "$BRIEF"; then
  :
elif [ -n "$NO_GT" ]; then
  note "proceeding without a GROUND TRUTH block (--no-ground-truth was passed).
        The agent gets no clock, no network state and no idea what you fixed an
        hour ago. Left to infer, it infers confidently and wrongly."
else
  die "brief has no GROUND TRUTH block (the check is literal: a line containing
        the words GROUND TRUTH; a block headed Verified facts or Context does not count).
        It has no clock, no network state and no idea what you fixed an hour
        ago. Left to infer, it infers confidently and wrongly. Template:
        your agent-launch docs, search for GROUND TRUTH.
        Pass --no-ground-truth if you mean it. Nothing was launched."
fi

# Validate --tools against omp itself before opening the window. An
# unknown name kills the tab within seconds, the window's text is gone by the
# time the poll notices, and the vanish message below could only guess — it
# guessed the key step while the real error was `Unknown tool in --tools:
# browser`. So a non-empty --tools gets one headless probe first, stdin closed
# (an open stdin blocks: readPipedInput waits forever). Costs one omp cold
# start (~3 s, MCP discovery dominates) and only when --tools is passed; a
# bare launch names nothing and skips this entirely.
if [ -n "$TOOLS" ]; then
  TOOLS_OUT="$(cd "$CWD" && probe_omp -p --no-session --tools "$TOOLS" </dev/null 2>&1)"; TOOLS_RC=$?
  if [ "$TOOLS_RC" -eq 124 ]; then
    die "preflight: --tools probe hung for $PROBE_TIMEOUT s; nothing launched. A hang is the environment, not the flag — re-run, and if it repeats run the probe by hand with stdin closed (< /dev/null)."
  elif [ "$TOOLS_RC" -ne 0 ]; then
    case "$TOOLS_OUT" in
      *"Unknown tool"*)
        die "bad --tools: $(printf '%s\n' "$TOOLS_OUT" | grep -o 'Unknown tools\? in --tools: [^.]*\.' | head -1)
        Nothing launched. Name only tools omp accepts (measured 18.1.17: read grep glob bash write edit lsp task todo web_search plus mcp__* — not browser notebook python computer ask, though omp --help still lists them)." ;;
      *)
        die "--tools probe failed: omp exited $TOOLS_RC: $(printf '%s\n' "$TOOLS_OUT" | grep -v '^[[:space:]]*$' | grep -v '^Working' | tail -1)
        Nothing launched." ;;
    esac
  fi
fi

# --mcp: lean by default, full on request. Every omp startup spawns one
# process per discovered MCP server (measured 2026-09-12: 13 descendants
# holding ~310 MB on a live tab), so five idle tabs pin ~1.5 GB — on a box that
# ran out of memory three times that day. A delegated tab drives from its
# brief file and coordinates over omp hooks, not MCP, so the launch carries
# a `--config` overlay (beside this script) that disables third-party MCP
# discovery per launch: the live config.yml is untouched. `--mcp full`
# skips the overlay and restores today's full discovery. The overlay is
# NOT passed to the --tools probe above: that gate validates names omp
# accepts, and under lean the mcp__* names would not resolve.
LEAN_YML="${OMP_TAB_LEAN_YML:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../config/omp-tab-lean.yml}"
if [ -z "$MCP_FULL" ]; then
  [ -r "$LEAN_YML" ] || die "lean MCP overlay not readable: $LEAN_YML"
fi
OMP_ARGS=""
[ -z "$MCP_FULL" ] && OMP_ARGS="--config $LEAN_YML"
[ -n "$PROFILE" ] && OMP_ARGS="$OMP_ARGS --profile $PROFILE"
[ -n "$MODEL" ] && OMP_ARGS="$OMP_ARGS --model $MODEL"
[ -n "$TOOLS" ] && OMP_ARGS="$OMP_ARGS --tools $TOOLS"
[ -n "$THINKING" ] && OMP_ARGS="$OMP_ARGS --thinking $THINKING"
# Who launched this: the state file is per-uid, so without this every row reads
# as "what THIS script launched" while belonging to any session on the machine
# (measured once: 8 dead rows plus 2 live tabs of the other session). Prefer the
# session id where the environment carries one (the host agent sets
# CLAUDE_SESSION_ID — env name owned by the runtime, not renamed here; measured
# 2026-09-09: absent in this harness, so checked, not assumed); otherwise the
# kitty window the launcher ran in (KITTY_WINDOW_ID — always set inside a kitty
# window). One token: the file is space-separated, one row per line.
LAUNCHER="${CLAUDE_SESSION_ID:-${KITTY_WINDOW_ID:-}}"
LAUNCHER=$(printf '%s' "$LAUNCHER" | tr -d ' \t\r\n@')
[ -n "$LAUNCHER" ] || LAUNCHER=unknown

# ── the one-slot gate (#699) ────────────────────────────────────────────────
# One package tab per box, shared by every session. As a paragraph this was
# broken the day it was sent: on 2026-09-14 window 67 launched while another
# seat's window 66 was live, two minutes after a `--list` read, and the seat's
# own retro recorded it. So it is a gate now.
#
# The slot frees when a tab CLOSES, not when it goes idle: liveness is kitty's
# id list plus an unchanged pid — the same test `--list` uses — because a kitty
# id can be REUSED by a new instance and a swapped pid means a stranger owns it.
# A row this launcher wrote is not a holder: our own tabs are the point.
slot_holders() {
  [ -s "$STATE" ] || return 0
  live_ids=$(kitty @ ls 2>/dev/null | jq -r '.[].tabs[].windows[].id' 2>/dev/null | tr '\n' ' ')
  set -f
  while IFS= read -r row; do
    # shellcheck disable=SC2086: unquoted split is the parse; globbing off via set -f.
    set -- $row
    row_id=${1:-}
    case "${3:-}" in @*) row_launcher=${3#@} ;; *) row_launcher=unknown ;; esac
    case " $live_ids " in *" $row_id "*) ;; *) continue ;; esac
    [ "$(win_pid "$row_id")" = "${2:-}" ] || continue
    [ "$row_launcher" = "$LAUNCHER" ] && continue
    printf '%s (launcher %s)' "$row_id" "$row_launcher"
  done < "$STATE"
  set +f
}

if [ -z "$SLOT_OVERRIDE" ]; then
  holders=$(slot_holders)
  if [ -n "$holders" ]; then
    die "another seat holds the package-tab slot (#699) — nothing launched.
        live tab(s): ${holders//$'\n'/; }
        One package tab per box; the slot frees when that tab CLOSES, not when it idles.
        Re-run with --slot-override \"<reason>\" only when the overlap is deliberate.
        The reason is printed on launch so the other seat can see it."
  fi
else
  note "slot override: $SLOT_OVERRIDE (another seat may hold the slot)"
fi

WID=$(kitty @ launch --type=tab --tab-title "$TITLE" --cwd "$CWD" \
        bash -lc "${KEY_PREFIX}exec omp $OMP_ARGS" 2>/dev/null)
# Shape, not just emptiness: anything extra on stdout would become a second
# state row that `--list` reports and `--close` could act on.
case "$WID" in *[!0-9]*|"") die "kitty @ launch did not return a plain window id, got: '$WID'" ;; esac

WPID=$(win_pid "$WID")
[ -n "$WPID" ] || die "window $WID exited immediately after launch — check KEY_COMMAND output by hand" 3
# --close is untouched: it matches on the id and refuses strangers as before.
printf '%s %s @%s %s\n' "$WID" "$WPID" "$LAUNCHER" "$TITLE" >> "$STATE"
note "launched window $WID (pid $WPID) — $TITLE"

# Poll for the prompt rather than guessing at the handshake. omp loads MCP
# servers before it draws one, and that time is not constant.
ready=0
for _ in $(seq 1 40); do
  sleep 2
  # A tab that died (an expired key, a bad --cwd) returns empty text forever, so
  # without this the poll burns the full 80s on a corpse and then tells the
  # caller to "go look at window $WID" -- a window that no longer exists.
  if [ -z "$(win_pid "$WID")" ]; then
    printf 'WINDOW_ID=%s\n' "$WID"
    die "window $WID exited within seconds — most likely the key step or omp startup failed.
        Run KEY_COMMAND by hand to see the error, then relaunch. Nothing was sent." 3
  fi
  txt=$(kitty @ get-text --match "id:$WID" 2>/dev/null)
  # Check for the blocker BEFORE the prompt: the setup wizard's own text contains
  # the model name, so a naive "does it say DeepSeek" match passes on a tab that
  # cannot accept input. Ask what is blocking, not what is present.
  case "$txt" in
    *"Setup step"*|*"Select provider to login"*|*"Set up your providers"*)
      printf 'WINDOW_ID=%s\n' "$WID"   # exit 3 promises the id; the die prose is not machine-readable
      die "window $WID is sitting on omp's SETUP WIZARD, not a prompt.
        A fresh --profile has never been onboarded. Take it through setup once by
        hand, or drop --profile. Nothing was sent; the tab is still open." 3 ;;
  esac
  # The PROMPT GLYPH only. `DeepSeek` used to be an alternative here and it is a
  # presence check, not a readiness one: the model name is printed by the setup
  # wizard and by the banner too, so it says a screen exists rather than that the
  # screen can accept input. That is exactly how the profile bug passed this gate.
  case "$txt" in *"▶"*) ready=1; break ;; esac
  # The current default (opencode-go/muse-spark-1.3-contributor, omp v18.1.14)
  # draws NO ▶ anywhere: the empty input row is a bare ╰─ line at the bottom
  # (measured 2026-09-09, probe tab, `cat -A` + codepoint inventory). The match
  # is line-anchored because the banner border shares the ╰ glyph (╰───…): a
  # bare-substring ╰ would fire on a half-drawn banner, the same presence-check
  # regression the comment above forbids. Only the empty input row is exactly ╰─.
  if printf '%s' "$txt" | grep -q '^╰─[[:space:]]*$'; then ready=1; break; fi
done
[ "$ready" = 1 ] || note "prompt never appeared after 80s — sending anyway, then verifying"

# Say which model actually came up. A profile without modelRoles silently
# selects a different (and pricier) one than a bare launch. The second
# alternative covers Go-backed models (Muse Spark renders as
# `Muse Spark 1.3 Contributor`); without it a working default launch prints
# no `model:` line at all (measured 2026-09-08).
mdl=$(kitty @ get-text --match "id:$WID" 2>/dev/null | grep -oiE 'DeepSeek V4 [A-Za-z-]+( Vision[A-Za-z-]*)?|Muse Spark [A-Za-z0-9. -]*' | tail -1)
mdl="${mdl% }"   # the bar pads the name; a trailing space made "Contributor  —"


# A --model that did not take is the failure this flag exists to prevent, so it is
# an exit and not a note. Compare loosely: the status bar prettifies the id
# (`deepseek-v4-flash-vision-exp` renders as `DeepSeek V4 Flash Vision Exp`).
if [ -n "$MODEL" ] && [ -n "$mdl" ]; then
  want=$(printf '%s' "${MODEL##*/}" | tr 'A-Z' 'a-z' | tr -d ' -')
  got=$(printf '%s' "$mdl" | tr 'A-Z' 'a-z' | tr -d ' -')
  # The status bar is a PRETTIFIED, often TRUNCATED rendering of the model id:
  # `deepseek-v4-flash-vision-exp` shows as `DeepSeek V4 Flash Vision`, losing the
  # suffix. So the bar is a prefix of what was asked for, not a superset — checking
  # `got contains want` fails on a correct launch, which it did on first use.
  # Accept either direction of containment.
  case "$want" in
    "$got"*) : ;;
    *) case "$got" in
         *"$want"*) : ;;
         *) printf 'WINDOW_ID=%s\n' "$WID"
            die "asked for --model $MODEL but the tab is running '$mdl'.
        Nothing was sent. A model that cannot do the job reports its own limitation
        as if it were omp's, which is how it goes unnoticed." 3 ;;
       esac ;;
  esac
fi

# ONE line. Inside single quotes a backslash-newline is not a continuation: it
# sends a literal backslash and submits early.
MSG="Read $BRIEF and carry it out in full. Run the commands rather than reasoning about them."
MSG="$MSG Use absolute paths and 'git -C <dir> ...'; do NOT rely on 'cd' — on this machine 'cd' is an fnm alias and it can fail SILENTLY in a subshell, leaving your command in the wrong directory."
[ -n "$OUT" ] && MSG="$MSG Write your findings to $OUT"

# The send itself lives in kitty-send.sh, which owns the \r rule (text and the
# carriage return in ONE call) and the arrival check. Keeping a second copy here
# is how the two drift, and the rule's whole value is that it is followed
# exactly.
#
# Its exit 3 means "sent, but not observed on screen", which is NOT a reason to
# resend: a second send against an agent TUI enqueues an empty steering message
# and wedges it. Fall through to the started-working gate below instead, which
# is the stronger signal anyway.
"$SEND" --to "$WID" --text "$MSG" --quiet || note "arrival not confirmed by kitty-send; relying on the started-working gate"

# First-turn abort (agent-config#696): on 2026-09-14 seven of nine tabs wrote an
# 8-line session file with ZERO assistant turns and a model_usage row carrying
# `"stopReason":"aborted"` / `"errorMessage":"Request was aborted"` ~5 s after
# launch. A launch that wrote nothing on its first poll is a failed launch, not
# a slow one — relaunch instead of polling a silent tab. Never fires on a
# genuine provider rejection (a 402/balance line, or a model outside
# allowedModels): those refuse before launch and say why.
# Prints 0 when TAB_SESSION shows the abort signature (an aborted record, no
# assistant row that did real work), else 1. An assistant row with empty
# content and stopReason aborted is the abort itself, not a turn.
first_turn_abort() {
  [ -n "$TAB_SESSION" ] && [ -f "$TAB_SESSION" ] || return 1
  grep -q '"stopReason":"aborted"' "$TAB_SESSION" 2>/dev/null || return 1
  grep -q '"402\|Insufficient Balance\|insufficient_balance' "$TAB_SESSION" 2>/dev/null && return 1
  grep -q '"role":"assistant".*"stopReason":"stop"' "$TAB_SESSION" 2>/dev/null && return 1
  grep -q '"role":"assistant".*"stopReason":"toolUse"' "$TAB_SESSION" 2>/dev/null && return 1
  return 0
}
# Prove the launch model from the tab's session file. modelRoles.default is
# shared by every omp session and a /model action can rewrite it, so a launch
# that trusts it can land anywhere: on 2026-09-13 a tab launched "as
# anthropic/claude-opus-5" ran 5 assistant turns on Opus before a hand
# switch. The status bar sometimes names no model at all, and model_usage rows
# lie, so neither is proof. The FIRST model_change row is what the tab started on.
#
# It runs AFTER the brief is sent, because omp writes the session file only at
# the first persisted message: measured 2026-09-13, a tab that was sent nothing
# wrote no file in 20 s while omp-tab-state.sh already named its path, and the
# check placed before the send refused every launch. So a wrong-model tab has
# the brief when it is caught; it is closed at once, and the verdict says the
# brief was sent. The allowlist gate above still refuses a disallowed model
# before anything launches; this proof catches omp starting something other
# than what it was asked for. Resolved through omp-tab-state.sh (session= in
# its output); nothing here resolves a window to a session file a second way.
close_proven_window() {
  kitty @ close-window --match "id:$WID" 2>/dev/null || true
  sed -i "/^$WID /d" "$STATE" 2>/dev/null || true
}
TAB_SESSION=""; TAB_MODEL=""; ABORTED=""
for _ in $(seq 1 15); do
  _stout=$("$STATE_TAB" "$WID" 2>/dev/null || true)
  TAB_SESSION=$(printf '%s' "$_stout" | grep -o 'session=.*' | head -1 | sed 's/^session=//; s/ reason=.*$//')
  case "$TAB_SESSION" in ""|"none") TAB_SESSION="" ;;
    *) if first_turn_abort; then ABORTED=1; break; fi
       TAB_MODEL=$(grep -m1 -F '"model_change"' "$TAB_SESSION" 2>/dev/null | jq -r '.model // ""' 2>/dev/null) ;;
  esac
  [ -n "$TAB_MODEL" ] && break
  sleep 2
done
if [ "$ABORTED" = 1 ]; then
  TAB_MODEL=$(grep -m1 -F '"model_change"' "$TAB_SESSION" 2>/dev/null | jq -r '.model // ""' 2>/dev/null)
  if [ -n "$TAB_MODEL" ] && [ "$TAB_MODEL" != "$EFFECTIVE" ]; then
    printf 'WINDOW_ID=%s\n' "$WID"
    close_proven_window
    die "tab is running model $TAB_MODEL (first model_change row in $TAB_SESSION) but was launched as $EFFECTIVE. The brief had been sent; the window was closed at once." 3
  fi
  if [ -n "$TAB_MODEL" ] && [ "$(tbl has_allowed)" = yes ]; then
    _hit=0
    while IFS= read -r _allow; do
      [ -n "$_allow" ] || continue
      [ "$_allow" = "$TAB_MODEL" ] && _hit=1
    done < <(tbl allowed)
    if [ "$_hit" != 1 ]; then
      printf 'WINDOW_ID=%s\n' "$WID"
      close_proven_window
      die "tab is running model $TAB_MODEL, outside allowedModels in $PROVIDERS_JSON. The brief had been sent; the window was closed at once." 3
    fi
  fi
  if [ "$ATTEMPT" = 1 ]; then
    note "retry 2/2 after first-turn abort"
    close_proven_window
    OMP_TAB_ATTEMPT=2 exec "$0" "${LAUNCH_ARGV[@]}"
  fi
  printf 'WINDOW_ID=%s\n' "$WID"
  close_proven_window
  die "first-turn abort on both attempts: window $WID wrote an aborted record with no assistant turn. Relaunch by hand." 3
fi
if [ -z "$TAB_MODEL" ]; then
  printf 'WINDOW_ID=%s\n' "$WID"
  close_proven_window
  die "could not prove the launch model: no session file or no model_change row for window $WID within ~16 s of the send ($STATE_TAB says session=${TAB_SESSION:-none}). The brief had been sent; the window was closed at once: \"could not check\" is not a pass." 3
fi
if [ "$TAB_MODEL" != "$EFFECTIVE" ]; then
  printf 'WINDOW_ID=%s\n' "$WID"
  close_proven_window
  die "tab is running model $TAB_MODEL (first model_change row in $TAB_SESSION) but was launched as $EFFECTIVE. The brief had been sent; the window was closed at once." 3
fi
if [ "$(tbl has_allowed)" = yes ]; then
  _hit=0
  while IFS= read -r _allow; do
    [ -n "$_allow" ] || continue
    [ "$_allow" = "$TAB_MODEL" ] && _hit=1
  done < <(tbl allowed)
  if [ "$_hit" != 1 ]; then
    printf 'WINDOW_ID=%s\n' "$WID"
    close_proven_window
    die "tab is running model $TAB_MODEL, outside allowedModels in $PROVIDERS_JSON. The brief had been sent; the window was closed at once." 3
  fi
fi
# provider/model, not the pretty name alone: the bar cannot tell
# opencode-go/deepseek-v4-flash from deepseek/deepseek-v4-flash.
note "model: $TAB_MODEL (proven from the tab's session file) — launched as $EFFECTIVE"

# THE gate, and it asks a different question from kitty-send's. That one proves
# the TEXT ARRIVED; this one proves omp STARTED WORKING on it. A tab can have the
# instruction on screen and be wedged.
#
# `esc` used to be one of the alternatives below and it made this gate nearly
# vacuous: it is a bare substring, so it matched omp's standing UI hints and any
# prose containing "escape"/"description" -- 9 hits on a healthy screen. Exit 0
# was therefore consistent with a tab that never received the message, which is
# the precise silent failure this whole script exists to kill.
#
# `esc` used to be one of the alternatives below and it made this gate nearly
# vacuous: it is a bare substring, so it matched omp's standing UI hints and any
# prose containing "escape"/"description" -- 9 hits on a healthy screen. Exit 0
# was therefore consistent with a tab that never received the message, which is
# the precise silent failure this whole script exists to kill.
#
# What remains is evidence of THIS instruction: the echoed `Read /<path>` line,
# or a spinner meaning work started. Polled rather than a single `sleep 8`, so a
# slow first token is not reported as a failure and a fast one costs 2s.
confirmed=0
for _ in $(seq 1 15); do
  sleep 2
  if [ -z "$(win_pid "$WID")" ]; then
    note "window $WID died after the instruction was sent"
    break
  fi
  if kitty @ get-text --match "id:$WID" 2>/dev/null | grep -q 'Read /\|⠋\|⠙\|⠹\|⠸\|⠼\|⠴\|⠦\|⠧\|⠇\|⠏'; then
    confirmed=1; break
  fi
done
if [ "$confirmed" = 1 ]; then
  note "confirmed running"
  printf 'WINDOW_ID=%s\n' "$WID"
  [ -n "$OUT" ] && printf 'OUT=%s\n' "$OUT"
  printf 'CLOSE_WITH=%s --close %s\n' "$0" "$WID"
  exit 0
fi

note "could not confirm it started — go look at window $WID before assuming it is working"
printf 'WINDOW_ID=%s\n' "$WID"
exit 3
