// Presence beacons: which agent sessions recently took a turn, and where.
//
// One JSON file `{beacons: [...]}` keyed by (session id, cwd), so two sessions
// sharing one working directory stay visible as two beacons. A UserPromptSubmit
// hook refreshes one entry per session on every turn; entries older than
// PRESENCE_STALE_MS read as absent. Advisory only: every write is best-effort
// and every reader treats a missing file as "nobody here".
//
// Store root: AGENT_SWITCHBOARD_DIR (default
// `${XDG_STATE_HOME:-$HOME/.local/state}/agent-switchboard`). Presence lives
// at $AGENT_SWITCHBOARD_DIR/presence.json unless AGENT_SWITCHBOARD_PRESENCE_FILE
// overrides it. The mailbox keeps its own overrides (AGENT_SWITCHBOARD_MAILBOX_DIR
// / AGENT_MAILBOX_DIR); see lib/agent-mailbox.mjs.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { defaultStorePath, openStore, importLegacy } from './store.mjs';

export const switchboardDir = () =>
  process.env.AGENT_SWITCHBOARD_DIR ??
  path.join(process.env.XDG_STATE_HOME ?? path.join(os.homedir(), '.local', 'state'), 'agent-switchboard');

export const PRESENCE_FILE =
  process.env.AGENT_SWITCHBOARD_PRESENCE_FILE ?? path.join(switchboardDir(), 'presence.json');

// A beacon outlives a single tool call but not a parked afternoon: 20 minutes.
// The mailbox prune imports this; do not restate the number.
export const PRESENCE_STALE_MS = 20 * 60 * 1000;

const readPresenceFile = (file) => {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return parsed && Array.isArray(parsed.beacons) ? parsed : { beacons: [] };
  } catch {
    return { beacons: [] };
  }
};

const prunePresence = (beacons, now) =>
  beacons.filter((b) => {
    const tick = Date.parse(b.lastTick);
    return Number.isFinite(tick) && now - tick < PRESENCE_STALE_MS;
  });

// File backend stays while an explicit {file} override points at JSON, or
// while the legacy AGENT_SWITCHBOARD_PRESENCE_FILE env is set without an
// explicit AGENT_SWITCHBOARD_DB (which wins). Otherwise the beacon lives in
// the SQLite store; the first open imports the legacy file once and leaves
// it in place.
const legacyPresenceEnv = () =>
  process.env.AGENT_MAILBOX_PRESENCE_FILE ?? process.env.AGENT_SWITCHBOARD_PRESENCE_FILE ?? null;
const usePresenceDb = (file) =>
  file === undefined && (process.env.AGENT_SWITCHBOARD_DB != null || legacyPresenceEnv() == null);
const resolvePresenceFile = (file) => file ?? legacyPresenceEnv() ?? PRESENCE_FILE;

const withPresenceDb = (fn) => {
  const store = openStore(defaultStorePath());
  try {
    // Call-time source: a temp HOME in tests never reads the live file.
    importLegacy(store, {
      presenceFile: legacyPresenceEnv() ?? path.join(switchboardDir(), 'presence.json'),
    });
    return fn(store);
  } finally {
    store.close();
  }
};

export const presenceRowToBeacon = (r) => ({
  sessionId: r.session_id,
  cwd: r.cwd,
  ...(r.home_cwd != null ? { homeCwd: r.home_cwd } : {}),
  branch: r.branch,
  repo: r.repo,
  ...(r.mailbox != null ? { mailbox: !!r.mailbox } : {}),
  ...(r.window_id != null ? { windowId: r.window_id } : {}),
  firstTick: r.first_tick,
  lastTick: r.last_tick,
});

const beaconKey = (b) => `${b.sessionId ?? 'anon'}:${b.cwd}`;

