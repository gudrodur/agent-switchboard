#!/usr/bin/env node
// Codex desktop lifecycle hook for the agent-switchboard mailbox.
//
// SessionStart and UserPromptSubmit register the stable Codex session id as a
// mailbox consumer. UserPromptSubmit drains and acknowledges queued rows,
// adding them as developer context to the turn being submitted. Codex hooks
// have no event for an external mailbox write, so a message sent while the
// chat is idle is delivered on the next submitted prompt.

import { recordPresence, releasePresence } from '../../lib/presence.mjs';
import { readUnackedBySession, ack } from '../../lib/agent-mailbox.mjs';

const readStdin = (timeoutMs = 500) =>
  new Promise((resolve) => {
    let input = '';
    const timer = setTimeout(() => resolve(input), timeoutMs);
    process.stdin.on('data', (chunk) => (input += chunk));
    process.stdin.on('end', () => { clearTimeout(timer); resolve(input); });
    process.stdin.on('error', () => { clearTimeout(timer); resolve(input); });
  });

const validIdentity = ({ session_id: sessionId, cwd }) =>
  typeof sessionId === 'string' && sessionId.trim() !== '' &&
  typeof cwd === 'string' && cwd.startsWith('/');

export const handleEvent = (input, {
  record = recordPresence,
  release = releasePresence,
  read = readUnackedBySession,
  acknowledge = ack,
} = {}) => {
  const event = input?.hook_event_name;
  const sessionId = input?.session_id;
  const cwd = input?.cwd;
  if (!validIdentity({ session_id: sessionId, cwd })) return '';

  if (event === 'SessionEnd') {
    release({ sessionId, cwd });
    return '';
  }
  if (event !== 'SessionStart' && event !== 'UserPromptSubmit') return '';

  record({ sessionId, cwd, mailbox: true });
  if (event === 'SessionStart') return '';

  let rows;
  try {
    rows = read(sessionId);
  } catch (error) {
    return JSON.stringify({
      systemMessage: `[mailbox] could not read inbox: ${error?.message ?? error}`,
    });
  }
  for (const { key, row } of rows) {
    try {
      acknowledge({ key, id: row.id, deliveredAs: 'prompt' });
    } catch {
      // Keep the message visible even if its acknowledgement could not be written.
    }
  }
  if (rows.length === 0) return '';
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: rows.map(({ row }) =>
        `[mailbox] from ${row.from} (${row.priority}, ${row.ts}): ${row.text}`,
      ).join('\n'),
    },
  });
};

try {
  const raw = await readStdin();
  let input = {};
  try { input = JSON.parse(raw); } catch { /* malformed input: no identity, no mailbox */ }
  const output = handleEvent(input);
  if (output) process.stdout.write(`${output}\n`);
} catch {
  // Mailbox integration is advisory and must never break a Codex turn.
}
process.exit(0);
