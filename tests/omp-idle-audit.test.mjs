// Tests for bin/omp-idle-audit.mjs.
//
// Fixtures live in tests/omp-idle-audit.corpus.jsonl, a SYNTHETIC file
// written by hand copying the real session row shapes (message rows with
// role user/assistant/toolResult, assistant rows carrying stopReason
// toolUse/stop and content[] of text/toolCall, toolResult rows carrying
// toolCallId/toolName plus content[] of text, custom_message rows carrying
// customType plus content as a string, plus session/title/custom noise
// rows). No real paths or command output appear in it. The corpus walks
// eight scenarios in order, completing each job before the next starts so
// the stops stay isolated: a stop with a job alive (idle-with-job-alive), a
// parking-line stop with a job alive (parked-with-job-alive), an id reused
// after completion (exactly one alive job at the stop), a
// completed-then-stop with nothing alive, an anchored start after partial
// output ended by a hub wait heading, embedded phrase rows (read echo and
// bash JSON quote) that must not start a job, a hub Still listing that must
// not end the job followed by a hub cancel that does, and a double
// completion (hub then async-result) that must not throw.
//
// Run: node --test tests/omp-idle-audit.test.mjs (or the full suite)
import './helpers/isolate-setup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { aliveAtEnd, aliveAtEndOfFile, auditFile, auditRows } from '../bin/omp-idle-audit.mjs';

const SCRIPT = fileURLToPath(new URL('../bin/omp-idle-audit.mjs', import.meta.url));
const CORPUS = fileURLToPath(new URL('./omp-idle-audit.corpus.jsonl', import.meta.url));

const findings = auditFile(CORPUS);
const at = (ts) => findings.find((f) => f.timestamp === ts);

test('a stop with a live job and no parking line is idle-with-job-alive', () => {
  const f = at('2026-01-01T00:01:00.000Z');
  assert.ok(f, 'expected a finding at the 00:01 stop');
  assert.equal(f.class, 'idle-with-job-alive');
  assert.deepEqual(f.jobs.map((j) => j.id), ['bg_7']);
  assert.equal(f.jobs[0].startedAt, '2026-01-01T00:00:05.000Z');
  assert.equal(f.jobs[0].command, 'sleep 300; echo poll-done');
  assert.equal(f.lastText, 'Working on the thing, will check the poll soon.');
});

test('a parking-line stop with a live job is parked-with-job-alive', () => {
  const f = at('2026-01-01T00:04:00.000Z');
  assert.ok(f, 'expected a finding at the 00:04 stop');
  assert.equal(f.class, 'parked-with-job-alive');
  assert.deepEqual(f.jobs.map((j) => j.id), ['bg_8']);
  assert.equal(f.jobs[0].startedAt, '2026-01-01T00:03:05.000Z');
  assert.equal(f.jobs[0].command, 'sleep 120; echo watch-done');
});

test('a reused id reports exactly one alive job from the second start', () => {
  const f = at('2026-01-01T00:08:00.000Z');
  assert.ok(f, 'expected a finding at the 00:08 stop');
  assert.equal(f.class, 'idle-with-job-alive');
  assert.equal(f.jobs.length, 1);
  assert.equal(f.jobs[0].id, 'bg_21');
  assert.equal(f.jobs[0].startedAt, '2026-01-01T00:07:05.000Z');
  assert.ok(f.jobs[0].command.length <= 120, 'command is cut at 120 chars');
  assert.ok(f.jobs[0].command.startsWith('echo second-run'));
});

test('a completed-then-stop with nothing alive emits no finding', () => {
  assert.equal(at('2026-01-01T00:11:00.000Z'), undefined);
});

test('an anchored start after partial output is a live job until hub completes it', () => {
  const f = at('2026-01-01T00:14:00.000Z');
  assert.ok(f, 'expected a finding at the 00:14 stop');
  assert.equal(f.class, 'idle-with-job-alive');
  assert.deepEqual(f.jobs.map((j) => j.id), ['bg_30']);
  assert.equal(f.jobs[0].command, 'git push origin docs/test 2>&1 | tail -2');
  assert.equal(at('2026-01-01T00:15:00.000Z'), undefined);
});

