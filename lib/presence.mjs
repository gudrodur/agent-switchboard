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

const beaconKey = (b) => `${b.sessionId ?? 'anon'}:${b.cwd}`;

// Refresh this session's presence (call from a UserPromptSubmit hook). Returns
// the OTHER live beacons.
export const recordPresence = ({
  file = PRESENCE_FILE,
  cwd = process.cwd(),
  homeCwd = null,
  branch = null,
  repo = null,
  sessionId = null,
  mailbox = null,
  windowId = null,
  now = Date.now(),
} = {}) => {
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
export const releasePresence = ({ file = PRESENCE_FILE, sessionId = null, cwd = null } = {}) => {
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
// consumer flag — the view recipient resolution splits as needed.
export const readAllPresence = ({ file = PRESENCE_FILE, now = Date.now() } = {}) =>
  prunePresence(readPresenceFile(file).beacons, now);
