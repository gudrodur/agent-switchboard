// --topic collapses same-topic rows per recipient (agent-config#1379 W5).
//
// Run: node --test tests/mailbox-topic.test.mjs
import './helpers/isolate-setup.mjs';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isolatedEnv } from './helpers/isolate-env.mjs';
import { ack, appendMessage, readUnacked, readUnackedByRoles } from '../lib/agent-mailbox.mjs';

const SEND = fileURLToPath(new URL('../bin/agent-send.mjs', import.meta.url));
let dir;
before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mbox-topic-')); });
after(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const send = (to, from, text, topic) => appendMessage({ to, from, priority: 'now', text, topic, dir, now: Date.now() });

test('two senders, same topic, same recipient: one row, newest text, supersedes 1', () => {
  const key = '-t__one';
  send(key, 'alice', 'RESUME from alice', 'resume');
  const b = send(key, 'bob', 'RESUME from bob', 'resume');
  const got = readUnacked(key, { dir });
  assert.equal(got.length, 1);
  assert.equal(got[0].text, 'RESUME from bob');
  assert.equal(got[0].supersedes, 1);
  assert.equal(got[0].topic, 'resume');
  ack({ key, id: b.id, deliveredAs: 'prompt', dir });
  assert.deepEqual(readUnacked(key, { dir }), []);
});

test('a race (both rows land, no send-time withdraw) still yields one at drain, and none after ack', () => {
  const key = '-t__race';
  const a = send(key, 'alice', 'first', 'q1');
  const b = send(key, 'bob', 'second', 'q1');
  // Simulate the race: the later sender never saw the earlier row.
  fs.appendFileSync(path.join(dir, `${key}.jsonl`), `${JSON.stringify({ ...a, id: 'late-dup', ts: new Date(Date.now() + 5).toISOString(), text: 'third' })}\n`);
  const got = readUnacked(key, { dir });
  assert.equal(got.length, 1);
  assert.equal(got[0].text, 'third');
  assert.ok(got[0].supersedes >= 1);
  ack({ key, id: 'late-dup', deliveredAs: 'prompt', dir });
  assert.deepEqual(readUnacked(key, { dir }), [], `${a.id} ${b.id} must not resurface`);
});

test('different topics stay separate; no topic is unchanged', () => {
  const key = '-t__two';
  send(key, 'a', 'x', 'one');
  send(key, 'a', 'y', 'two');
  assert.equal(readUnacked(key, { dir }).length, 2);
  const k2 = '-t__none';
  send(k2, 'a', 'x');
  send(k2, 'b', 'y');
  const got = readUnacked(k2, { dir });
  assert.equal(got.length, 2);
  assert.ok(got.every((r) => r.supersedes === undefined && r.topic === undefined));
});

test('an already-acked earlier row is not counted as superseded', () => {
  const key = '-t__acked';
  const a = send(key, 'a', 'old', 'z');
  ack({ key, id: a.id, deliveredAs: 'prompt', dir });
  send(key, 'b', 'new', 'z');
  const got = readUnacked(key, { dir });
  assert.equal(got.length, 1);
  assert.ok(!got[0].supersedes);
});

test('the same topic to different recipients is not collapsed', () => {
  send('-t__r1', 'a', 'x', 'bc');
  send('-t__r2', 'a', 'x', 'bc');
  assert.equal(readUnacked('-t__r1', { dir }).length, 1);
  assert.equal(readUnacked('-t__r2', { dir }).length, 1);
});

test('role-addressed rows collapse too', () => {
  const key = 'role:lead';
  send(key, 'a', 'one', 'rt');
  send(key, 'b', 'two', 'rt');
  const got = readUnackedByRoles(['lead'], { dir });
  assert.equal(got.length, 1);
  assert.equal(got[0].row.text, 'two');
});

test('appendMessage rejects a bad topic slug', () => {
  assert.throws(() => appendMessage({ to: 'k', priority: 'now', text: 'x', topic: 'Bad Slug', dir }), /topic/);
});

const runSend = (args) => new Promise((resolve) => {
  const env = isolatedEnv({ AGENT_MAILBOX_DIR: dir, AGENT_MAILBOX_PRESENCE_FILE: path.join(dir, 'p.json') });
  const child = spawn('node', [SEND, ...args], { env });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  child.on('close', (code) => resolve({ code, stderr }));
});

test('the CLI rejects a bad slug and documents --topic', async () => {
  const bad = await runSend(['--to', 'k', '--text', 'x', '--topic', 'Bad Slug']);
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /--topic/);
  const help = await new Promise((r) => {
    const c = spawn('node', [SEND, '--help'], { env: isolatedEnv({}) });
    let out = '';
    c.stdout.on('data', (d) => { out += d; });
    c.on('close', () => r(out));
  });
  assert.match(help, /--topic/);
});
