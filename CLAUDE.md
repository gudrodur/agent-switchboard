# agent-switchboard

File-backed mailbox with acks between agent sessions on one machine, a kitty send-text fallback, and a tab launcher. Public MIT repo: no internal URLs or credential names in issues, PRs or commits. Node >= 24.

## Tests

- Full: `npm test` (runs both below; quiet, failures print detail).
- Node only: `npm run test:node`; one file: `node --import ./tests/helpers/isolate-setup.mjs --test tests/<name>.test.mjs`.
- Kitty only: `npm run test:kitty` (drives real throwaway kitty windows; exit 2 means no remote control). `KITTY_TEST_VERBOSE=1` prints every case.

## Live install

The running copy is this checkout, `~/Development/projects/agent-switchboard`, with no separate install. agent-config reaches it through `AGENT_SWITCHBOARD_HOME` (default that path) via `scripts/lib/switchboard-env.mjs`, and its delegators `~/.claude/scripts/mailbox-inject.mjs` and `mailbox-stop.mjs` import the hooks from here. Merging to `main` and pulling that checkout changes running sessions, so work in a worktree and never edit the main checkout in place.

## Consumers by runtime

- Claude Code: `hooks/claude/mailbox-inject.mjs` (each prompt), `hooks/claude/mailbox-stop.mjs` (Stop drain).
- Codex: `hooks/codex/mailbox.mjs` (`~/.codex/hooks.json`).
- opencode: not in this repo; agent-config's `opencode/plugin/coordination.ts`.

## Where things are

`bin/` sender, fallback, launchers, tab-state; `lib/` store, mailbox, presence; `tests/`; `docs/`.

## Router

- Channel map, install, sending and launching: `README.md`.
- Env vars and timers: `docs/configuration.md`. Exit codes: `docs/exit-codes.md`.
- Seat roles: `docs/seat-roles.md`. Launchers: `docs/launchers.md`.
- Message exchange patterns: `docs/patterns.md`.
