// Tests for hooks/claude/mailbox-stop.mjs (the Stop-time mailbox drain).
// Run as a subprocess like mailbox-inject.test.mjs: stdin carries the Stop
// payload, AGENT_MAILBOX_DIR points the store at a temp dir.
import './helpers/isolate-setup.mjs';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isolatedEnv } from './helpers/isolate-env.mjs';
import { appendMessage, readUnacked } from '../lib/agent-mailbox.mjs';

const HOOK = fileURLToPath(new URL('../hooks/claude/mailbox-stop.mjs', import.meta.url));
const CWD = '/repo/s';
const SID = 'stop1';
const KEY = '-repo-s__stop1';

let root, mboxDir, homeDir, switchDir;

const runHook = (env = {}, payload = { cwd: CWD, session_id: SID, stop_hook_active: false }) =>
  spawnSync('node', [HOOK], {
    input: JSON.stringify(payload),
    encoding: 'utf-8',
    env: isolatedEnv({ HOME: homeDir, AGENT_SWITCHBOARD_DIR: switchDir, AGENT_MAILBOX_DIR: mboxDir, AGENT_SWITCHBOARD_PRESENCE_FILE: path.join(switchDir, 'presence.json'), ...env }),
  });

before(async () => {
  root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mbox-stop-'));
  mboxDir = path.join(root, 'mbox');
  homeDir = path.join(root, 'home');
  switchDir = path.join(root, 'switchboard');
  for (const d of [mboxDir, homeDir, switchDir]) fs.mkdirSync(d, { recursive: true });
});

test('empty inbox prints nothing and exits 0', () => {
  const res = runHook();
  assert.equal(res.status, 0);
  assert.equal(res.stdout, '');
});

test('a queued row prints block JSON with the text and is acked as stop', () => {
  appendMessage({ to: KEY, from: 'agent-send:/other', priority: 'now', text: 'wake up please', dir: mboxDir });
  const res = runHook({}, { cwd: CWD, session_id: SID, stop_hook_active: true });
  assert.equal(res.status, 0);
  const out = JSON.parse(res.stdout);
  assert.equal(out.decision, 'block');
  assert.match(out.reason, /arrived after your turn ended/);
  assert.match(out.reason, /\[mailbox\] from agent-send:\/other \(now, .*?\): wake up please/);
  assert.deepEqual(readUnacked(KEY, { dir: mboxDir }), []);
  const raw = fs.readFileSync(path.join(mboxDir, `${KEY}.jsonl`), 'utf-8');
  assert.equal(raw.split('\n').filter((l) => l.includes('"deliveredAs":"stop"')).length, 1);
});

test('a second run right after prints nothing', () => {
  const res = runHook();
  assert.equal(res.status, 0);
  assert.equal(res.stdout, '');
});

test('a row whose ack cannot be written is not shown, so it cannot block every Stop', () => {
  const key = '-repo-s__stop2';
  appendMessage({ to: key, from: 'agent-send:/other', priority: 'now', text: 'stuck', dir: mboxDir });
  const file = path.join(mboxDir, `${key}.jsonl`);
  fs.chmodSync(file, 0o444);
  try {
    for (let i = 0; i < 2; i++) {
      const res = runHook({}, { cwd: CWD, session_id: 'stop2', stop_hook_active: i > 0 });
      assert.equal(res.status, 0);
      assert.equal(res.stdout, '');
    }
    assert.equal(readUnacked(key, { dir: mboxDir }).length, 1, 'still queued for the next prompt');
  } finally {
    fs.chmodSync(file, 0o644);
  }
});

test('a broken store exits 0 with empty stdout', () => {
  const notADir = path.join(root, 'not-a-dir');
  fs.writeFileSync(notADir, 'x');
  const res = runHook({ AGENT_MAILBOX_DIR: notADir });
  assert.equal(res.status, 0);
  assert.equal(res.stdout, '');
});