test('an embedded phrase in a read echo or bash JSON quote starts no job', () => {
  assert.equal(at('2026-01-01T00:16:30.000Z'), undefined);
  assert.equal(at('2026-01-01T00:17:30.000Z'), undefined);
});

test('a hub Still listing keeps the job alive; a hub cancel ends it', () => {
  const f = at('2026-01-01T00:19:00.000Z');
  assert.ok(f, 'expected a finding at the 00:19 stop');
  assert.deepEqual(f.jobs.map((j) => j.id), ['bg_33']);
  assert.equal(at('2026-01-01T00:20:00.000Z'), undefined);
});

test('a double completion (hub then async-result) emits no finding', () => {
  assert.equal(at('2026-01-01T00:22:00.000Z'), undefined);
  assert.equal(findings.length, 5);
});

test('a hub failed heading ends the job', () => {
  const rows = [
    {
      type: 'message',
      id: 'a',
      timestamp: '2026-01-01T00:00:01.000Z',
      message: {
        role: 'assistant',
        stopReason: 'toolUse',
        content: [
          { type: 'toolCall', id: 'c-1', name: 'bash', arguments: { command: 'exit 1' } },
        ],
      },
    },
    {
      type: 'message',
      id: 'r',
      timestamp: '2026-01-01T00:00:02.000Z',
      message: {
        role: 'toolResult',
        toolCallId: 'c-1',
        toolName: 'bash',
        content: [{ type: 'text', text: 'Backgrounded as job bg_5; result will be delivered automatically.' }],
      },
    },
    {
      type: 'message',
      id: 'h',
      timestamp: '2026-01-01T00:00:03.000Z',
      message: {
        role: 'toolResult',
        toolCallId: 'c-h',
        toolName: 'hub',
        content: [{ type: 'text', text: '## Completed (1)\n\n### bg_5 [bash] — failed\nLabel: exit 1' }],
      },
    },
    {
      type: 'message',
      id: 's',
      timestamp: '2026-01-01T00:00:04.000Z',
      message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'done' }] },
    },
  ];
  assert.deepEqual(auditRows(rows), []);
});

test('a completion notice without the async-result customType ends nothing', () => {
  const rows = [
    {
      type: 'message',
      id: 'a',
      timestamp: '2026-01-01T00:00:01.000Z',
      message: {
        role: 'assistant',
        stopReason: 'toolUse',
        content: [
          { type: 'toolCall', id: 'c-1', name: 'bash', arguments: { command: 'sleep 1' } },
        ],
      },
    },
    {
      type: 'message',
      id: 'r',
      timestamp: '2026-01-01T00:00:02.000Z',
      message: {
        role: 'toolResult',
        toolCallId: 'c-1',
        toolName: 'bash',
        content: [{ type: 'text', text: 'Backgrounded as job bg_6; result will be delivered automatically.' }],
      },
    },
    {
      type: 'custom_message',
      id: 'n',
      timestamp: '2026-01-01T00:00:03.000Z',
      content: '<system-notice>\nBackground job bg_6 has completed.',
    },
    {
      type: 'message',
      id: 's',
      timestamp: '2026-01-01T00:00:04.000Z',
      message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'waiting' }] },
    },
  ];
  const out = auditRows(rows);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].jobs.map((j) => j.id), ['bg_6']);
});

test('a file with no stops at all emits zero findings', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idle-audit-'));
  const file = path.join(dir, 'nostop.jsonl');
  fs.writeFileSync(
    file,
    [
      JSON.stringify({ type: 'session', id: 's', timestamp: '2026-01-01T00:00:01.000Z', cwd: '/tmp/fixture' }),
      JSON.stringify({
        type: 'message',
        id: 'a',
        timestamp: '2026-01-01T00:00:02.000Z',
        message: { role: 'assistant', stopReason: 'toolUse', content: [] },
      }),
    ].join('\n') + '\n',
  );
  assert.deepEqual(auditFile(file), []);
});

test('the CLI --format=json output parses and matches the library', () => {
  const proc = spawnSync(process.execPath, [SCRIPT, CORPUS, '--format=json'], { encoding: 'utf8' });
  assert.equal(proc.status, 0, proc.stderr);
  assert.deepEqual(JSON.parse(proc.stdout), findings);
});

