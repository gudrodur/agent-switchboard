// Test isolation: no test may read or write the live switchboard store.
//
// After the store cutover every delegated process (and every omp tab) carries
// AGENT_SWITCHBOARD_DB, which outranks the old tests' AGENT_MAILBOX_DIR /
// presence-file pins: a spawned child resolves the ambient db and writes test
// rows into the live state.db. Every child-process environment in this suite
// is therefore built through isolatedEnv(), which strips every
// AGENT_SWITCHBOARD_* and AGENT_MAILBOX_* variable from process.env before
// adding the test's own pins. In-process tests get the same scrub from
// isolate-setup.mjs (loaded via --import, before any lib import captures env).

const ISOLATED_PREFIXES = ['AGENT_SWITCHBOARD_', 'AGENT_MAILBOX_'];

// The session and window identity the omp hook reads: sessionIdOf() takes
// OMP_SESSION_ID before anything else, and presence records KITTY_WINDOW_ID.
// A suite run inside an omp tab inherits both, so a session-less test would
// silently become a with-id test there. A test that needs either sets it
// itself, after this scrub (an explicit isolatedEnv() extra wins).
const ISOLATED_KEYS = new Set(['OMP_SESSION_ID', 'KITTY_WINDOW_ID']);

export const isIsolatedKey = (key) => ISOLATED_KEYS.has(key) || ISOLATED_PREFIXES.some((p) => key.startsWith(p));

// Copy of env without the switchboard/mailbox pins and the identity keys.
export const stripIsolatedVars = (env = process.env) => {
  const out = { ...env };
  for (const key of Object.keys(out)) {
    if (isIsolatedKey(key)) delete out[key];
  }
  return out;
};

// Child-process environment: stripped base plus the test's own pins.
export const isolatedEnv = (extra = {}) => ({ ...stripIsolatedVars(), ...extra });

// In-process scrub: delete the pins from this process before importing the
// lib (module constants such as MAILBOX_DIR capture env at import time).
export const scrubProcessEnv = () => {
  for (const key of Object.keys(process.env)) {
    if (isIsolatedKey(key)) delete process.env[key];
  }
};
