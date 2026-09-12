// Hermetic tests for hooks/omp/pre/mailbox.ts drain and watch logic.
//
// No omp runtime, no presence file, no kitty, no network: drainInbox,
// deliverIdle and watchMatches run against a temp mailbox dir through the
// existing {dir} seam. The hook's .ts source loads directly under node >= 24
// type stripping (verified 2026-09-12: no build step needed).
//
// Run: node --test tests/mailbox-hook.test.mjs (or the full suite)
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  appendMessage,
  readUnacked,
  readUnackedBySession,
  recipientKey,
} from '../lib/agent-mailbox.mjs';
import {
  drainInbox,
  deliverIdle,
  watchMatches,
} from '../hooks/omp/pre/mailbox.ts';

const CWD = '/example/proj';
const OLD_CWD = '/example/old-proj';
const SID = 'hook-s1';
const OTHER_SID = 'hook-other';

let dir;
before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mbox-hook-'));
});

const freshDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mbox-hook-'));

test('drainInbox acks across pre- and post-move keys and maps priorities', () => {
  const d = freshDir();
  const nowKey = recipientKey({ cwd: CWD, sessionId: SID });
  const oldKey = recipientKey({ cwd: OLD_CWD, sessionId: SID });
  appendMessage({ to: nowKey, from: 'agent-send:/o', priority: 'now', text: 'steer me', dir: d });
  appendMessage({ to: oldKey, from: 'agent-send:/o', priority: 'queue', text: 'later', dir: d });
  const delivered = drainInbox({ cwd: CWD, sessionId: SID, dir: d });
  assert.equal(delivered.length, 2);
  const byText = Object.fromEntries(delivered.map(({ row, deliveredAs }) => [row.text, deliveredAs]));
  assert.equal(byText['steer me'], 'steer');
  assert.equal(byText['later'], 'followUp');
  assert.deepEqual(readUnackedBySession(SID, { dir: d }), []);
  const raw = fs.readFileSync(path.join(d, `${nowKey}.jsonl`), 'utf-8');
  assert.match(raw, /"deliveredAs":"steer"/);
});

test('drainInbox with no session id drains the current key only', () => {
  const d = freshDir();
  const mine = recipientKey({ cwd: CWD, sessionId: null });
  const theirs = recipientKey({ cwd: CWD, sessionId: OTHER_SID });
  appendMessage({ to: mine, from: 'agent-send:/o', priority: 'idle', text: 'mine', dir: d });
  appendMessage({ to: theirs, from: 'agent-send:/o', priority: 'now', text: 'theirs', dir: d });
  const delivered = drainInbox({ cwd: CWD, sessionId: null, dir: d });
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].row.text, 'mine');
  assert.equal(delivered[0].deliveredAs, 'followUp');
  assert.equal(readUnacked(theirs, { dir: d }).length, 1);
});

test('deliverIdle sends nothing while busy and leaves rows unacked', () => {
  const d = freshDir();
  const key = recipientKey({ cwd: CWD, sessionId: SID });
  appendMessage({ to: key, from: 'agent-send:/o', priority: 'now', text: 'parked?', dir: d });
  const sent = [];
  const delivered = deliverIdle({ cwd: CWD, sessionId: SID, dir: d, isIdle: () => false, send: (...a) => sent.push(a) });
  assert.deepEqual(delivered, []);
  assert.deepEqual(sent, []);
  assert.equal(readUnacked(key, { dir: d }).length, 1);
});

test('deliverIdle wakes the parked session with triggerTurn and acks first', () => {
  const d = freshDir();
  const key = recipientKey({ cwd: CWD, sessionId: SID });
  appendMessage({ to: key, from: 'agent-send:/o', priority: 'stop', text: 'wake me', dir: d });
  const sent = [];
  const delivered = deliverIdle({ cwd: CWD, sessionId: SID, dir: d, isIdle: () => true, send: (...a) => sent.push(a) });
  assert.equal(delivered.length, 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0][1].deliverAs, 'steer');
  assert.equal(sent[0][1].triggerTurn, true);
  assert.match(sent[0][0].content, /\[mailbox\] from agent-send:\/o \(stop\): wake me/);
  assert.deepEqual(readUnacked(key, { dir: d }), []);
});

test('deliverIdle sends nothing on an empty drain, so ack appends cannot wake in a loop', () => {
  const d = freshDir();
  const sent = [];
  const delivered = deliverIdle({ cwd: CWD, sessionId: SID, dir: d, isIdle: () => true, send: (...a) => sent.push(a) });
  assert.deepEqual(delivered, []);
  assert.deepEqual(sent, []);
});

test('a drain failure reports once, display-only, and never wakes', () => {
  const d = freshDir();
  const key = recipientKey({ cwd: CWD, sessionId: SID });
  appendMessage({ to: key, from: 'agent-send:/o', priority: 'now', text: 'stuck', dir: d });
  // Reads succeed but the ack append fails: the drain throws after reading.
  fs.chmodSync(path.join(d, `${key}.jsonl`), 0o444);
  const sent = [];
  const args = { cwd: CWD, sessionId: SID, dir: d, isIdle: () => true, send: (...a) => sent.push(a) };
  assert.deepEqual(deliverIdle(args), []);
  assert.deepEqual(deliverIdle(args), []);
  assert.equal(sent.length, 1, 'the second poll must not report again');
  assert.equal(sent[0][0].display, true);
  assert.match(sent[0][0].content, /^\[mailbox\] could not drain the mailbox: /);
  assert.equal(sent[0].length, 1, 'a failure report carries no options: no triggerTurn, no wake');
});

test('watchMatches gates on the session suffix, pre-move keys included', () => {
  const sid = 'hook-watch-9';
  const preKey = `${recipientKey({ cwd: OLD_CWD, sessionId: sid })}.jsonl`;
  const postKey = `${recipientKey({ cwd: CWD, sessionId: sid })}.jsonl`;
  assert.equal(watchMatches(postKey, { cwd: CWD, sessionId: sid }), true);
  assert.equal(watchMatches(preKey, { cwd: CWD, sessionId: sid }), true);
  assert.equal(watchMatches(`${recipientKey({ cwd: CWD, sessionId: OTHER_SID })}.jsonl`, { cwd: CWD, sessionId: sid }), false);
  assert.equal(watchMatches('presence.json', { cwd: CWD, sessionId: sid }), false);
  assert.equal(watchMatches(null, { cwd: CWD, sessionId: sid }), false);
  assert.equal(watchMatches('', { cwd: CWD, sessionId: sid }), false);
});

test('watchMatches without a session id matches only the current key file', () => {
  const exact = `${recipientKey({ cwd: CWD, sessionId: null })}.jsonl`;
  assert.equal(watchMatches(exact, { cwd: CWD, sessionId: null }), true);
  assert.equal(watchMatches(`${recipientKey({ cwd: OLD_CWD, sessionId: null })}.jsonl`, { cwd: CWD, sessionId: null }), false);
});
