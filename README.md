# Agent Switchboard

<picture><source media="(prefers-color-scheme: dark)" srcset="assets/switchboard-map-dark.svg"><img alt="Map of who can reach whom: the cross-platform channel bridges lead agents (Claude Code, Codex) and delegated agents through a store on disk with a terminal fallback; leads write plans, briefs and merges, delegated agents write reports and pull requests, and both sides read the shared files and the shared record." src="assets/switchboard-map-light.svg"></picture>

## What this is

A mailbox with acks between agents on three runtimes (Claude Code, opencode and Codex) on one machine, kept in a SQLite file on disk. When the recipient has no mailbox consumer, the sender falls back to typing into the recipient's terminal and proving the text landed. A tab launcher opens delegated agents with their briefs and confirms they started.

## The two channels

- Cross-platform agent channel: this repo — a store on disk plus the terminal fallback.
- The shared record: issues, pull requests, checks and merges; messages point at it and do not replace it.

## What each line is built on

| Line | Built on | Where |
|---|---|---|
| Cross-platform channel: the store | One row per message in a SQLite file on disk (`$AGENT_SWITCHBOARD_DIR/state.db`); JSONL files under `mailbox/` only while a legacy pin is set (see Store below). The sender resolves the recipient's window and waits for the ack row. | `bin/agent-send.mjs`, `lib/agent-mailbox.mjs`, `lib/store.mjs` |
| Cross-platform channel: the consumers | A hook inside each agent reads unacked rows and acks them: at each prompt in Claude Code and Codex, and at each Claude Code Stop. The opencode consumer lives in agent-config (`opencode/plugin/coordination.ts`), not here. | `hooks/claude/mailbox-inject.mjs`, `hooks/claude/mailbox-stop.mjs`, `hooks/codex/mailbox.mjs` |
| Terminal if no ack | Terminal remote control: types the message into the window. Delivery is proven by a new inbound row in that tab's session file. | `bin/kitty-send.sh` |
| Launch | Terminal remote control: opens a titled tab running the agent with its brief, confirms it started, and refuses to close a window it did not launch; details in [`docs/launchers.md`](docs/launchers.md). | `bin/opencode-tab.sh`, `bin/claude-tab.sh`, `bin/claude-resume-set.sh`, `lib/tab-ledger.sh` |
| Read state | Not the screen but the disk: the window's process and the runtime's own session record: a Claude Code window is read from Claude's session record (`status` busy or idle) and transcript, an opencode window from opencode's session database. Any other window reads as `unknown`. | `bin/tab-state.sh` |
| Files | Plain files every agent can read: plan, briefs, steers, reports, logs. | a directory the agents share |
| Shared record | The `gh` command line: issues, pull requests, checks, merges. | `gh` |
| Approval path | The host agent's own hold screen for a message between sessions in different permission modes. | The host agent's settings file |

## Install

The hooks below plug into the Claude Code and Codex runtimes, and the sender, fallback and launcher drive kitty; all three must be present for the full channel, while mailbox-only mode works anywhere node runs.

```sh
git clone <repo-url> ~/agent-switchboard
export PATH="$HOME/agent-switchboard/bin:$PATH"
```

`<checkout>` below is where you cloned it. Keep that checkout in place: the hooks import their siblings by relative path, so a hook file copied out on its own breaks.

### Host agent: the inbox hook

Add the repo's hook file, in place, to the existing `UserPromptSubmit` hook list in `settings.json`:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          { "type": "command", "command": "node <checkout>/hooks/claude/mailbox-inject.mjs" }
        ]
      }
    ]
  }
}
```

The hook reads this session's unacked rows by session id, acks each with `prompt`, prints them as turn context, and refreshes this session's presence entry so senders route here instead of the terminal. It always exits 0 and prints nothing when the inbox is empty.

### Host agent: the Stop drain

A row queued for a seat that is mid-turn would otherwise wait for the next prompt, and an idle seat never gets one. Add the Stop hook, in place, to the `Stop` list in `settings.json`:

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          { "type": "command", "command": "node <checkout>/hooks/claude/mailbox-stop.mjs" }
        ]
      }
    ]
  }
}
```

When the turn ends the hook reads this session's unacked rows, acks each with `stop` before printing, and prints `{"decision":"block","reason":...}` so the seat continues with the messages. The acks bound the loop: a second Stop finds nothing. It prints nothing when the inbox is empty, does not refresh presence or claim roles, and always exits 0.

