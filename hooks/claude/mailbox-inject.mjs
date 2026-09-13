#!/usr/bin/env node
// UserPromptSubmit hook: mailbox inbox injection.
//
// Reads this session's unacked mailbox rows BY SESSION ID across all of its
// keys, acks each with deliveredAs "prompt", and prints them as
// additionalContext so they land in the turn. The session id never changes
// but the cwd does (EnterWorktree moves it), so a key derived from the hook's
// current cwd would read a file nobody writes to; the session-id scan finds
// rows under the pre-move key too. Prints nothing when the inbox is empty. A
// read failure prints a one-line could-not-read note — never silence, so a
// broken store is visible instead of looking like an empty inbox.
//
// Also refreshes this session's presence entry with mailbox: true so
// agent-send.mjs (and send_message) treat it as a consumer.
//
// A hook failure must never break a prompt: everything is wrapped and the
// hook always exits 0.

import fs from 'node:fs';
import { recordPresence } from '../../lib/presence.mjs';
import { MAILBOX_DIR, readUnackedBySession, ack } from '../../lib/agent-mailbox.mjs';
// Whole stdin as a string. Resolves with whatever arrived when the stream
// ends, errors, or the timeout fires, so the hook never hangs on a half-open
// pipe. Inlined here (the only use) so this hook ships no library.
const readStdin = (timeoutMs = 500) =>
  new Promise((resolve) => {
    let buf = '';
    const timer = setTimeout(() => resolve(buf), timeoutMs);
    process.stdin.on('data', (c) => (buf += c));
    process.stdin.on('end', () => {
      clearTimeout(timer);
      resolve(buf);
    });
    process.stdin.on('error', () => {
      clearTimeout(timer);
      resolve(buf);
    });
  });

// A missing store is a normal empty inbox (fresh machine, no sender yet) and
// stays silent. An existing-but-unreadable store is a broken measurement that
// must never report as empty, so it throws and the caller prints could-not-read.
const assertMailboxReadable = (dir) => {
  let st;
  try {
    st = fs.statSync(dir);
  } catch (e) {
    if (e.code === 'ENOENT') return;
    throw e;
  }
  if (!st.isDirectory()) throw new Error(`mailbox dir ${dir} is not a directory`);
  fs.accessSync(dir, fs.constants.R_OK | fs.constants.X_OK);
};

try {
  const raw = await readStdin(500);
  let cwd = process.cwd();
  let sessionId = process.env.CLAUDE_CODE_SESSION_ID ?? null;
  try {
    const payload = JSON.parse(raw);
    if (typeof payload.cwd === 'string' && payload.cwd) cwd = payload.cwd;
    if (typeof payload.session_id === 'string') sessionId = payload.session_id;
  } catch {
    // No / malformed payload — fall back to process.cwd() + env session id.
  }
  const dir = process.env.AGENT_MAILBOX_DIR ?? MAILBOX_DIR;
  let found;
  try {
    assertMailboxReadable(dir);
    found = readUnackedBySession(sessionId, { dir });
  } catch (e) {
    process.stdout.write(`[mailbox] could not read inbox: ${e.message ?? e}\n`);
    found = null;
  }
  if (found) {
    for (const { key, row } of found) {
      try {
        ack({ key, id: row.id, deliveredAs: 'prompt', dir });
      } catch {
        // Best-effort — the row is still printed below.
      }
    }
    if (found.length) {
      const lines = found.map(
        ({ row }) => `[mailbox] from ${row.from} (${row.priority}, ${row.ts}): ${row.text}`,
      );
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: lines.join('\n') },
        }),
      );
    }
  }
  try {
    const rawWin = process.env.KITTY_WINDOW_ID;
    const win = rawWin != null && rawWin !== '' ? Number(rawWin) : null;
    recordPresence({ cwd, sessionId, mailbox: true, windowId: Number.isFinite(win) ? win : null });
  } catch {
    // Best-effort — presence is advisory.
  }
} catch {
  // Never let the inbox hook disrupt the turn.
}
process.exit(0);
