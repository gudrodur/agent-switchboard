// Tests for tests/helpers/isolate-env.mjs: what the suite strips from a child
// environment and from its own process before any lib import.
//
// Run: node --test tests/isolate-env.test.mjs

import './helpers/isolate-setup.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { isIsolatedKey, stripIsolatedVars, isolatedEnv } from './helpers/isolate-env.mjs';

test('the store pins and the session and window identity are isolated keys', () => {
  for (const k of ['AGENT_SWITCHBOARD_DB', 'AGENT_MAILBOX_DIR', 'OMP_SESSION_ID', 'KITTY_WINDOW_ID']) {
    assert.equal(isIsolatedKey(k), true, k);
  }
  for (const k of ['HOME', 'PATH', 'OMP_TAB_LEAN_YML', 'KITTY_LISTEN_ON']) {
    assert.equal(isIsolatedKey(k), false, k);
  }
});

test('a child environment drops the identity keys and keeps the rest', () => {
  const env = stripIsolatedVars({ OMP_SESSION_ID: 'tab-sid', KITTY_WINDOW_ID: '42', PATH: '/bin', AGENT_SWITCHBOARD_DB: '/live/state.db' });
  assert.deepEqual(env, { PATH: '/bin' });
});

test('an explicit extra still sets an identity key for the test that needs it', () => {
  const env = isolatedEnv({ KITTY_WINDOW_ID: '4242' });
  assert.equal(env.KITTY_WINDOW_ID, '4242');
});

test('the import-time scrub removed any inherited identity from this process', () => {
  assert.equal(process.env.OMP_SESSION_ID, undefined);
  assert.equal(process.env.KITTY_WINDOW_ID, undefined);
});
