// Tests for kitty-send.sh against a Claude Code tab (#38). Claude Code takes a
// long one-line send-text burst as a paste and swallows its trailing \r, so
// the text sits in the composer unsubmitted. kitty-send therefore sends a
// Claude tab the text alone and then a lone \r, with one more if needed. The proof is the tab's own transcript: a new user row carrying
// the text, found through <config>/sessions/<pid>.json (sessionId, cwd,
// status) and <config>/projects/<encoded cwd>/<sessionId>.jsonl.
//
// The PATH stub models the measured composer: a burst with its own \r
// swallows that \r and the next lone one; text alone is submitted by the
// next lone \r (mode "enter"). Mode "eat1" swallows the first lone \r anyway,
// "burst" submits on the text itself, "never" never submits.
//
// Run: node --test tests/kitty-send-claude.test.mjs  (or the full suite)
import './helpers/isolate-setup.mjs';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isolatedEnv } from './helpers/isolate-env.mjs';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const SCRIPT = fileURLToPath(new URL('../bin/kitty-send.sh', import.meta.url));
const WID = '991002';
const SID = '0000aaaa-1111-2222-3333-444455556666';
const CWD = '/tmp/cl.tab-cwd';
const ENC = '-tmp-cl-tab-cwd';

let binDir, stateDir, claudeDir, transcript;

before(async () => {
  binDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kitty-claude-bin-'));
  stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kitty-claude-state-'));
  claudeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kitty-claude-cfg-'));
  await fs.mkdir(path.join(claudeDir, 'sessions'));
  await fs.mkdir(path.join(claudeDir, 'projects', ENC), { recursive: true });
  transcript = path.join(claudeDir, 'projects', ENC, `${SID}.jsonl`);
  // The window pid and the claude pid must be alive: the test process is.
  const pid = process.pid;
  const lsJson = JSON.stringify([
    {
      tabs: [
        {
          title: 'mock',
          windows: [
            {
              id: Number(WID),
              title: '✳ Claude Code',
              pid,
              cwd: CWD,
              foreground_processes: [{ pid, cmdline: ['claude'], cwd: CWD }],
            },
          ],
        },
      ],
    },
  ]);
  const stub = [
    '#!/usr/bin/env bash',
    `state=${JSON.stringify(stateDir)}`,
    `transcript=${JSON.stringify(transcript)}`,
    'row() { jq -cn --arg t "$1" \'{type:"user",message:{role:"user",content:$t}}\' >> "$transcript"; }',
    'case "$1/$2" in',
    `  @/ls) printf '%s\\n' ${JSON.stringify(lsJson)} ;;`,
    '  @/send-text)',
    '    text="${@: -1}"',
    '    if [ "$text" = $\'\\r\' ]; then',
    '      echo enter >> "$state/calls"',
    '      if [ -f "$state/eat" ]; then rm -f "$state/eat"',
    '      elif [ "$(cat "$state/mode")" != never ] && [ -f "$state/composer" ]; then row "$(cat "$state/composer")"; rm -f "$state/composer"; fi',
    '    else',
    '      # the measured composer: a burst with its own \\r swallows that \\r and the next lone one',
    '      case "$text" in *$\'\\r\') echo burst >> "$state/calls"; touch "$state/eat" ;; *) echo text >> "$state/calls" ;; esac',
    '      [ "$(cat "$state/mode")" = eat1 ] && touch "$state/eat"',
    '      printf \'%s\' "${text%$\'\\r\'}" > "$state/composer"',
    '      # a tool result is a type:user row too; it must not count as the send',
    '      jq -cn \'{type:"user",message:{role:"user",content:[{type:"tool_result",content:"x"}]}}\' >> "$transcript"',
    '      if [ "$(cat "$state/mode")" = burst ]; then row "$(cat "$state/composer")"; rm -f "$state/composer"; fi',
    '    fi',
    '    ;;',
    '  @/send-key) echo send-key >> "$state/calls" ;;',
    "  @/get-text) printf '%s\\n' 'claude composer' ;;",
    'esac',
    'exit 0',
    '',
  ].join('\n');
  await fs.writeFile(path.join(binDir, 'kitty'), stub, { mode: 0o755 });
});

