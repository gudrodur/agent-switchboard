// Keepalive for the mailbox consumer's presence beacon: a supervisor idle
// ~30 min — or stuck in one long busy turn — ages past the 20-min presence
// window, so agent-send stops resolving its mailbox flag and every steer
// falls back to kitty-send. The idle poll and the busy-turn tool handler
// must re-touch presence while the session is alive.
//
// Run: node --test tests/mailbox-keepalive.test.mjs (or the full suite)
import './helpers/isolate-setup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const hook = await import('../hooks/omp/pre/mailbox.ts');
const { touchPresenceBeacon, PRESENCE_TOUCH_MS, IDLE_POLL_MS } = hook;
const { PRESENCE_STALE_MS } = await import('../lib/presence.mjs');

const writePresence = (file, beacons) =>
  fs.writeFileSync(file, JSON.stringify({ beacons }));
const readBeacon = (file) =>
  JSON.parse(fs.readFileSync(file, 'utf8')).beacons[0];
const withPresenceFile = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mbox-keepalive-'));
  return { dir, file: path.join(dir, '_presence.json') };
};

test('touch keeps a live beacon live, flagged, and on its branch', () => {
  const { dir, file } = withPresenceFile();
  try {
    const tick = new Date(Date.now() - 19 * 60 * 1000).toISOString();
    writePresence(file, [{
      sessionId: 'k1', cwd: '/repo/k', mailbox: true, windowId: 99,
      branch: 'main', repo: 'o/r', firstTick: tick, lastTick: tick,
    }]);
    assert.equal(touchPresenceBeacon({ cwd: '/repo/k', sessionId: 'k1', presenceFile: file }), true);
    const b = readBeacon(file);
    assert.equal(b.mailbox, true);
    assert.equal(b.branch, 'main', 'the touch must not null the branch turns maintain');
    assert.equal(b.windowId, 99);
    assert.ok(Date.now() - Date.parse(b.lastTick) < 60_000, 'lastTick is fresh again');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('touch resurrects an aged-out beacon with the flag', () => {
  const { dir, file } = withPresenceFile();
  try {
    const tick = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    writePresence(file, [{
      sessionId: 'k1', cwd: '/repo/k', mailbox: true, windowId: 99,
      branch: 'main', repo: 'o/r', firstTick: tick, lastTick: tick,
    }]);
    assert.equal(touchPresenceBeacon({ cwd: '/repo/k', sessionId: 'k1', presenceFile: file }), true);
    const b = readBeacon(file);
    assert.equal(b.mailbox, true, 'a pruned beacon comes back as a consumer');
    assert.ok(Date.now() - Date.parse(b.lastTick) < 60_000);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the touch cadence fits inside the presence window', () => {
  assert.ok(PRESENCE_TOUCH_MS + IDLE_POLL_MS < PRESENCE_STALE_MS,
    `touch every ${PRESENCE_TOUCH_MS}ms must beat the ${PRESENCE_STALE_MS}ms stale window`);
});

// Busy-turn path: one long turn, a tool_execution_end after every tool, no new
// turn_start and no parked poll. A tool event every simulated minute for 25
// minutes must keep the beacon fresh — and touch at most once per window
// (lastTick lands exactly on the window edges, never on every event).
test('tool_execution_end events across 25 busy minutes keep the beacon fresh, one touch per window', async () => {
  const { dir, file } = withPresenceFile();
  const realNow = Date.now;
  const savedSeam = process.env.AGENT_SWITCHBOARD_PRESENCE_FILE;
  process.env.AGENT_SWITCHBOARD_PRESENCE_FILE = file;
  const handlers = {};
  const fakePi = { on: (ev, fn) => { handlers[ev] = fn; }, sendMessage: () => {} };
  try {
    const t0 = realNow();
    const iso = (t) => new Date(t).toISOString();
    writePresence(file, [{
      sessionId: 'k1', cwd: '/repo/k', mailbox: true, windowId: 99,
      branch: 'main', repo: 'o/r', firstTick: iso(t0), lastTick: iso(t0),
    }]);
    hook.default(fakePi);
    assert.equal(typeof handlers.tool_execution_end, 'function');
    const ctx = () => ({
      cwd: '/repo/k',
      sessionManager: { getSessionFile: () => '/sessions/k1.jsonl' },
      isIdle: () => false,
    });
    let now = t0;
    Date.now = () => now;
    // Without the keepalive lastTick would freeze at t0 and go stale at +20m.
    for (let m = 1; m <= 3; m++) {
      now = t0 + m * 60_000;
      await handlers.tool_execution_end({}, ctx());
    }
    assert.equal(Date.parse(readBeacon(file).lastTick), t0 + 60_000,
      'minutes 2-3 touch nothing: one touch per window');
    for (let m = 4; m <= 25; m++) {
      now = t0 + m * 60_000;
      await handlers.tool_execution_end({}, ctx());
    }
    // Touches at +1m, +6m, +11m, +16m, +21m; +25m stays gated. Fresh throughout.
    assert.equal(Date.parse(readBeacon(file).lastTick), t0 + 21 * 60_000);
    assert.ok(now - Date.parse(readBeacon(file).lastTick) < PRESENCE_STALE_MS);
  } finally {
    Date.now = realNow;
    if (savedSeam === undefined) delete process.env.AGENT_SWITCHBOARD_PRESENCE_FILE;
    else process.env.AGENT_SWITCHBOARD_PRESENCE_FILE = savedSeam;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
