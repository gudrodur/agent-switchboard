# Configuration

Every variable, its default, and what reads it — taken from the code, not from memory.

| Variable | Default | Used by |
|---|---|---|
| `AGENT_SWITCHBOARD_DIR` | `${XDG_STATE_HOME:-$HOME/.local/state}/agent-switchboard` | `lib/presence.mjs`: root for presence and mailbox |
| `AGENT_SWITCHBOARD_PRESENCE_FILE` | `$AGENT_SWITCHBOARD_DIR/presence.json` | `lib/presence.mjs`: legacy live-beacon file, imported once into the store; beacons live in `state.db` (`presence_beacons`) unless this pin is set |
| `AGENT_SWITCHBOARD_DB` | `$AGENT_SWITCHBOARD_DIR/state.db` | `lib/store.mjs`: the SQLite store (WAL mode) holding the mailbox and presence when no legacy file override below is set |
| `AGENT_SWITCHBOARD_MAILBOX_DIR` | `$AGENT_SWITCHBOARD_DIR/mailbox` | `lib/agent-mailbox.mjs`: legacy JSONL mailbox, one file per recipient (`AGENT_MAILBOX_DIR` still honoured as the older name); used while set or while a `{dir}` override is passed |
| `AGENT_SWITCHBOARD_SENDER` | `another agent session` | `bin/agent-send.mjs`, `bin/kitty-send.sh`: the sender label on terminal-delivered notes |
| `AGENT_SEND_IDLE_WAIT_S` | `5` (seconds) | `bin/agent-send.mjs`: the ack wait for a recipient whose window title shows it idle (busy keeps 120 s; `--deadline` wins) |
| `AGENT_SWITCHBOARD_SEND` | `bin/kitty-send.sh` beside `agent-send.mjs` | `bin/agent-send.mjs`: the fallback sender (`AGENT_SEND_KITTY_SEND` wins when set) |
| `OPENCODE_TAB_LAUNCH` | `<agent-config>/scripts/opencode-launch.sh` | `bin/opencode-tab.sh`: the command the tab execs (exports the Cloudflare MCP tokens, then runs opencode) |
| `OPENCODE_TAB_PROBE_TIMEOUT` | `60` | `bin/opencode-tab.sh`: seconds the pre-launch model probe may take before it counts as a hang |
| `OPENCODE_TAB_DB` | `${XDG_DATA_HOME:-$HOME/.local/share}/opencode/opencode.db` | `bin/opencode-tab.sh`: opencode's store, read-only, for the session row that proves the start and its model |
| `OPENCODE_TAB_PRESENCE` | unset: `lib/presence.mjs` on the caller's store | `bin/opencode-tab.sh`: a command printing `{"beacons":[...]}` for the start proof, in place of the lib |
| `CLAUDE_TAB_BIN` | `claude` | `bin/claude-tab.sh`: the command the tab execs |
| `CLAUDE_TAB_PROJECTS` | `${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects` | `bin/claude-tab.sh`: Claude Code's transcripts, read-only, for the new session file that proves the start, its model and (with `--rc`) its `bridge-session` row |
| `CLAUDE_RESUME_SET_DIR` | `${XDG_STATE_HOME:-$HOME/.local/state}/claude-resume-set` | `bin/claude-resume-set.sh`: where `--snapshot` writes `latest.json`, its `.md` and a timestamped copy, and what `--replay` reads by default |
| `CLAUDE_RESUME_SET_TAB` | `bin/claude-tab.sh` beside it | `bin/claude-resume-set.sh`: the launcher each replayed row runs |
| `CLAUDE_TAB_CONFIG` | `${CLAUDE_CONFIG_DIR:-$HOME}/.claude.json` | `bin/claude-tab.sh`: Claude Code's user config, read-only, for folder trust (the cwd or an ancestor must be trusted, or nothing is launched) |
| `AGENT_CONFIG_HOME` | `$HOME/agent-config`, else `$HOME/.claude` | `bin/opencode-tab.sh`, `bin/claude-tab.sh`: where `scripts/task-claim.mjs` lives |
| `SWITCHBOARD_TASK_CLAIM` | `$AGENT_CONFIG_HOME/scripts/task-claim.mjs` | `lib/tab-ledger.sh` (both launchers): the brief-claim CLI; a missing one is a loud skip |
| `CLAUDE_SESSION_ID` | unset, then `KITTY_WINDOW_ID` | both launchers: the launcher id written into each state row |
| `CLAUDE_SESSIONS_DIR`, `CLAUDE_PROJECTS_DIR` | `${CLAUDE_CONFIG_DIR:-$HOME/.claude}/sessions`, `.../projects` | `lib/claude-session.sh` (`bin/tab-state.sh`, `bin/kitty-send.sh`, `bin/claude-tab.sh --resume`, `bin/claude-resume-set.sh`): Claude Code's per-pid session records and transcripts, read-only; `KITTY_SEND_CLAUDE_SESSIONS_DIR` and `KITTY_SEND_CLAUDE_PROJECTS_DIR` still win |
| `CLAUDE_CODE_SESSION_ID` | null (address by cwd only) | `hooks/claude/mailbox-inject.mjs`, `bin/agent-send.mjs`: host-agent session identity |
| `KITTY_WINDOW_ID` | null (cwd join only) | the Claude Code hook, `lib/agent-mailbox.mjs`: exact window-to-session routing (the Codex hook records no window id) |

The ledger of launched tabs is `$XDG_RUNTIME_DIR/opencode-tab-launched.<uid>`; a ledger left under its former name `omp-tab-launched.<uid>` is moved to the new name on first use.

Timers, for orientation: presence beacons go stale after 20 minutes (`PRESENCE_STALE_MS`, never restated), or at once when the beacon carries a writer pid that is dead (`isLiveBeacon` in `lib/presence.mjs`, which the mailbox readers import); the sender waits 120 s for an ack from a busy recipient and 5 s from one whose window title shows it idle (`AGENT_SEND_IDLE_WAIT_S`; `--deadline N` always wins, unbounded for `--queue`; a busy target acks only at its next tool boundary, and a kitty fallback under `--now` would discard the tool result it was waiting for); the queued terminal waiter heartbeats every 5 min and never times out unless `--deadline` caps it.