test('the CLI text output is one line per finding', () => {
  const proc = spawnSync(process.execPath, [SCRIPT, CORPUS], { encoding: 'utf8' });
  assert.equal(proc.status, 0, proc.stderr);
  const lines = proc.stdout.trim().split('\n');
  assert.equal(lines.length, 5);
  assert.ok(lines[0].startsWith('2026-01-01T00:01:00.000Z idle-with-job-alive bg_7'));
  assert.ok(lines[1].startsWith('2026-01-01T00:04:00.000Z parked-with-job-alive bg_8'));
  assert.ok(lines[2].startsWith('2026-01-01T00:08:00.000Z idle-with-job-alive bg_21'));
  assert.ok(lines[3].startsWith('2026-01-01T00:14:00.000Z idle-with-job-alive bg_30'));
  assert.ok(lines[4].startsWith('2026-01-01T00:19:00.000Z idle-with-job-alive bg_33'));
});

test('the CLI with two files prefixes basenames and prints per-file plus total lines', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idle-audit-'));
  const file = path.join(dir, 'second.jsonl');
  fs.writeFileSync(file, '{"type":"session","id":"s","timestamp":"2026-01-01T00:00:01.000Z","cwd":"/tmp/fixture"}\n');
  const proc = spawnSync(process.execPath, [SCRIPT, CORPUS, file], { encoding: 'utf8' });
  assert.equal(proc.status, 0, proc.stderr);
  const lines = proc.stdout.trim().split('\n');
  const base = path.basename(CORPUS);
  assert.ok(lines[0].startsWith(`${base}: 2026-01-01T00:01:00.000Z idle-with-job-alive bg_7`));
  assert.ok(lines.includes(`${base}: 5 findings (4 idle-with-job-alive, 1 parked-with-job-alive)`));
  assert.ok(lines.includes('second.jsonl: 0 findings (0 idle-with-job-alive, 0 parked-with-job-alive)'));
  assert.ok(lines[lines.length - 1].startsWith('total: 5 findings in 2 files'));
});

test('the CLI with two files and --format=json returns per-file objects', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idle-audit-'));
  const file = path.join(dir, 'second.jsonl');
  fs.writeFileSync(file, '{"type":"session","id":"s","timestamp":"2026-01-01T00:00:01.000Z","cwd":"/tmp/fixture"}\n');
  const proc = spawnSync(process.execPath, [SCRIPT, CORPUS, file, '--format=json'], { encoding: 'utf8' });
  assert.equal(proc.status, 0, proc.stderr);
  const out = JSON.parse(proc.stdout);
  assert.equal(out.length, 2);
  assert.equal(out[0].file, CORPUS);
  assert.deepEqual(out[0].findings, findings);
  assert.deepEqual(out[0].summary, { findings: 5, idleWithJobAlive: 4, parkedWithJobAlive: 1 });
  assert.deepEqual(out[1].findings, []);
});

test('the CLI text output keeps one line per finding when lastText has newlines', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idle-audit-'));
  const file = path.join(dir, 'multiline.jsonl');
  fs.writeFileSync(
    file,
    [
      JSON.stringify({
        type: 'message',
        id: 'a',
        timestamp: '2026-01-01T00:00:01.000Z',
        message: {
          role: 'assistant',
          stopReason: 'toolUse',
          content: [{ type: 'toolCall', id: 'c-1', name: 'bash', arguments: { command: 'sleep 5' } }],
        },
      }),
      JSON.stringify({
        type: 'message',
        id: 'r',
        timestamp: '2026-01-01T00:00:02.000Z',
        message: {
          role: 'toolResult',
          toolCallId: 'c-1',
          toolName: 'bash',
          content: [{ type: 'text', text: 'Backgrounded as job bg_2; result will be delivered automatically.' }],
        },
      }),
      JSON.stringify({
        type: 'message',
        id: 's',
        timestamp: '2026-01-01T00:00:03.000Z',
        message: {
          role: 'assistant',
          stopReason: 'stop',
          content: [{ type: 'text', text: 'line one\nline two\nline three' }],
        },
      }),
    ].join('\n') + '\n',
  );
  const proc = spawnSync(process.execPath, [SCRIPT, file], { encoding: 'utf8' });
  assert.equal(proc.status, 0, proc.stderr);
  assert.equal(proc.stdout.trim().split('\n').length, 1);
});

