#!/usr/bin/env node
// Stop hook: mailbox drain at the end of a turn.
//
// A row queued for a seat that was mid-turn is drained by mailbox-inject.mjs
// only at the next UserPromptSubmit, which an idle seat never gets. This hook
// reads the session's unacked rows (by session id, as mailbox-inject does),
// acks each with deliveredAs "stop" BEFORE printing, then prints
// {"decision":"block","reason":...} so the seat continues with the messages.
//
// stop_hook_active is deliberately ignored: the acks bound the loop, because
// a second Stop finds nothing. No presence refresh and no role claim here.
// Every error path exits 0 with no stdout.

import fs from 'node:fs';
import { mailboxFileDir, readInbox, formatInboxLines, ack } from '../../lib/agent-mailbox.mjs';

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

// A missing dir is an empty inbox; an existing-but-unreadable one throws.
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
  let sessionId = process.env.CLAUDE_CODE_SESSION_ID ?? null;
  try {
    const payload = JSON.parse(raw);
    if (typeof payload.session_id === 'string') sessionId = payload.session_id;
  } catch {
    // No / malformed payload: fall back to the env session id.
  }
  const dir = mailboxFileDir();
  const opts = dir ? { dir } : {};
  if (dir) assertMailboxReadable(dir);
  const found = readInbox(sessionId, opts);
  if (found && found.length) {
    for (const { key, row } of found) {
      try {
        ack({ key, id: row.id, deliveredAs: 'stop', ...opts });
      } catch {
        // Best-effort: the row is still printed below.
      }
    }
    const reason = ['[mailbox] These messages arrived after your turn ended:', ...formatInboxLines(found)].join('\n');
    process.stdout.write(JSON.stringify({ decision: 'block', reason }));
  }
} catch {
  // Never let the drain disrupt the session.
}
process.exit(0);
