// Codex hook lifecycle and mailbox delivery tests.
import './helpers/isolate-setup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { appendMessage, readUnacked, recipientKey } from '../lib/agent-mailbox.mjs';
import { readAllPresence } from '../lib/presence.mjs';
import { defaultStorePath, openStore } from '../lib/store.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOOK = path.join(ROOT, 'hooks/codex/mailbox.mjs');
const SID = 'codex-session-test-24d2';
const CWD = '/example/codex-project';

const runHook = (input) => spawnSync(process.execPath, [HOOK], {
  cwd: ROOT,
  input: JSON.stringify(input),
  encoding: 'utf8',
  env: process.env,
});

test('SessionStart registers a stable Codex session as a mailbox consumer', () => {
  const result = runHook({ hook_event_name: 'SessionStart', session_id: SID, cwd: CWD });
  assert.equal(result.status, 0);
  const beacon = readAllPresence().find((b) => b.sessionId === SID && b.cwd === CWD);
  assert.ok(beacon);
  assert.equal(beacon.mailbox, true);
});

test('UserPromptSubmit injects and acknowledges a reply addressed to the Codex session', () => {
  const key = recipientKey({ cwd: CWD, sessionId: SID });
  const message = appendMessage({
    to: key, from: 'omp-session', priority: 'queue', text: 'Reply from the embedded OMP session',
  });
  const result = runHook({ hook_event_name: 'UserPromptSubmit', session_id: SID, cwd: CWD, prompt: 'Continue' });
  assert.equal(result.status, 0);
  const output = JSON.parse(result.stdout);
  assert.equal(output.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.match(output.hookSpecificOutput.additionalContext, /Reply from the embedded OMP session/);
  assert.deepEqual(readUnacked(key), []);
  const store = openStore(defaultStorePath());
  try {
    const row = store.get('SELECT row_json FROM mailbox_rows WHERE recipient_key = ? AND msg_id = ?', key, message.id);
    assert.match(row.row_json, /"deliveredAs":"prompt"/);
    assert.match(row.row_json, new RegExp(`"ack":"${message.id}"`));
  } finally {
    store.close();
  }
});

test('a missing or malformed session id cannot register an anonymous consumer or ack mail', () => {
  const key = recipientKey({ cwd: CWD, sessionId: null });
  const message = appendMessage({ to: key, from: 'omp-session', priority: 'now', text: 'Do not lose me' });
  for (const input of [
    { hook_event_name: 'SessionStart', cwd: CWD },
    { hook_event_name: 'UserPromptSubmit', session_id: '', cwd: CWD },
    { hook_event_name: 'UserPromptSubmit', session_id: SID, cwd: 'relative/path' },
  ]) {
    const result = runHook(input);
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
  }
  assert.equal(readAllPresence().some((b) => b.sessionId == null || b.sessionId === 'anon'), false);
  assert.equal(readUnacked(key).some((row) => row.id === message.id), true);
});

test('SessionEnd releases the Codex session beacon', () => {
  const result = runHook({ hook_event_name: 'SessionEnd', session_id: SID, cwd: CWD, reason: 'other' });
  assert.equal(result.status, 0);
  assert.equal(readAllPresence().some((b) => b.sessionId === SID), false);
});