### Codex desktop: the inbox hook

Add the switchboard hook to the existing `SessionStart`, `UserPromptSubmit`, and `SessionEnd` lists in `~/.codex/hooks.json`. Keep the existing handlers; Codex loads all matching hook sources. If this machine uses a switchboard environment bootstrap, preload it before the hook so the Codex app uses the same SQLite store as the other agents:

```json
{
  "hooks": {
    "SessionStart": [{ "hooks": [{ "type": "command", "command": "node --import <switchboard-env.mjs> <checkout>/hooks/codex/mailbox.mjs" }] }],
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "node --import <switchboard-env.mjs> <checkout>/hooks/codex/mailbox.mjs" }] }],
    "SessionEnd": [{ "hooks": [{ "type": "command", "command": "node --import <switchboard-env.mjs> <checkout>/hooks/codex/mailbox.mjs" }] }]
  }
}
```

For a standalone installation without a bootstrap, omit `--import <switchboard-env.mjs>`. Codex supplies a stable `session_id` and `cwd` to the hook. The hook registers that identity as a consumer, adds pending messages as context on the next submitted prompt, acknowledges them, and releases the beacon at session end. Codex has no lifecycle event for an external mailbox write, so a reply sent while its chat is idle waits until the next prompt. Review and trust the hook definition in Codex before relying on it; changed non-managed hooks are skipped until trusted.

### Seat roles

A window id dies with its window; a **seat role** names the seat itself, and `--to role:<name>` follows whichever session holds it (`agent-send.mjs --claim-role <name>`, `--release-role <name>`, `--who`). Claim, release, send, idle-seat and nudge rules: [`docs/seat-roles.md`](docs/seat-roles.md).

### Sending and launching

```sh
# Steer another agent; exit 0 means acked or proven, 3 means not delivered yet (do not resend),
# 10 means typed but not proven (look at the window before resending); any other code is kitty-send.sh's.
agent-send.mjs --to <window-id|title-substring|mailbox-key|role:name> (--text TEXT | --file /abs/path) [--now | --stop | --idle-when REGEX | --queue] [--deadline N]
agent-send.mjs --read [--as <session-id>]   # print and ack this session's inbox rows (incl. held roles' queues)
agent-send.mjs --cancel --id <r> [--to <key>] # withdraw one queued row; the id alone is enough, the row's own recipient is used (exit 13: already delivered or withdrawn, 14: no such row)
agent-send.mjs --to role:<name> --text TEXT # address a seat role; it survives a seat change
agent-send.mjs --claim-role <name> [--take-over]  # hold a role; exit 11 if a live seat holds it
agent-send.mjs --release-role <name>              # give up a role this session holds; exit 12 if another holds it
agent-send.mjs --who [--json]               # live seats: window, session, cwd, repo, branch, roles, title
# A multi-line --text reaches a mailbox consumer whole; on the kitty fallback it becomes a --file note
# under ~/.local/state/agent-switchboard/notes/. The process title hides the text from `pkill -f`.

# Open a titled tab with its brief and confirm it started (exit 2 means no terminal remote control): --model is required, and a session on another model closes the tab (exit 3).
# Both launchers share --list (the tabs this machine launched) and --close <window-id> (refuses a window it did not launch).
opencode-tab.sh --title "opencode: <what this is>" --brief /abs/brief.md --model PROVIDER/NAME [--out /abs/out.md] [--cwd /abs/repo] [--slot-override "<reason>"] [--server URL] [--no-probe]   # probes the model first; --server opens the tab on a shared opencode server
claude-tab.sh --title "claude: <what this is>" --brief /abs/brief.md --model opus|sonnet|haiku|fable|claude-ID [--rc [NAME]] [--out /abs/out.md] [--cwd /abs/repo] [--slot-override "<reason>"]
claude-tab.sh --resume <session-id> --title "claude: <name>" --model ... [--rc [NAME]] [--brief /abs/brief.md]   # reopen a session as a seat, proven past the old rows

# Before a reboot: record the live Claude Code sessions; after it, reopen each one, proven, through claude-tab.sh --resume.
claude-resume-set.sh --snapshot [/abs/file.json]
claude-resume-set.sh --replay [/abs/file.json] [--dry-run]

# What a tab is doing, read from disk, never the screen.
tab-state.sh <window-id> [--json] [--watch [--interval=S]]
```