// Refresh this session's presence (call from a UserPromptSubmit hook). Returns
// the OTHER live beacons.
export const recordPresence = ({
  file = undefined,
  cwd = process.cwd(),
  homeCwd = null,
  branch = null,
  repo = null,
  sessionId = null,
  mailbox = null,
  windowId = null,
  now = Date.now(),
} = {}) => {
  if (usePresenceDb(file)) {
    return withPresenceDb((store) => {
      const iso = new Date(now).toISOString();
      const sid = sessionId ?? 'anon';
      store.transaction(() => {
        store.run('DELETE FROM presence_beacons WHERE last_tick < ?', new Date(now - PRESENCE_STALE_MS).toISOString());
        const me = store.get('SELECT * FROM presence_beacons WHERE session_id = ? AND cwd = ?', sid, cwd);
        if (me) {
          store.run(
            `UPDATE presence_beacons SET last_tick = ?, branch = ?, cwd = ?,
              home_cwd = COALESCE(?, home_cwd), mailbox = COALESCE(?, mailbox), window_id = COALESCE(?, window_id)
             WHERE session_id = ? AND cwd = ?`,
            iso, branch, cwd,
            homeCwd, mailbox == null ? null : mailbox ? 1 : 0, windowId == null ? null : Number(windowId),
            sid, me.cwd,
          );
        } else {
          store.run(
            `INSERT INTO presence_beacons
               (session_id, cwd, home_cwd, branch, repo, mailbox, window_id, first_tick, last_tick)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            sid, cwd, homeCwd, branch, repo,
            mailbox == null ? null : mailbox ? 1 : 0, windowId == null ? null : Number(windowId),
            iso, iso,
          );
        }
      });
      const mineKey = beaconKey({ sessionId, cwd });
      return store.all('SELECT * FROM presence_beacons').map(presenceRowToBeacon).filter((b) => beaconKey(b) !== mineKey);
    });
  }
  file = resolvePresenceFile(file);
  const kept = prunePresence(readPresenceFile(file).beacons, now);
  const iso = new Date(now).toISOString();
  const mineKey = beaconKey({ sessionId, cwd });
  const me = kept.find((b) => beaconKey(b) === mineKey);
  if (me) {
    me.lastTick = iso;
    me.branch = branch;
    me.cwd = cwd;
    if (homeCwd !== null) me.homeCwd = homeCwd;
    // Optional consumer flag (the mailbox prompt hook sets true). Merge-only:
    // an omitted argument must never clear an existing true, since callers
    // that do not know about the flag run every turn.
    if (mailbox !== null) me.mailbox = mailbox;
    // Kitty window id (the mailbox hook sets it from KITTY_WINDOW_ID) so a
    // window id resolves to the session living in that window, not to
    // whoever shares its cwd. Same merge-only rule: never clear once set.
    if (windowId !== null) me.windowId = windowId;
  } else {
    kept.push({ sessionId, cwd, ...(homeCwd ? { homeCwd } : {}), branch, repo, ...(mailbox !== null ? { mailbox } : {}), ...(windowId !== null ? { windowId } : {}), firstTick: iso, lastTick: iso });
  }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify({ beacons: kept }, null, 2));
    fs.renameSync(tmp, file);
  } catch {
    // Best-effort — presence is advisory.
  }
  return kept.filter((b) => beaconKey(b) !== mineKey);
};

// Drop this session's beacons on clean session end. Keyed on sessionId when
// known — removes ALL of that session's beacons. Without a sessionId only
// anon beacons matching cwd are dropped, so a co-located sibling's beacon is
// never clobbered.
export const releasePresence = ({ file = undefined, sessionId = null, cwd = null } = {}) => {
  if (usePresenceDb(file)) {
    return withPresenceDb((store) => {
      if (sessionId) store.run('DELETE FROM presence_beacons WHERE session_id = ?', sessionId);
      else if (cwd) store.run("DELETE FROM presence_beacons WHERE session_id = 'anon' AND cwd = ?", cwd);
    });
  }
  file = resolvePresenceFile(file);
  const data = readPresenceFile(file);
  const kept = data.beacons.filter((b) =>
    sessionId ? b.sessionId !== sessionId : !(b.sessionId == null && cwd && b.cwd === cwd),
  );
  if (kept.length === data.beacons.length) return;
  try {
    const tmp = `${file}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify({ beacons: kept }, null, 2));
    fs.renameSync(tmp, file);
  } catch {
    // Best-effort — presence is advisory.
  }
};

// Every live beacon (no exclusion), raw rows including the `mailbox`
export const readAllPresence = ({ file = undefined, now = Date.now() } = {}) => {
  if (usePresenceDb(file)) {
    return withPresenceDb((store) =>
      prunePresence(store.all('SELECT * FROM presence_beacons').map(presenceRowToBeacon), now),
    );
  }
  return prunePresence(readPresenceFile(resolvePresenceFile(file)).beacons, now);
};
