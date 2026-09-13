// Tests for scripts/mailbox-inject.mjs.
//
// The hook runs as a subprocess (it exits the process on import, so it is not
// importable): stdin carries the UserPromptSubmit payload
// ({"cwd":..., "session_id":...}), AGENT_MAILBOX_DIR points the store at a
// temp dir, and HOME points at a temp dir so the presence write
// (os.homedir()-based) lands in isolation too.
//
// Run: node --test tests/mailbox-inject.test.mjs
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { isolatedEnv } from './helpers/isolate-env.mjs';
import { fileURLToPath } from 'node:url';
import { appendMessage, readUnacked, recipientKey } from '../lib/agent-mailbox.mjs';
import { recordPresence } from '../lib/presence.mjs';

const HOOK = fileURLToPath(new URL('../hooks/claude/mailbox-inject.mjs', import.meta.url));

const CWD = '/repo/a';
const SID = 's9';
const KEY = '-repo-a__s9';

let root, mboxDir, homeDir, switchDir;

const payload = JSON.stringify({ cwd: CWD, session_id: SID });

const runHook = (env = {}) => {
  // Every spawned run gets temp store paths (never the live lock dir): the
  // presence pin must name switchDir/presence.json, which presenceBeacons()
  // below reads back.
  const res = spawnSync('node', [HOOK], {
    input: payload,
    encoding: 'utf-8',
    env: isolatedEnv({ HOME: homeDir, AGENT_SWITCHBOARD_DIR: switchDir, AGENT_MAILBOX_DIR: mboxDir, AGENT_SWITCHBOARD_PRESENCE_FILE: path.join(switchDir, 'presence.json'), ...env }),
  });
  return res;
};

const presenceBeacons = () => {
  const file = path.join(switchDir, 'presence.json');
  return JSON.parse(fs.readFileSync(file, 'utf-8')).beacons;
};

before(async () => {
  root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mbox-inject-'));
  mboxDir = path.join(root, 'mbox');
  fs.mkdirSync(mboxDir, { recursive: true });
  homeDir = path.join(root, 'home');
  fs.mkdirSync(homeDir, { recursive: true });
  switchDir = path.join(root, 'switchboard');
  fs.mkdirSync(switchDir, { recursive: true });
  assert.equal(recipientKey({ cwd: CWD, sessionId: SID }), KEY);
});

test('empty inbox prints nothing, exits 0, and marks the presence entry a consumer', () => {
  const res = runHook();
  assert.equal(res.status, 0);
  assert.equal(res.stdout, '');
  const mine = presenceBeacons().filter((b) => b.cwd === CWD && b.sessionId === SID);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].mailbox, true);
});

test('two rows print two lines and are acked as prompt', () => {
  appendMessage({ to: KEY, from: 'agent-send:/other', priority: 'now', text: 'first', dir: mboxDir });
  appendMessage({ to: KEY, from: 'agent-send:/other', priority: 'stop', text: 'second', dir: mboxDir });
  const res = runHook();
  assert.equal(res.status, 0);
  const parsed = JSON.parse(res.stdout);
  assert.equal(parsed.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  const lines = parsed.hookSpecificOutput.additionalContext.split('\n');
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^\[mailbox\] from agent-send:\/other \(now, .*?\): first$/);
  assert.match(lines[1], /^\[mailbox\] from agent-send:\/other \(stop, .*?\): second$/);
  assert.deepEqual(readUnacked(KEY, { dir: mboxDir }), []);
  const raw = fs.readFileSync(path.join(mboxDir, `${KEY}.jsonl`), 'utf-8');
  assert.equal(raw.split('\n').filter((l) => l.includes('"deliveredAs":"prompt"')).length, 2);
});

test('unreadable store prints the could-not-read line, never silence', () => {
  const notADir = path.join(root, 'not-a-dir');
  fs.writeFileSync(notADir, 'x');
  const res = runHook({ AGENT_MAILBOX_DIR: notADir });
  assert.equal(res.status, 0);
  assert.match(res.stdout, /^\[mailbox\] could not read inbox: /);
});

test('recordPresence without mailbox never clears an existing true (omp turn_start shape)', () => {
  const file = path.join(root, 'presence.json');
  recordPresence({ file, cwd: CWD, sessionId: SID, mailbox: true });
  recordPresence({ file, cwd: CWD, sessionId: SID });
  const beacons = JSON.parse(fs.readFileSync(file, 'utf-8')).beacons;
  const mine = beacons.filter((b) => b.cwd === CWD && b.sessionId === SID);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].mailbox, true);
});

// 2026-09-11 mailbox lifetime fix: after EnterWorktree the hook's cwd is the
// worktree path while the row sits under the pre-move key. The reader must
// scan by session id, not by the hook's current cwd.
test('a row under the pre-move key is delivered when the hook runs from the new cwd', () => {
  appendMessage({ to: KEY, from: 'agent-send:/other', priority: 'now', text: 'pre-move hello', dir: mboxDir });
  const res = spawnSync('node', [HOOK], {
    input: JSON.stringify({ cwd: '/repo/wt-a', session_id: SID }),
    encoding: 'utf-8',
    env: isolatedEnv({ HOME: homeDir, AGENT_SWITCHBOARD_DIR: switchDir, AGENT_MAILBOX_DIR: mboxDir, AGENT_SWITCHBOARD_PRESENCE_FILE: path.join(switchDir, 'presence.json') }),
  });
  assert.equal(res.status, 0);
  const parsed = JSON.parse(res.stdout);
  assert.match(parsed.hookSpecificOutput.additionalContext, /pre-move hello/);
  assert.deepEqual(readUnacked(KEY, { dir: mboxDir }), []);
});