`--topic SLUG` (`[a-z0-9][a-z0-9._-]{0,63}`) makes a broadcast one delivery per recipient: sending withdraws every earlier unacked message with the same topic to that recipient, from any sender, and the readers collapse a send race to the newest row, rendered with ` (supersedes N)`. Use it where only the latest copy matters (a RESUME to every seat, a round's question), so a seat that wakes to two senders spends one turn, not two; a message without a topic never collapses. A typed kitty fallback also leaves an acked row (`via: "typed"`), so the store sees every delivery; a `--topic` send whose topic was already delivered to the recipient within `--topic-window MIN` (default 60) sends nothing, prints `already delivered: topic <t> at <ts> from <sender>` and exits 0. `--force-topic` or `--topic-window 0` sends anyway.

`--now` (the default) and `--stop` interrupt; `--idle-when` and `--queue` wait for a parked proof. After an unacked wait the sender withdraws the mailbox row and falls through to `bin/kitty-send.sh`, which types the text plus carriage return in one call and proves it by a new inbound row in the tab's session file. A Claude Code tab is the exception (#38): its composer swallows the carriage return of a long one-line send, so kitty-send types the text alone and then a lone carriage return (a second one at most), and proves it by a new user row carrying the text in the session's transcript, found through `~/.claude/sessions/<pid>.json`.

## Configuration

Every environment variable, its default and its reader, plus the timers: [`docs/configuration.md`](docs/configuration.md). Exit codes: [`docs/exit-codes.md`](docs/exit-codes.md).

## Store (SQLite) and retention

The mailbox and presence beacons live in one SQLite file (`AGENT_SWITCHBOARD_DB`, default `$AGENT_SWITCHBOARD_DIR/state.db`, WAL mode, 5 s busy timeout). `lib/store.mjs` picks `node:sqlite` under node and `bun:sqlite` under Bun at runtime, so the Node scripts and a Bun hook read and write the same file; `bin/switchboard-export.mjs <mailbox|presence|meta>` dumps any table as JSON for hand inspection, and exits 2 when no file is at the store path rather than printing an empty table.

Backend choice, in order: an explicit `{dir}` / `{file}` override means JSON files (the hermetic path the tests exercise); else an explicit `AGENT_SWITCHBOARD_DB` wins and the store backs everything; else the legacy `AGENT_SWITCHBOARD_MAILBOX_DIR` / `AGENT_MAILBOX_DIR` / `AGENT_SWITCHBOARD_PRESENCE_FILE` pins keep the JSONL backend while set. The store's first open imports the legacy files once (recorded in the `meta` table, so a second open imports nothing) and leaves them in place.

Retention, enforced by `pruneStale`: acked or cancelled rows are deleted 14 days after their ack/withdraw marker, markers included. Unacked rows are never deleted by retention — a closed session's rows survive it, so a probe's evidence outlives its session. A session-less run (no session id) records nothing: the consumer hook writes no beacon and starts no idle watcher, so it leaves no rows or beacons behind.

## Limits, plainly

- Same machine only. The store is files on disk and the fallback types into a local window; nothing here crosses a network boundary.
- Kitty remote control must be on for the fallback and the launcher. Without it the launcher exits 2, which tells the caller to fall back to headless and say so, and the sender leaves the row queued with exit 3.
- Mailbox-only mode works anywhere node runs: set `AGENT_SWITCHBOARD_DIR`, wire one hook, and `agent-send.mjs --queue` never needs a terminal.
- A message between host-agent sessions in different permission modes waits for the human's approval, and that hold is visible only to the human. Silence is not delivery: a held message is invisible to the receiving agent.
- Anything injected into a joined session leaves the machine — a guest sees the host's whole history, including what the machine injected into it. Never share a session link beyond the people who may read that history.

## Patterns

[`docs/patterns.md`](docs/patterns.md) recasts the eight observed and proposed exchanges as prose plus step lists: steering down a chain, delivery that never drops, a lease on one scarce slot, two leads editing one shared document, escalation from a held message to a policy, research with evidence-checked review, correction propagation to every copy, and a reply that finds its asker across runtimes. Each step says how its delivery is proven.
