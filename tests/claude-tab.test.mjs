// Tests for claude-tab.sh: the argument gate, the kitty gate, and the start
// proof (a new Claude Code transcript in --cwd's projects dir, its model, and
// with --rc its bridge-session row).
//
// Same method as opencode-tab.test.mjs: a PATH stub for `kitty` records launch
// and close-window and serves one live window, `sleep` is a no-op. The stub's
// launch copies $state/session.jsonl into the transcripts dir, the way Claude
// Code writes its first rows after the tab starts.
//
// Run: node --test tests/claude-tab.test.mjs
import './helpers/isolate-setup.mjs';
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolatedEnv } from './helpers/isolate-env.mjs';

const run = promisify(execFile);
const SCRIPT = fileURLToPath(new URL('../bin/claude-tab.sh', import.meta.url));
const WID = 992101;

let binDir, stateDir, cwd, brief, projects, tdir, config;

before(async () => {
  binDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cltab-bin-'));
  stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cltab-state-'));
  cwd = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cltab-cwd-')));
  brief = path.join(stateDir, 'brief.md');
  await fs.writeFile(brief, '# Brief\n');
  projects = path.join(stateDir, 'projects');
  tdir = path.join(projects, cwd.replace(/[^A-Za-z0-9-]/g, '-'));
  config = path.join(stateDir, 'claude.json');
  const lsJson = `[{"tabs":[{"windows":[{"id":${WID},"pid":${process.pid}}]}]}]`;
  await fs.writeFile(
    path.join(binDir, 'kitty'),
    [
      '#!/usr/bin/env bash',
      `state=${JSON.stringify(stateDir)}`,
      `tdir=${JSON.stringify(tdir)}`,
      'case "$1/$2" in',
      '  @/ls) [ -f "$state/nokitty" ] && exit 1',
      '        if [ -f "$state/gone" ]; then echo "[]"; else printf \'%s\\n\' ' + JSON.stringify(lsJson) + '; fi ;;',
      '  @/launch) printf \'%s\\n\' "$@" > "$state/launch-args"',
      '            [ -f "$state/session.jsonl" ] && mkdir -p "$tdir" && cp "$state/session.jsonl" "$tdir/new-session.jsonl"',
      '            echo ' + WID + ' ;;',
      '  @/close-window) printf \'%s\\n\' "$*" > "$state/closed" ;;',
      'esac',
      'exit 0',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  await fs.writeFile(path.join(binDir, 'sleep'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
  await fs.writeFile(path.join(binDir, 'claude'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
});

after(async () => {
  for (const d of [binDir, stateDir, cwd]) await fs.rm(d, { recursive: true, force: true });
});

beforeEach(async () => {
  for (const f of ['launch-args', 'closed', 'nokitty', 'gone', 'session.jsonl', 'omp-tab-launched.' + os.userInfo().uid]) {
    await fs.rm(path.join(stateDir, f), { force: true });
  }
  await fs.rm(projects, { recursive: true, force: true });
  await trust(path.dirname(cwd));
});

// Folder trust as Claude Code keeps it; set on the parent, so the test also
// covers inheritance.
const trust = (dir, accepted = true) =>
  fs.writeFile(config, JSON.stringify({ projects: { [dir]: { hasTrustDialogAccepted: accepted } } }));

// The rows Claude Code writes: a notice on "<synthetic>", then the first real
// assistant turn; `bridge` adds the Remote Control row.
const session = (model, { bridge = false } = {}) => {
  const rows = [
    { type: 'user', cwd, message: { role: 'user', content: 'Read the brief' } },
    { type: 'assistant', cwd, message: { model: '<synthetic>', content: [] } },
    { type: 'assistant', cwd, message: { model, content: [] } },
  ];
  if (bridge) rows.push({ type: 'bridge-session', cwd });
  return fs.writeFile(path.join(stateDir, 'session.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
};

const tab = async (args) => {
  try {
    const r = await run('bash', [SCRIPT, ...args], {
      env: isolatedEnv({
        PATH: `${binDir}:${process.env.PATH}`,
        XDG_RUNTIME_DIR: stateDir,
        CLAUDE_SESSION_ID: 'test-launcher',
        CLAUDE_TAB_PROJECTS: projects,
        CLAUDE_TAB_CONFIG: config,
        OMP_TAB_TASK_CLAIM: path.join(stateDir, 'no-claim-cli.mjs'),
      }),
    });
    return { code: 0, out: r.stdout, err: r.stderr };
  } catch (e) {
    return { code: e.code, out: e.stdout, err: e.stderr };
  }
};
const exists = (f) => fs.access(path.join(stateDir, f)).then(() => true, () => false);
const full = (...extra) => ['--title', 'claude: test', '--brief', brief, '--model', 'opus', '--cwd', cwd, ...extra];
const stateRows = () => fs.readFile(path.join(stateDir, 'omp-tab-launched.' + os.userInfo().uid), 'utf8');

test('--help prints the usage block and nothing else', async () => {
  const r = await tab(['--help']);
  assert.equal(r.code, 0);
  assert.match(r.out, /^Usage:/);
  assert.doesNotMatch(r.out, /HELP-(BEGIN|END)/);
});

test('--model is required, and nothing is launched without it', async () => {
  const r = await tab(['--title', 't', '--brief', brief, '--cwd', cwd]);
  assert.equal(r.code, 1);
  assert.match(r.err, /--model is required/);
  assert.equal(await exists('launch-args'), false);
});

test('a model that is not a Claude alias or id is refused', async () => {
  const r = await tab(['--title', 't', '--brief', brief, '--model', 'gpt-5', '--cwd', cwd]);
  assert.equal(r.code, 1);
  assert.match(r.err, /--model takes opus/);
});

test('a relative --brief is refused', async () => {
  const r = await tab(['--title', 't', '--brief', 'brief.md', '--model', 'opus', '--cwd', cwd]);
  assert.equal(r.code, 1);
  assert.match(r.err, /--brief must be absolute/);
});

test('an untrusted folder is refused before launch', async () => {
  await trust(cwd, false);
  const r = await tab(full());
  assert.equal(r.code, 1);
  assert.match(r.err, /has not trusted .* nothing launched/s);
  assert.equal(await exists('launch-args'), false);
});

test('no kitty remote control exits 2', async () => {
  await fs.writeFile(path.join(stateDir, 'nokitty'), '');
  const r = await tab(full());
  assert.equal(r.code, 2);
  assert.equal(await exists('launch-args'), false);
});

test('a new session on the asked family: exit 0, SESSION printed, state row written', async () => {
  await session('claude-opus-5-5');
  const r = await tab(full());
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, new RegExp(`^WINDOW_ID=${WID}$`, 'm'));
  assert.match(r.out, new RegExp(`^SESSION=${tdir}/new-session\\.jsonl$`, 'm'));
  assert.match(r.err, /on claude-opus-5-5/);
  const args = await fs.readFile(path.join(stateDir, 'launch-args'), 'utf8');
  assert.match(args, /^claude\n--model\nopus\n/m);
  assert.doesNotMatch(args, /--remote-control/);
  assert.match(args, new RegExp(`^Read ${brief} and carry it out`, 'm'));
  assert.equal(await stateRows(), `${WID} ${process.pid} @test-launcher claude: test\n`);
  assert.equal(await exists('closed'), false);
});

test('a full model id must match exactly, context suffix aside', async () => {
  await session('claude-opus-5-5');
  const ok = await tab(['--title', 't', '--brief', brief, '--model', 'claude-opus-5-5[1m]', '--cwd', cwd]);
  assert.equal(ok.code, 0, ok.err);
  await fs.rm(projects, { recursive: true, force: true });
  const bad = await tab(['--title', 't', '--brief', brief, '--model', 'claude-opus-5', '--cwd', cwd]);
  assert.equal(bad.code, 3);
});

test('a session on another model closes the window and exits 3', async () => {
  await session('claude-sonnet-5-5');
  const r = await tab(full());
  assert.equal(r.code, 3);
  assert.match(r.err, /is on model claude-sonnet-5-5 but was launched as opus/);
  assert.match(await fs.readFile(path.join(stateDir, 'closed'), 'utf8'), new RegExp(`id:${WID}`));
  assert.equal(await stateRows(), '');
});

test('--rc passes --remote-control and needs the bridge-session row', async () => {
  await session('claude-opus-5-5', { bridge: true });
  const r = await tab(full('--rc', 'xj 1567'));
  assert.equal(r.code, 0, r.err);
  assert.match(await fs.readFile(path.join(stateDir, 'launch-args'), 'utf8'), /^--remote-control\nxj 1567$/m);
  assert.match(r.err, /Remote Control "xj 1567"/);
});

test('--rc with no name uses the title', async () => {
  await session('claude-opus-5-5', { bridge: true });
  const r = await tab(full('--rc'));
  assert.equal(r.code, 0, r.err);
  assert.match(await fs.readFile(path.join(stateDir, 'launch-args'), 'utf8'), /^--remote-control\nclaude: test$/m);
});

test('--rc without a bridge-session row is not proven: exit 3, window left open', async () => {
  await session('claude-opus-5-5');
  const r = await tab(full('--rc', 'x'));
  assert.equal(r.code, 3);
  assert.match(r.err, /not proven within 90 s .*bridge=0/);
  assert.equal(await exists('closed'), false);
});

test('a transcript that was there before the launch is not taken as proof', async () => {
  await fs.mkdir(tdir, { recursive: true });
  await session('claude-opus-5-5');
  await fs.copyFile(path.join(stateDir, 'session.jsonl'), path.join(tdir, 'old.jsonl'));
  await fs.rm(path.join(stateDir, 'session.jsonl'));
  const r = await tab(full());
  assert.equal(r.code, 3);
  assert.match(r.err, /session=none/);
});

test('a window that dies at launch exits 3 and writes no state row', async () => {
  await fs.writeFile(path.join(stateDir, 'gone'), '');
  const r = await tab(full());
  assert.equal(r.code, 3);
  assert.match(r.err, /exited immediately after launch/);
  assert.equal(await exists('omp-tab-launched.' + os.userInfo().uid), false);
});