after(async () => {
  for (const d of [binDir, stateDir, claudeDir]) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
});

const reset = async (mode, status = 'idle') => {
  for (const f of ['calls', 'composer', 'eat']) await fs.rm(path.join(stateDir, f), { force: true });
  await fs.writeFile(path.join(stateDir, 'mode'), mode);
  await fs.writeFile(transcript, '{"type":"user","message":{"role":"user","content":"an earlier prompt"}}\n');
  await fs.writeFile(
    path.join(claudeDir, 'sessions', `${process.pid}.json`),
    JSON.stringify({ pid: process.pid, sessionId: SID, cwd: CWD, status }),
  );
};

const calls = async () => (await fs.readFile(path.join(stateDir, 'calls'), 'utf8').catch(() => '')).split('\n').filter(Boolean);

const runScript = async (args) => {
  try {
    const r = await run(SCRIPT, args, {
      env: isolatedEnv({
        PATH: `${binDir}:${process.env.PATH}`,
        XDG_RUNTIME_DIR: stateDir,
        CLAUDE_CONFIG_DIR: claudeDir,
        KITTY_SEND_CLAUDE_ENTER_AFTER: '2',
      }),
      timeout: 30_000,
    });
    return { code: 0, out: r.stdout, err: r.stderr };
  } catch (e) {
    return { code: e.code ?? 1, out: e.stdout ?? '', err: e.stderr ?? '' };
  }
};

const MSG = 'Note from the overseer: read /tmp/x/ready-1567.txt, a long one-line steer that Claude Code takes as a paste';

test('a Claude tab gets the text, then one lone \\r, and is proved by its transcript', async () => {
  await reset('enter');
  const r = await runScript(['--to', WID, '--text', MSG, '--timeout', '8']);
  assert.equal(r.code, 0, `${r.out}${r.err}`);
  assert.match(r.err, /proved by transcript row/);
  assert.deepEqual(await calls(), ['text', 'enter'], 'the text without its \\r, then exactly one lone \\r; no send-key');
});

test('a composer that swallows the first lone \\r is submitted by a second, and no third is sent', async () => {
  await reset('eat1');
  const r = await runScript(['--to', WID, '--text', MSG, '--timeout', '8']);
  assert.equal(r.code, 0, `${r.out}${r.err}`);
  assert.deepEqual(await calls(), ['text', 'enter', 'enter']);
});

test('a Claude tab that submits on the text alone gets no \\r', async () => {
  await reset('burst');
  const r = await runScript(['--to', WID, '--text', MSG, '--timeout', '8']);
  assert.equal(r.code, 0, `${r.out}${r.err}`);
  assert.deepEqual(await calls(), ['text']);
});

test('a Claude tab that never submits is exit 3 after two lone \\r; a tool-result row does not count', async () => {
  await reset('never');
  const r = await runScript(['--to', WID, '--text', MSG, '--timeout', '5']);
  assert.equal(r.code, 3, `${r.out}${r.err}`);
  assert.match(r.err, /Claude Code tab\) and pressed 2 lone Enter/);
  assert.match(r.err, /may still sit in its composer/);
  assert.deepEqual(await calls(), ['text', 'enter', 'enter'], 'two lone \\r at most, never a third');
});

test('a Claude tab whose session status is busy is refused (exit 7), nothing sent', async () => {
  await reset('burst', 'busy');
  const r = await runScript(['--to', WID, '--text', MSG, '--timeout', '4']);
  assert.equal(r.code, 7, `${r.out}${r.err}`);
  assert.deepEqual(await calls(), []);
});
