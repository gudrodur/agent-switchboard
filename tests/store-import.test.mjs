// One-time legacy import (steps 1-2): a temp mailbox dir and presence file
// with real row shapes import once into a fresh db; a second open imports
// nothing new. Retention: an ack older than 14 days deletes its rows; an
// unacked row survives. New behaviour: no store existed before.
//
// The lib imports from its default legacy locations, so the test points HOME
// at a temp dir and seeds $HOME/.local/state/agent-switchboard/ with the
// legacy files — the same layout the machine carries today.
//
// Run: node --test tests/store-import.test.mjs (or the full suite)

import './helpers/isolate-setup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const SWAPPED_KEYS = [
  'HOME',
  'XDG_STATE_HOME',
  'AGENT_SWITCHBOARD_DB',
  'AGENT_SWITCHBOARD_DIR',
  'AGENT_SWITCHBOARD_MAILBOX_DIR',
  'AGENT_SWITCHBOARD_PRESENCE_FILE',
  'AGENT_SWITCHBOARD_SEND',
  'AGENT_SWITCHBOARD_SENDER',
  'AGENT_MAILBOX_DIR',
  'AGENT_MAILBOX_PRESENCE_FILE',
  'AGENT_MAILBOX_KITTY',
];

const withIsolatedHome = async (fn) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'store-import-home-'));
  const saved = Object.fromEntries(SWAPPED_KEYS.map((k) => [k, process.env[k]]));
  try {
    process.env.HOME = home;
    for (const k of SWAPPED_KEYS) {
      if (k !== 'HOME') delete process.env[k];
    }
    return await fn(home);
  } finally {
    for (const k of SWAPPED_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    fs.rmSync(home, { recursive: true, force: true });
  }
};

const seedLegacy = (home) => {
  const switchDir = path.join(home, '.local', 'state', 'agent-switchboard');
  const mbox = path.join(switchDir, 'mailbox');
  fs.mkdirSync(mbox, { recursive: true });
  const msg = {
    id: 'legacy-msg-1',
    ts: '2026-09-01T00:00:00.000Z',
    from: 'agent-send:/old',
    to: '-old__s1',
    priority: 'now',
    text: 'evidence',
  };
  fs.writeFileSync(
    path.join(mbox, '-old__s1.jsonl'),
    `${JSON.stringify(msg)}\n${JSON.stringify({ ack: msg.id, ts: '2026-09-01T00:00:01.000Z', deliveredAs: 'prompt' })}\n`,
  );
  fs.writeFileSync(
    path.join(mbox, '-old__s2.jsonl'),
    `${JSON.stringify({ id: 'legacy-msg-2', ts: '2026-09-01T00:00:00.000Z', from: 'x', to: '-old__s2', priority: 'queue', text: 'waiting' })}\n`,
  );
  fs.writeFileSync(
    path.join(switchDir, 'presence.json'),
    JSON.stringify({ beacons: [{ sessionId: 's1', cwd: '/repo', branch: 'main', firstTick: '2026-09-01T00:00:00.000Z', lastTick: new Date().toISOString() }] }),
  );
  return { switchDir, mbox };
};

test('legacy mailbox and presence import once; a second open imports nothing', async () =>
  withIsolatedHome(async (home) => {
    const { mbox } = seedLegacy(home);
    const { readUnacked, readUnackedBySession, readPresenceBeacons } = await import('../lib/agent-mailbox.mjs');

    assert.deepEqual(
      readUnacked('-old__s1', {}).map((r) => r.id),
      [],
      'acked legacy row stays acked after import',
    );
    assert.deepEqual(
      readUnackedBySession('s2', {}).map(({ row }) => row.text),
      ['waiting'],
      'unacked legacy row survives import',
    );
    assert.equal(readPresenceBeacons({}).filter((b) => b.sessionId === 's1').length, 1);

    // A row appended to the legacy file AFTER the import must not appear: the
    // import marker makes the second open a no-op.
    fs.appendFileSync(
      path.join(mbox, '-old__s2.jsonl'),
      `${JSON.stringify({ id: 'legacy-msg-3', ts: '2026-09-01T00:00:00.000Z', from: 'x', to: '-old__s2', priority: 'queue', text: 'late' })}\n`,
    );
    assert.deepEqual(
      readUnacked('-old__s2', {}).map((r) => r.id),
      ['legacy-msg-2'],
      'second open imports nothing',
    );
  }));

test('retention deletes acked rows after 14 days; unacked rows survive', async () =>
  withIsolatedHome(async () => {
    const m = await import('../lib/agent-mailbox.mjs');
    const old = Date.now() - 15 * 24 * 60 * 60 * 1000;
    const stale = m.appendMessage({ to: '-r__s', from: 'x', priority: 'now', text: 'stale', now: old });
    m.ack({ key: '-r__s', id: stale.id, deliveredAs: 'prompt', now: old + 1000 });
    const waiting = m.appendMessage({ to: '-r__s', from: 'x', priority: 'queue', text: 'waiting', now: old });
    assert.equal(m.pruneStale({}).length, 0);
    const { openStore } = await import('../lib/store.mjs');
    const { defaultStorePath } = await import('../lib/store.mjs');
    const store = openStore(defaultStorePath());
    let left;
    try {
      left = store.all('SELECT row_json FROM mailbox_rows').map((r) => JSON.parse(r.row_json));
    } finally {
      store.close();
    }
    const texts = left.map((r) => r.text ?? r.ack ?? r.withdraw);
    assert.ok(!texts.includes('stale'), 'acked row past retention is gone');
    assert.ok(texts.includes('waiting'), 'unacked row survives retention');
    void waiting;
  }));

test('omp keepalive re-touches a beacon in the presence table', async () =>
  withIsolatedHome(async () => {
    const { recordPresence, readAllPresence } = await import('../lib/presence.mjs');
    const { touchPresenceBeacon } = await import('../hooks/omp/pre/mailbox.ts');
    recordPresence({ cwd: '/repo/k', sessionId: 'k1', branch: 'main', mailbox: true, windowId: 99 });
    assert.equal(touchPresenceBeacon({ cwd: '/repo/k', sessionId: 'k1' }), true);
    const beacons = readAllPresence({});
    assert.equal(beacons.length, 1);
    assert.equal(beacons[0].mailbox, true);
    assert.equal(beacons[0].branch, 'main', 'the touch must not null the branch turns maintain');
    assert.equal(beacons[0].windowId, 99);
    assert.ok(Date.now() - Date.parse(beacons[0].lastTick) < 60_000, 'lastTick is fresh again');
  }));