test('--alive reports the started-not-completed set at end of file', () => {
  const rows = [
    {
      type: 'message',
      id: 'a',
      timestamp: '2026-01-01T00:00:01.000Z',
      message: {
        role: 'assistant',
        stopReason: 'toolUse',
        content: [
          { type: 'toolCall', id: 'c-1', name: 'bash', arguments: { command: 'sleep 300; echo poll-done' } },
        ],
      },
    },
    {
      type: 'message',
      id: 'r',
      timestamp: '2026-01-01T00:00:02.000Z',
      message: {
        role: 'toolResult',
        toolCallId: 'c-1',
        toolName: 'bash',
        content: [{ type: 'text', text: 'Backgrounded as job bg_9; result will be delivered automatically.' }],
      },
    },
    {
      type: 'message',
      id: 's',
      timestamp: '2026-01-01T00:00:03.000Z',
      message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'waiting on the loop' }] },
    },
  ];
  assert.deepEqual(aliveAtEnd(rows), [
    { id: 'bg_9', startedAt: '2026-01-01T00:00:02.000Z', command: 'sleep 300; echo poll-done' },
  ]);
});

test('--alive on the corpus finds nothing alive at the end', () => {
  assert.deepEqual(aliveAtEndOfFile(CORPUS), []);
});

test('the CLI --alive text output is one line per live job, nothing when none', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idle-audit-alive-'));
  const live = path.join(dir, 'live.jsonl');
  fs.writeFileSync(
    live,
    [
      JSON.stringify({
        type: 'message',
        id: 'a',
        timestamp: '2026-01-01T00:00:01.000Z',
        message: {
          role: 'assistant',
          stopReason: 'toolUse',
          content: [
            { type: 'toolCall', id: 'c-1', name: 'bash', arguments: { command: 'sleep 300; echo poll-done' } },
          ],
        },
      }),
      JSON.stringify({
        type: 'message',
        id: 'r',
        timestamp: '2026-01-01T00:00:02.000Z',
        message: {
          role: 'toolResult',
          toolCallId: 'c-1',
          toolName: 'bash',
          content: [{ type: 'text', text: 'Backgrounded as job bg_9; result will be delivered automatically.' }],
        },
      }),
    ].join('\n') + '\n',
  );
  const proc = spawnSync(process.execPath, [SCRIPT, '--alive', live], { encoding: 'utf8' });
  assert.equal(proc.status, 0, proc.stderr);
  assert.equal(proc.stdout, 'bg_9 2026-01-01T00:00:02.000Z sleep 300; echo poll-done\n');
  const done = spawnSync(process.execPath, [SCRIPT, '--alive', CORPUS], { encoding: 'utf8' });
  assert.equal(done.status, 0, done.stderr);
  assert.equal(done.stdout, '');
});

test('the CLI --alive --format=json output is the array', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idle-audit-alive-'));
  const live = path.join(dir, 'live.jsonl');
  fs.writeFileSync(
    live,
    [
      JSON.stringify({
        type: 'message',
        id: 'a',
        timestamp: '2026-01-01T00:00:01.000Z',
        message: {
          role: 'assistant',
          stopReason: 'toolUse',
          content: [
            { type: 'toolCall', id: 'c-1', name: 'bash', arguments: { command: 'sleep 300; echo poll-done' } },
          ],
        },
      }),
      JSON.stringify({
        type: 'message',
        id: 'r',
        timestamp: '2026-01-01T00:00:02.000Z',
        message: {
          role: 'toolResult',
          toolCallId: 'c-1',
          toolName: 'bash',
          content: [{ type: 'text', text: 'Backgrounded as job bg_9; result will be delivered automatically.' }],
        },
      }),
    ].join('\n') + '\n',
  );
  const proc = spawnSync(process.execPath, [SCRIPT, '--alive', '--format=json', live], { encoding: 'utf8' });
  assert.equal(proc.status, 0, proc.stderr);
  assert.deepEqual(JSON.parse(proc.stdout), [
    { id: 'bg_9', startedAt: '2026-01-01T00:00:02.000Z', command: 'sleep 300; echo poll-done' },
  ]);
});
