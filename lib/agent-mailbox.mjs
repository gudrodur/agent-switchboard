// Agent mailbox store: file-backed inter-agent messages.
//
// One append-only JSONL file per recipient under MAILBOX_DIR. A message row is
// {id, ts, from, to, priority, text}; a consumer acknowledges with a delivery
// row {ack, ts, deliveredAs}. Per-recipient files avoid write contention and
// O_APPEND means no locking. Used by scripts/agent-send.mjs (the sender), the
// prompt hook, and the omp hook, which imports
// this file by a relative path.
//
// Recipient identity is the presence identity already in presence.json (cwd
// plus session id). Readers find a session's mailbox by session id across ALL
// its keys, so a row addressed to a pre-move key still reaches a session
// whose cwd has since moved; mailbox files whose session is absent from
// presence are pruned by the sender, never read.
//
// Tests only: AGENT_SWITCHBOARD_MAILBOX_DIR (or the older AGENT_MAILBOX_DIR) points the store at a temp dir,
// AGENT_MAILBOX_PRESENCE_FILE points recipient resolution at a temp presence
// file, and AGENT_MAILBOX_KITTY replaces the `kitty` binary on PATH. The
// exported functions also take {dir} / {presenceFile} overrides for
// in-process use.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { PRESENCE_FILE, isIdleBeacon, isLiveBeacon, presenceRowToBeacon, switchboardDir } from './presence.mjs';
import { defaultStorePath, openStore, importLegacy, pruneRetention } from './store.mjs';
import {
  ROLE_PREFIX,
  allRoleHolders,
  claimRole,
  roleFromTarget,
  roleHolder,
  rolesForSession,
  validateRoleName,
  readRolesDb,
  withRolesDb,
  markNudged,
} from './seat-roles.mjs';

export const MAILBOX_DIR =
  process.env.AGENT_SWITCHBOARD_MAILBOX_DIR ?? process.env.AGENT_MAILBOX_DIR ?? path.join(switchboardDir(), 'mailbox');

// Priorities the sender accepts; the consumer maps each to a delivery mode.
export const PRIORITIES = ['now', 'stop', 'idle', 'queue'];

// Delivery labels consumers write in the ack row's deliveredAs. Closed set:
// prompt (mailbox-inject hook), mcp (read_inbox), steer / followUp (priority
// mapping now|stop -> steer, idle|queue -> followUp, applied by the consumer
// in mailbox.ts), nextTurn (delivery at the next turn boundary). ack() stays
// fail-open: an unknown label is still written, so a new consumer can never
// lose a message by naming a label this list does not know yet.
export const DELIVERED_AS = Object.freeze(['prompt', 'mcp', 'steer', 'followUp', 'nextTurn', 'typed']);

// SQLite backend (steps 1-2): an explicit {dir} override always means JSONL
// files (the path every existing test exercises). Without one, an explicit
// AGENT_SWITCHBOARD_DB wins and rows live in the store; otherwise the legacy
// pins (AGENT_MAILBOX_DIR, then AGENT_SWITCHBOARD_MAILBOX_DIR — the order the
// file backend always resolved) keep the file backend while set. The store's
// first open imports the legacy mailbox dir and presence file once and leaves
// them in place.
const legacyMailboxDirEnv = () => process.env.AGENT_MAILBOX_DIR ?? process.env.AGENT_SWITCHBOARD_MAILBOX_DIR ?? null;
const resolveMailboxDir = (dir) => dir ?? process.env.AGENT_MAILBOX_DIR ?? MAILBOX_DIR;
const useMailboxDb = (dir) =>
  dir === undefined && (process.env.AGENT_SWITCHBOARD_DB != null || legacyMailboxDirEnv() == null);
const usePresenceDb = (file) =>
  file === undefined && (process.env.AGENT_SWITCHBOARD_DB != null || legacyPresenceEnv() == null);
const legacyPresenceEnv = () =>
  process.env.AGENT_MAILBOX_PRESENCE_FILE ?? process.env.AGENT_SWITCHBOARD_PRESENCE_FILE ?? null;
const resolvePresenceFile = (file) => file ?? process.env.AGENT_MAILBOX_PRESENCE_FILE ?? PRESENCE_FILE;
// Null while the store backs the mailbox (hook seam: pass no {dir} then).
// An explicit AGENT_SWITCHBOARD_DB wins over the legacy pins; otherwise the
// legacy pins win while set, so today's machine keeps its file backend until
// the pins are lifted.
export const mailboxFileDir = () =>
  process.env.AGENT_SWITCHBOARD_DB != null ? null : legacyMailboxDirEnv();
// Import sources resolve at call time (never the import-time constants), so a
// temp HOME / temp pins in tests never read the live store.
const withMailboxDb = (fn) => {
  const store = openStore(defaultStorePath());
  try {
    importLegacy(store, {
      mailboxDir: legacyMailboxDirEnv() ?? path.join(switchboardDir(), 'mailbox'),
      presenceFile: legacyPresenceEnv() ?? path.join(switchboardDir(), 'presence.json'),
    });
    return fn(store);
  } finally {
    store.close();
  }
};
const dbReadRows = (store, key) =>
  store.all('SELECT row_json FROM mailbox_rows WHERE recipient_key = ? ORDER BY rowid', key).map((r) => JSON.parse(r.row_json));
 const kittyBin = () => process.env.AGENT_MAILBOX_KITTY ?? 'kitty';

// The session-id half of a mailbox key, sanitized the same way everywhere so
// the suffix scan below matches what recipientKey builds. Every key ends in
// `__<sanitized session id>`, which is what makes a session's mailbox
// findable after its cwd moves (EnterWorktree changes the cwd half, never
// the session id).
export const sanitizeSessionId = (sessionId) =>
  String(sessionId ?? 'anon').replace(/[^A-Za-z0-9._-]+/g, '_') || 'anon';

// Filesystem-safe and deterministic: the same session always maps to the same
// key from any caller. Leading '/' becomes '-', every other unsafe run '_'.
export const recipientKey = ({ cwd, sessionId }) => {
  const dir = String(cwd ?? '').replace(/\//g, '-').replace(/[^A-Za-z0-9._-]+/g, '_') || 'root';
  const sid = sanitizeSessionId(sessionId);
  return `${dir}__${sid}`;
};

// Every mailbox key belonging to one session — its pre-move key as well as
// any post-move ones. A directory scan per call is cheap (a handful of small
// files) and keeps the reader correct whatever the session's cwd does.
export const mailboxKeysForSession = (sessionId, { dir } = {}) => {
  if (useMailboxDb(dir)) {
    const suffix = `__${sanitizeSessionId(sessionId)}`;
    return withMailboxDb((store) =>
      store
        .all('SELECT DISTINCT recipient_key FROM mailbox_rows')
        .map((r) => r.recipient_key)
        .filter((k) => k.endsWith(suffix)),
    );
  }
  const suffix = `__${sanitizeSessionId(sessionId)}.jsonl`;
  let files = [];
  try {
    files = fs.readdirSync(resolveMailboxDir(dir)).filter((f) => f.endsWith(suffix));
  } catch {
    return [];
  }
  return files.map((f) => f.slice(0, -'.jsonl'.length));
};
// Every unacked row addressed to any of this session's keys, each tagged with
// the key file it came from so the consumer acks in the right file. This is
// why a sender addressing the pre-move key still reaches a moved session.
export const readUnackedBySession = (sessionId, { dir } = {}) => {
  const out = [];
  for (const key of mailboxKeysForSession(sessionId, { dir })) {
    for (const row of readUnacked(key, { dir })) out.push({ key, row });
  }
  return out;
};
export const mailboxPath = (key, { dir } = {}) => {
  if (useMailboxDb(dir)) return defaultStorePath();
  return path.join(resolveMailboxDir(dir), `${key}.jsonl`);
};

// Live raw presence beacons (unlike readAllPresence, keeps the `mailbox`
// consumer flag the hooks set and the sessionId the key needs). With
// includeStale the unfiltered file comes back too, so a resolver can tell
// "no beacon ever" from "its beacon aged out" (a supervisor idle past the
// presence window is parked, not gone).
export const readPresenceBeacons = ({ presenceFile: file, now = Date.now(), includeStale = false } = {}) => {
  if (usePresenceDb(file)) {
    return withMailboxDb((store) => {
      const beacons = store.all('SELECT * FROM presence_beacons').map(presenceRowToBeacon);
      if (includeStale) return beacons;
      return beacons.filter((b) => isLiveBeacon(b, now));
    });
  }
  let beacons = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(resolvePresenceFile(file), 'utf-8'));
    if (parsed && Array.isArray(parsed.beacons)) beacons = parsed.beacons;
  } catch {
    return [];
  }
  if (includeStale) return beacons;
  return beacons.filter((b) => isLiveBeacon(b, now));
};
// .tabs[].windows[] only — tab ids and window ids share one number space
// (see omp-tab.sh win_pid), so a whole-JSON grep would match a tab.
export const kittyWindows = () => {
  let parsed;
  try {
    const out = execFileSync(kittyBin(), ['@', 'ls'], { encoding: 'utf-8', timeout: 5000 });
    parsed = JSON.parse(out);
  } catch {
    return [];
  }
  const wins = [];
  for (const osEntry of parsed ?? []) {
    for (const tab of osEntry?.tabs ?? []) {
      for (const w of tab?.windows ?? []) {
        if (typeof w?.id !== 'number') continue;
        wins.push({ id: w.id, title: w.title ?? '', tabTitle: tab?.title ?? '', pid: w.pid ?? null, cwd: w.cwd ?? null });
      }
    }
  }
  return wins;
};

// Idle seats: a beacon past the presence TTL whose writer pid is alive AND
// whose kitty window still exists is parked, not gone, so it stays listed and
// addressable. A dead pid, a closed window, or a live beacon of ANOTHER
// session in that window (its successor) is not an idle seat. Each result
// carries idleMs. `wins` is injectable; it is read from kitty only when some
// beacon is a candidate.
export const AGENT_COMM_NAMES = ['claude', 'omp', 'pi', 'opencode'];

// ONE /proc scan: the set of kitty window ids that run an agent process (comm
// is one of AGENT_COMM_NAMES and its environ holds KITTY_WINDOW_ID=<id>).
// Mirrors agent-config's kittyWindowLive, but for every window at once.
// AGENT_MAILBOX_PROC_DIR replaces /proc (tests only).
// null when procDir cannot be read: "could not tell" is not "running".
export const agentWindowIds = ({ procDir = process.env.AGENT_MAILBOX_PROC_DIR ?? '/proc', names = AGENT_COMM_NAMES } = {}) => {
  let entries;
  try {
    entries = fs.readdirSync(procDir);
  } catch {
    return null;
  }
  const ids = new Set();
  for (const ent of entries) {
    if (!/^\d+$/.test(ent)) continue;
    try {
      if (!names.includes(fs.readFileSync(path.join(procDir, ent, 'comm'), 'utf-8').trim())) continue;
      for (const kv of fs.readFileSync(path.join(procDir, ent, 'environ'), 'utf-8').split('\0')) {
        const m = /^KITTY_WINDOW_ID=(\d+)$/.exec(kv);
        if (m) ids.add(Number(m[1]));
      }
    } catch {
      // Exited, or another user's process: not evidence either way.
    }
  }
  return ids;
};

// Idle seats: a beacon past the presence TTL whose writer pid is alive AND
// whose kitty window still exists AND still runs an agent (a window whose
// agent exited leaves a bare shell; typing into it is the unsafe direction)
// is parked, not gone, so it stays listed and addressable. A dead pid, a
// closed window, a shell-only window, an unreadable /proc, or a live beacon
// of ANOTHER session in that window (its successor) is not an idle seat. Each
// result carries idleMs. `wins` and `agentWindows` (Set of window ids, or
// null for "unreadable") are injectable; each is read only when some beacon
// is a candidate, and /proc is scanned once per call.
export const idleBeacons = ({ presenceFile, now = Date.now(), wins = null, agentWindows = undefined } = {}) => {
  const all = readPresenceBeacons({ presenceFile, now, includeStale: true });
  const cands = all.filter((b) => b.windowId != null && isIdleBeacon(b, now));
  if (cands.length === 0) return [];
  const running = agentWindows === undefined ? agentWindowIds() : agentWindows;
  if (running == null) return [];
  const open = new Set((wins ?? kittyWindows()).map((w) => w.id));
  const liveWindows = new Map(all.filter((b) => b.windowId != null && isLiveBeacon(b, now)).map((b) => [Number(b.windowId), b.sessionId]));
  return cands
    .filter((b) => open.has(Number(b.windowId)) && running.has(Number(b.windowId)) && !(liveWindows.has(Number(b.windowId)) && liveWindows.get(Number(b.windowId)) !== b.sessionId))
    .map((b) => ({ ...b, idleMs: now - Date.parse(b.lastTick) }));
};
const idleMinutes = (b) => Math.max(1, Math.round(b.idleMs / 60_000));

// Live beacons sharing a window's cwd — the fallback candidates for a window
// id or title target when no beacon recorded the window's own id (see
// beaconsForWindowId). A shared cwd means candidates, never an answer. A
// beacon that recorded a different window id lives in that window and is no
// candidate here: when this window's own beacon had aged out, the cwd join
// delivered to the seat next door (agent-config#1355 W5, 2026-10-27).
const beaconsForWindow = (beacons, win) =>
  beacons.filter((b) => b.cwd === win.cwd && (b.windowId == null || Number(b.windowId) === win.id));

// Beacons whose session recorded this window's id (mailbox-inject stores
// KITTY_WINDOW_ID in the beacon each turn). An exact window-id join beats the
// cwd join below: two sessions sharing one cwd live in different windows, so
// the window id names the recipient and the cwd cannot. Beacons that predate
// the windowId field (omp tabs, older sessions) carry none and fall through
// to the cwd join.
const beaconsForWindowId = (beacons, win) =>
  beacons.filter((b) => b.windowId != null && Number(b.windowId) === win.id);

// A beacon is the sender's own when the session id matches. The cwd is
// deliberately NOT part of the comparison: after EnterWorktree the sender's
// cwd has moved but its session id has not. A null sender session id (a
// caller that does not know who it is) excludes nothing. The sender's kitty
// window id excludes too, so targeting the sender's own window never delivers
// to the cwd-sharer next door.
const isSenderBeacon = (b, sender) =>
  (sender?.sessionId != null && b.sessionId === sender.sessionId) ||
  (sender?.windowId != null && b.windowId != null && Number(b.windowId) === sender.windowId);

// A window's own top-level omp session vs. its local-agent workers: when a
// headless worker launch forgets `env -u KITTY_WINDOW_ID` (see
// skills/local-agents/SKILL.md § "Give it the environment"), the worker
// inherits the parent tab's KITTY_WINDOW_ID and its beacon lands on the same
// windowId as the tab's own beacon — "window N matches K live sessions" is
// this, not two different tabs.
//
// No field in the beacon says which recorded session is the parent: the
// presence schema is only {sessionId, cwd, homeCwd, branch, repo, mailbox,
// windowId, firstTick, lastTick} (lib/presence.mjs), with no parent-session
// id anywhere. And `mailbox` cannot substitute for one: hooks/omp/pre/
// mailbox.ts's flagAtStart() sets `mailbox: true` unconditionally for ANY
// session with a session id at session_start, worker or not, so every
// worker beacon looks exactly as "has a mailbox consumer" as the tab's own.
//
// What DOES survive into the beacon, structurally, is the *shape* of
// sessionId itself, because sessionIdOf() (same hook) takes it straight from
// the session file's own basename. A top-level omp session's file is always
// named "<ISO-8601 timestamp>_<session-uuid>.jsonl" directly under the cwd
// directory; a local-agent worker's file sits one level down, inside a
// subdirectory named after its PARENT's own timestamp_uuid stem, and is
// itself named after the worker's task, e.g. "P2LocalAgents.jsonl" or
// "CutAgents.jsonl" — never timestamp-shaped. Measured on a real machine
// under ~/.omp/agent/sessions/<cwd>/: the parent's own file sits beside a
// directory of the same stem holding P2Overseer.jsonl, P2Supervisor.jsonl,
// P2Agents.jsonl, P2LocalAgents.jsonl, CutOverseer.jsonl, CutSupervisor.jsonl,
// CutAgents.jsonl, CutLocalAgents.jsonl, __advisor.jsonl — none of which
// match the timestamp-prefixed shape. This is the one structural signal
// available, so it is what breaks the tie; plain name matching (looking for
// "LocalAgents" or "Agents" in particular) is not used, since worker task
// names are not a closed, guaranteed set.
const TOP_LEVEL_SESSION_ID_RE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z_/;
const looksLikeTopLevelSessionId = (sessionId) =>
  typeof sessionId === 'string' && TOP_LEVEL_SESSION_ID_RE.test(sessionId);

// Narrow a set of same-window (or same-cwd) candidates down to the ones
// shaped like a top-level session, but only when that narrowing leaves at
// least one candidate standing. An all-worker-shaped set (the tab's own
// beacon went stale while its workers kept refreshing theirs) is returned
// unchanged, so the existing ambiguous/self checks still see every
// candidate rather than silently picking a worker.
const preferTopLevel = (list) => {
  if (list.length <= 1) return list;
  const topLevel = list.filter((b) => looksLikeTopLevelSessionId(b.sessionId));
  return topLevel.length > 0 && topLevel.length < list.length ? topLevel : list;
};

// Collapse candidates that share one sessionId into one. A worktree subagent
// writes a second beacon under its own cwd with the parent's sessionId, which
// is still ONE recipient: every consumer drains by session id
// (readUnackedBySession), so a row addressed to any of that session's keys is
// delivered and acked. The kept beacon is one flagged `mailbox: true` (its
// hasConsumer decides queue vs kitty fallback), then the newest lastTick.
// Beacons with no session id never collapse: 'anon' is not an identity. Two
// DIFFERENT session ids stay separate candidates and stay ambiguous.
const beaconRank = (b) => [b.mailbox === true ? 1 : 0, String(b.lastTick ?? '')];
const outranks = (a, b) => {
  const [ma, ta] = beaconRank(a);
  const [mb, tb] = beaconRank(b);
  return ma !== mb ? ma > mb : ta > tb;
};
const collapseSameSession = (list) => {
  if (list.length <= 1) return list;
  const kept = new Map();
  const loose = [];
  for (const b of list) {
    if (b.sessionId == null || b.sessionId === '') { loose.push(b); continue; }
    const sid = sanitizeSessionId(b.sessionId);
    const cur = kept.get(sid);
    if (!cur || outranks(b, cur)) kept.set(sid, b);
  }
  return [...kept.values(), ...loose];
};

const recipientOf = (beacon, windowId) => ({
  key: recipientKey({ cwd: beacon.cwd, sessionId: beacon.sessionId }),
  cwd: beacon.cwd,
  sessionId: beacon.sessionId ?? null,
  windowId,
  beaconWindowId: beacon.windowId != null ? Number(beacon.windowId) : null,
  hasConsumer: beacon.mailbox === true,
});

const resErr = (code, msg) => Object.assign(new Error(msg), { code });
const resolveWindowRecipient = (beacons, win, sender, { presenceFile: file } = {}) => {
  // Exact join first: the beacon recorded in this window. Exactly one other
  // session there delivers even when the cwd is shared (2026-09-12: window 35
  // matched 2 live sessions on one cwd and was unaddressable by window id).
  const exactAll = beaconsForWindowId(beacons, win).filter((b) => !isSenderBeacon(b, sender));
  const exact = collapseSameSession(preferTopLevel(exactAll));
  if (exact.length === 1) return recipientOf(exact[0], win.id);
  if (exact.length > 1) {
    const keys = exact.map((b) => recipientKey({ cwd: b.cwd, sessionId: b.sessionId })).join(', ');
    throw resErr(
      'mailbox-ambiguous',
      `window ${win.id} matches ${exact.length} live sessions (${keys}) — pass the recipient's mailbox key instead`,
    );
  }
  if (beaconsForWindowId(beacons, win).length > 0) {
    throw resErr(
      'mailbox-self',
      `window ${win.id} resolves to the sender itself — pass the recipient's mailbox key, ` +
      `or use kitty-send.sh for windows without a mailbox consumer`,
    );
  }
  const same = beaconsForWindow(beacons, win);
  if (same.length === 0) {
    // No LIVE beacon. Before giving up, ask whether a beacon aged out: a
    // supervisor idle past the presence window is parked, not gone, and the
    // sender should hear that.
    const raw = readPresenceBeacons({ presenceFile: file, includeStale: true });
    const aged = raw.filter((b) => !isSenderBeacon(b, sender) &&
      (beaconsForWindowId([b], win).length > 0 || beaconsForWindow([b], win).length > 0));
    const idle = aged.length > 0 ? idleBeacons({ presenceFile: file, wins: [win] }).filter((b) => aged.some((a) => a.sessionId === b.sessionId && a.cwd === b.cwd)) : [];
    if (idle.length > 0) {
      const b = idle[0];
      throw Object.assign(resErr('mailbox-idle', `window ${win.id} is an idle seat (${idleMinutes(b)}m)`), { idleMinutes: idleMinutes(b), key: recipientKey({ cwd: b.cwd, sessionId: b.sessionId }) });
    }
    if (aged.length > 0) {
      const tick = Date.parse(aged[0].lastTick);
      const ago = Number.isFinite(tick) ? `${Math.round((Date.now() - tick) / 1000)}s ago` : 'at an unreadable time';
      throw Object.assign(resErr(
        'mailbox-stale',
        `window ${win.id} has no LIVE presence beacon (last tick ${aged[0].lastTick ?? 'unknown'}, ${ago} — past the presence window); its consumer is parked or gone`,
      ), { key: recipientKey({ cwd: aged[0].cwd, sessionId: aged[0].sessionId }) });
    }
    throw resErr('mailbox-no-beacon', `window ${win.id} has no live presence beacon`);
  }
  const othersAll = same.filter((b) => !isSenderBeacon(b, sender));
  const others = collapseSameSession(preferTopLevel(othersAll));
  if (others.length === 1) return recipientOf(others[0], win.id);
  if (others.length === 0) {
    throw resErr(
      'mailbox-self',
      `window ${win.id} resolves to the sender itself — pass the recipient's mailbox key, ` +
      `or use kitty-send.sh for windows without a mailbox consumer`,
    );
  }
  const keys = others.map((b) => recipientKey({ cwd: b.cwd, sessionId: b.sessionId })).join(', ');
  throw resErr(
    'mailbox-ambiguous',
    `window ${win.id} matches ${others.length} live sessions (${keys}) — pass the recipient's mailbox key instead`,
  );
};
// Resolve a --to target to a recipient. Accepts `role:<name>` (a seat role:
// the live holder's mailbox, else the role's own queue; see
// resolveRoleRecipient), a mailbox key, a kitty window
// id, or a title substring matching exactly one window (window or tab title,
// mirroring kitty-send.sh). A window id resolves by the window id the
// recipient session recorded in its beacon (KITTY_WINDOW_ID); only beacons
// that predate the field fall back to the cwd join. A mailbox key is an
// explicit address: it resolves even when it names the sender itself — and
// even when the key is STALE, i.e. its cwd half predates an EnterWorktree
// move: the session id never moves, so a key whose `__<sid>` suffix matches
// exactly one live beacon resolves to that beacon's CURRENT key. A window id
// or title that cannot be mapped to exactly one OTHER session is an error
// that lists the candidates, never a guess — sending to the wrong agent is
// worse than not sending.
// Pass the sender ({senderSessionId, senderCwd, senderWindowId}) whenever the
// caller knows who it is; without it no exclusion is possible and a shared cwd
// stays ambiguous-or-wrong. senderWindowId is the sender's KITTY_WINDOW_ID.
export const resolveRecipient = (target, { presenceFile: file, senderSessionId = null, senderCwd = null, senderWindowId = null } = {}) => {
  const sender = senderSessionId != null || senderWindowId != null ? { sessionId: senderSessionId, cwd: senderCwd, windowId: senderWindowId } : null;
  const beacons = readPresenceBeacons({ presenceFile: file });
  const roleName = roleFromTarget(target);
  if (roleName != null) return resolveRoleRecipient(roleName, beacons);
  const byKey = beacons.find((b) => recipientKey({ cwd: b.cwd, sessionId: b.sessionId }) === target);
  if (byKey) return recipientOf(byKey, null);

  if (typeof target === 'string' && target.includes('__')) {
    const sid = target.slice(target.lastIndexOf('__') + 2);
    const sameSession = collapseSameSession(beacons.filter((b) => sanitizeSessionId(b.sessionId) === sid));
    if (sameSession.length === 1) return recipientOf(sameSession[0], null);
    if (sameSession.length > 1) {
      const keys = sameSession.map((b) => recipientKey({ cwd: b.cwd, sessionId: b.sessionId })).join(', ');
      throw resErr(
        'mailbox-ambiguous',
        `mailbox key '${target}' matches ${sameSession.length} live sessions (${keys}) — pass the recipient's current mailbox key instead`,
      );
    }
    throw new Error(`no live session for mailbox key '${target}' — its presence beacon is stale or gone`);
  }

  const wins = kittyWindows();
  if (/^\d+$/.test(String(target))) {
    const win = wins.find((w) => w.id === Number(target));
    if (!win) throw new Error(`no kitty window with id ${target}${seatHint(beacons, wins, sender)}`);
    return resolveWindowRecipient(beacons, win, sender, { presenceFile: file });
  }

  const matches = wins.filter((w) => w.title.includes(target) || w.tabTitle.includes(target));
  if (matches.length === 0) throw new Error(`no kitty window matches '${target}'${seatHint(beacons, wins, sender)}`);
  if (new Set(matches.map((w) => w.id)).size > 1) {
    const ids = matches.map((w) => w.id).join(', ');
    throw new Error(`ambiguous target '${target}' matches windows ${ids} — pass the window id instead`);
  }
  return resolveWindowRecipient(beacons, matches[0], sender, { presenceFile: file });
};

// ---- Seat roles -----------------------------------------------------------

// Holder lookup that never throws: an unreadable store reads as "no roles",
// the way presence reads as "nobody here".
const readRoleHolders = () => {
  try {
    return readRolesDb((db) => allRoleHolders(db), []);
  } catch {
    return [];
  }
};

// role:<name> -> the holder's current mailbox, or the role's own queue. A
// live holder (non-stale beacon for its session id) resolves exactly as that
// session's mailbox key would. No holder, or a holder whose beacon is gone,
// resolves to the key `role:<name>` with queuedForRole set: the row waits
// there for the next session to claim the role. That is a queue, not an error.
const resolveRoleRecipient = (name, beacons) => {
  validateRoleName(name);
  const key = `${ROLE_PREFIX}${name}`;
  let holder = null;
  try {
    holder = readRolesDb((db) => roleHolder(db, name), null);
  } catch {
    holder = null;
  }
  const mine = holder ? beacons.filter((b) => b.sessionId === holder.session_id) : [];
  if (mine.length > 0) {
    const best =
      mine.find((b) => b.cwd === holder.cwd) ??
      [...mine].sort((a, b) => String(b.lastTick).localeCompare(String(a.lastTick)))[0];
    return { ...recipientOf(best, null), role: name };
  }
  // A holder parked past the TTL with its window still open is idle, not
  // gone: address its window (kitty wake) instead of queueing for a next holder.
  const idle = holder ? idleBeacons({}).filter((b) => b.sessionId === holder.session_id) : [];
  if (idle.length > 0) {
    const best = idle.find((b) => b.cwd === holder.cwd) ?? [...idle].sort((a, b) => a.idleMs - b.idleMs)[0];
    return { ...recipientOf(best, null), hasConsumer: false, role: name, idleMinutes: idleMinutes(best) };
  }
  return {
    key,
    cwd: null,
    sessionId: null,
    windowId: null,
    beaconWindowId: null,
    hasConsumer: true,
    role: name,
    queuedForRole: true,
    holderSessionId: holder?.session_id ?? null,
  };
};

// Unacked rows queued under role:<name> for each given role, tagged with the
// key they came from so the consumer acks in the right place.
export const readUnackedByRoles = (roles, { dir } = {}) => {
  const out = [];
  for (const role of roles) {
    const key = `${ROLE_PREFIX}${role}`;
    for (const row of readUnacked(key, { dir })) out.push({ key, row });
  }
  return out;
};

export const rolesHeldBy = (sessionId) => {
  if (sessionId == null) return [];
  try {
    return readRolesDb((db) => rolesForSession(db, sessionId), []);
  } catch {
    return [];
  }
};

// AGENT_SEAT_ROLE names the role a launcher wants this session to hold. The
// claim happens on the first prompt and only when the role is free or its
// holder is not live: a session that was replaced keeps the variable in its
// environment, and must not take the role back from its successor on every
// prompt. Taking a LIVE holder's role is a deliberate `--claim-role`.
// Returns the role claimed, or null.
// The ONE live-holder check: the role's holder row when its session has a live
// beacon and is not `sessionId`, else null. A dead or absent holder reads as
// free. Shared by claimRoleFromEnv (declines) and agent-send --claim-role
// (refuses unless --take-over).
export const liveRoleHolder = (db, role, { sessionId = null, presenceFile } = {}) => {
  const held = roleHolder(db, role);
  if (!held || held.session_id === String(sessionId)) return null;
  const beacons = readPresenceBeacons({ presenceFile }).filter((b) => b.sessionId === held.session_id);
  return beacons.length > 0 ? { ...held, beacon: beacons.find((b) => b.windowId != null) ?? beacons[0] } : null;
};

export const claimRoleFromEnv = ({ sessionId, cwd = null, windowId = null, role = process.env.AGENT_SEAT_ROLE, presenceFile } = {}) => {
  if (!role || sessionId == null) return null;
  try {
    validateRoleName(role);
    return withRolesDb((db) => {
      if (roleHolder(db, role)?.session_id === String(sessionId)) return null;
      if (liveRoleHolder(db, role, { sessionId, presenceFile })) return null;
      claimRole(db, { role, sessionId, cwd, windowId });
      return role;
    });
  } catch {
    return null;
  }
};

// The one-line prompt for a session that holds no seat role while
// AGENT_SEAT_ROLE is unset (that case claims instead). It checks only the role
// state; claimNudgeOnce below decides that a session sees it once.
export const claimNudge = ({ sessionId, cwd = null, role = process.env.AGENT_SEAT_ROLE } = {}) => {
  if (sessionId == null || role) return null;
  try {
    if (rolesHeldBy(sessionId).length) return null;
  } catch {
    return null;
  }
  const send = fileURLToPath(new URL('../bin/agent-send.mjs', import.meta.url));
  const repo = (gitRepoName(cwd) ?? 'seat').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'seat';
  return `[mailbox] This seat holds no role, and mail addressed by window id is lost when the window closes. Claim a stable address named <repo>-<purpose>, where purpose names the job (e.g. lead, ship, history-scrub); a seat may hold several roles, and mail goes to the role naming the job: node ${send} --claim-role ${repo}-<purpose>`;
};

// The nudge, at most once per session id: the first caller records the
// session in seat_nudges and gets the line, every later one gets null. Hooks
// call it on every prompt, since "no beacon yet" cannot mean "first prompt"
// when another hook records presence for the same prompt.
export const claimNudgeOnce = ({ sessionId, cwd = null, role = process.env.AGENT_SEAT_ROLE } = {}) => {
  const line = claimNudge({ sessionId, cwd, role });
  if (!line) return null;
  try {
    return withRolesDb((db) => markNudged(db, sessionId)) ? line : null;
  } catch {
    return null;
  }
};

const repoCache = new Map();
// Beacons from hooks that pass no repo get one from git: the directory that
// holds the common git dir, so a worktree reports its main checkout's name.
const gitRepoName = (cwd) => {
  if (!cwd) return null;
  if (repoCache.has(cwd)) return repoCache.get(cwd);
  let name = null;
  try {
    const common = execFileSync('git', ['-C', cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'], {
      encoding: 'utf-8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    name = path.basename(path.dirname(common)) || null;
  } catch {
    name = null;
  }
  repoCache.set(cwd, name);
  return name;
};
const repoOf = (b) => b.repo ?? gitRepoName(b.cwd);
const gitOut = (cwd, args) => {
  try {
    return execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf-8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || null;
  } catch {
    return null;
  }
};
const branchOf = (b) => {
  if (b.branch) return b.branch;
  try {
    return execFileSync('git', ['-C', b.cwd, 'rev-parse', '--abbrev-ref', 'HEAD'], {
      encoding: 'utf-8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || null;
  } catch {
    return null;
  }
};

// Live seats: one entry per live presence beacon, joined with the roles it
// holds and its kitty window title (tolerates kitty being absent).
export const listSeats = ({ presenceFile, wins = kittyWindows(), agentWindows = undefined } = {}) => {
  const beacons = [
    ...readPresenceBeacons({ presenceFile }),
    ...idleBeacons({ presenceFile, wins, agentWindows }),
  ];
  const holders = readRoleHolders();
  // One row per seat: a beacon recorded in a subdirectory of a checkout is the
  // same seat as one at its root, so rows with the same session id and git
  // toplevel collapse into one, keeping the freshest fields.
  const seats = new Map();
  const byTick = [...beacons].sort((x, y) => String(x.lastTick ?? '').localeCompare(String(y.lastTick ?? '')));
  for (const b of byTick) {
    const root = gitOut(b.cwd, ['rev-parse', '--show-toplevel']) ?? b.cwd;
    const id = `${b.sessionId ?? `anon:${b.cwd}`}\0${root}`;
    const prev = seats.get(id);
    if (!prev) seats.set(id, { b, root, beacons: [b] });
    else {
      prev.beacons.push(b);
      // Oldest first, so later (fresher) non-null fields win.
      prev.b = { ...prev.b, ...Object.fromEntries(Object.entries(b).filter(([, v]) => v != null)) };
    }
  }
  // A beacon left behind by a removed worktree names a directory that is gone,
  // and a branch that is usually gone with it. Drop that row when the session
  // has a row in a directory that exists; a session whose only row is gone
  // stays listed, since its window is still real.
  const exists = new Map([...seats.values()].map((s) => [s, fs.existsSync(s.root)]));
  const housed = new Set([...seats.values()].filter((s) => exists.get(s) && s.b.sessionId).map((s) => s.b.sessionId));
  const shown = [...seats.values()].filter((s) => exists.get(s) || !housed.has(s.b.sessionId));
  return shown.map(({ b, root, beacons: group }) => {
    const winId = b.windowId ?? group.map((x) => x.windowId).find((w) => w != null) ?? null;
    const win = winId != null ? wins.find((w) => w.id === Number(winId)) : null;
    let branch = branchOf(b);
    if (branch === 'HEAD') {
      const sha = gitOut(root, ['rev-parse', '--short', 'HEAD']);
      if (sha) branch = `HEAD@${sha}`;
    }
    return {
      windowId: winId != null ? Number(winId) : null,
      sessionId: b.sessionId ?? null,
      cwd: root,
      repo: repoOf(b),
      branch,
      roles: holders.filter((h) => h.session_id === b.sessionId).map((h) => h.role),
      title: win ? (win.title || win.tabTitle || '') : null,
      mailbox: group.some((x) => x.mailbox === true),
      ...(group.every((x) => x.idleMs != null) ? { idleMinutes: idleMinutes({ idleMs: Math.min(...group.map((x) => x.idleMs)) }) } : {}),
      key: recipientKey({ cwd: b.cwd, sessionId: b.sessionId }),
    };
  });
};

// The tail appended to a "no such window" error: same-repo live seats and
// every role holder, each with the exact --to to use. At most 8 lines.
const HINT_MAX_LINES = 8;
const seatHint = (beacons, wins, sender) => {
  try {
    const holders = readRoleHolders();
    const self = sender
      ? beacons.find((b) => isSenderBeacon(b, sender)) ?? beacons.find((b) => b.cwd === sender.cwd)
      : null;
    const myRepo = self ? repoOf(self) : gitRepoName(sender?.cwd);
    const entries = [];
    const shown = new Set();
    const seatLine = (b, roles) => {
      const win = b.windowId != null ? wins.find((w) => w.id === Number(b.windowId)) : null;
      const via = roles.length ? `role:${roles[0]}` : b.windowId != null ? String(b.windowId) : recipientKey({ cwd: b.cwd, sessionId: b.sessionId });
      const label = (win?.title || win?.tabTitle || path.basename(b.cwd || '')) ?? '';
      return `  ${label} (${repoOf(b) ?? 'no repo'}${roles.length ? `, ${roles.map((r) => `role:${r}`).join(' ')}` : ''}) -> --to ${via}`;
    };
    for (const b of beacons) {
      if (isSenderBeacon(b, sender)) continue;
      if (!myRepo || repoOf(b) !== myRepo) continue;
      const roles = holders.filter((h) => h.session_id === b.sessionId).map((h) => h.role);
      roles.forEach((r) => shown.add(r));
      entries.push(seatLine(b, roles));
    }
    for (const h of holders) {
      if (shown.has(h.role)) continue;
      const live = beacons.find((b) => b.sessionId === h.session_id);
      entries.push(live
        ? seatLine(live, holders.filter((x) => x.session_id === h.session_id).map((x) => x.role))
        : `  role:${h.role} (no live holder; a send queues) -> --to role:${h.role}`);
    }
    if (entries.length === 0) return '';
    const room = HINT_MAX_LINES - 1;
    const body = entries.length > room ? [...entries.slice(0, room - 1), `  ... ${entries.length - room + 1} more: agent-send --who`] : entries;
    return `\ncandidates:\n${body.join('\n')}`;
  } catch {
    return '';
  }
};

// Append a row; priority is one of PRIORITIES. Returns the row with its id
// and ts (date -u style ISO, from new Date().toISOString()).
// A topic names a broadcast whose earlier copies are noise once a newer one
// exists (RESUME, a round's question): one delivery per topic per recipient.
// Rendered after a row's text by every consumer and by --read.
export const supersedesNote = (row) => (row?.supersedes > 0 ? ` (supersedes ${row.supersedes})` : '');

export const TOPIC_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export const appendMessage = ({ to, from, priority, text, topic, via, now = Date.now(), dir } = {}) => {
  if (!PRIORITIES.includes(priority)) throw new Error(`priority must be one of ${PRIORITIES.join('|')}, got '${priority}'`);
  if (topic != null && !TOPIC_RE.test(topic)) throw new Error(`topic must match ${TOPIC_RE}, got '${topic}'`);
  const row = {
    id: randomUUID(),
    ts: new Date(now).toISOString(),
    from: from ?? null,
    to,
    priority,
    text,
  };
  if (via != null) row.via = via;
  if (topic != null) {
    row.topic = topic;
    // Withdraw every earlier unacked row of this topic for this recipient, from
    // any sender; the count rides on the new row so the reader can say so.
    const earlier = readUnacked(to, { dir }).filter((m) => m.topic === topic);
    if (earlier.length > 0) row.supersedes = earlier.reduce((n, m) => n + 1 + (m.supersedes ?? 0), 0);
    appendRow(to, 'message', row, dir);
    for (const m of earlier) cancelQueued({ key: to, id: m.id, now, dir });
    return row;
  }
  if (useMailboxDb(dir)) {
    withMailboxDb((store) =>
      store.run(
        'INSERT INTO mailbox_rows (recipient_key, kind, msg_id, ts, row_json) VALUES (?, ?, ?, ?, ?)',
        to, 'message', row.id, row.ts, JSON.stringify(row),
      ),
    );
    return row;
  }
  fs.mkdirSync(resolveMailboxDir(dir), { recursive: true });
  fs.appendFileSync(mailboxPath(to, { dir }), `${JSON.stringify(row)}\n`);
  return row;
};

const appendRow = (key, kind, row, dir) => {
  if (useMailboxDb(dir)) {
    withMailboxDb((store) =>
      store.run(
        'INSERT INTO mailbox_rows (recipient_key, kind, msg_id, ts, row_json) VALUES (?, ?, ?, ?, ?)',
        key, kind, row.id, row.ts, JSON.stringify(row),
      ),
    );
    return;
  }
  fs.mkdirSync(resolveMailboxDir(dir), { recursive: true });
  fs.appendFileSync(mailboxPath(key, { dir }), `${JSON.stringify(row)}\n`);
};

const readRows = (key, { dir } = {}) => {
  if (useMailboxDb(dir)) return withMailboxDb((store) => dbReadRows(store, key));
  let text;
  try {
    text = fs.readFileSync(mailboxPath(key, { dir }), 'utf-8');
  } catch {
    return [];
  }
  const rows = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      // A torn final line from a concurrent O_APPEND — skip, don't fail the read.
    }
  }
  return rows;
};

// Message rows with no matching ack row. A withdrawn row (see cancelQueued)
// is not unacked: the sender fell through to kitty-send after the ack wait,
// so the mailbox copy must not deliver later and double-deliver the steer.
export const readUnacked = (key, { dir } = {}) => {
  const acked = new Set();
  const withdrawn = new Set();
  const messages = [];
  for (const row of readRows(key, { dir })) {
    if (row && typeof row.ack === 'string') acked.add(row.ack);
    else if (row && typeof row.withdraw === 'string') withdrawn.add(row.withdraw);
    else if (row && typeof row.id === 'string') messages.push(row);
  }
  const live = messages.filter((m) => !withdrawn.has(m.id));
  // One delivery per topic: only the newest live row of a topic survives, even
  // when an older one is still unacked (a send race), and an older row never
  // resurfaces once the survivor is acked. The survivor's supersedes counts
  // the older rows it hid that had not been delivered.
  const newest = new Map();
  for (const m of live) {
    if (m.topic == null) continue;
    const cur = newest.get(m.topic);
    if (!cur || m.ts >= cur.ts) newest.set(m.topic, m);
  }
  const out = [];
  for (const m of live) {
    if (acked.has(m.id)) continue;
    if (m.topic != null) {
      const top = newest.get(m.topic);
      if (top !== m) continue;
      const hidden = live.filter((o) => o !== m && o.topic === m.topic && !acked.has(o.id));
      if (hidden.length > 0) out.push({ ...m, supersedes: (m.supersedes ?? 0) + hidden.length });
      else out.push(m);
    } else out.push(m);
  }
  return out;
};

// The consumer's proof of delivery: {ack: id, ts, deliveredAs}.
export const ack = ({ key, id, deliveredAs, now = Date.now(), dir } = {}) => {
  const row = { ack: id, ts: new Date(now).toISOString(), deliveredAs };
  if (useMailboxDb(dir)) {
    withMailboxDb((store) =>
      store.run(
        'INSERT INTO mailbox_rows (recipient_key, kind, msg_id, ts, row_json) VALUES (?, ?, ?, ?, ?)',
        key, 'ack', id, row.ts, JSON.stringify(row),
      ),
    );
    return row;
  }
  fs.mkdirSync(resolveMailboxDir(dir), { recursive: true });
  fs.appendFileSync(mailboxPath(key, { dir }), `${JSON.stringify(row)}\n`);
  return row;
};
// Where one message id stands: {key, state, ackTs, deliveredAs, withdrawTs},
// state queued | delivered | withdrawn | missing. `key` is the recipient key
// the MESSAGE row was stored under — for a role-addressed send that is the
// holder's session key, never the `role:<name>` the sender typed. An ack or
// withdraw row counts only under that same key, because that is the only place
// a drain reads it (a withdraw written under a wrong key withdraws nothing).
// Entries are {key, row} pairs from either backend.
const classifyRows = (id, entries) => {
  const msg = entries.find((e) => e.row?.id === id);
  if (!msg) return { key: null, state: 'missing', ackTs: null, deliveredAs: null, withdrawTs: null };
  const own = entries.filter((e) => e.key === msg.key);
  const ackRow = own.find((e) => e.row?.ack === id)?.row;
  const wdRow = own.find((e) => e.row?.withdraw === id)?.row;
  // A drain that read the ack first delivered it; a withdraw that landed first
  // won. Whichever row was appended earlier decides, as in readUnacked's order.
  let state = 'queued';
  if (ackRow && wdRow) state = own.findIndex((e) => e.row === ackRow) < own.findIndex((e) => e.row === wdRow) ? 'delivered' : 'withdrawn';
  else if (ackRow) state = 'delivered';
  else if (wdRow) state = 'withdrawn';
  return { key: msg.key, state, ackTs: ackRow?.ts ?? null, deliveredAs: ackRow?.deliveredAs ?? null, withdrawTs: wdRow?.ts ?? null };
};
const dbEntries = (store, id) =>
  store
    .all('SELECT recipient_key, row_json FROM mailbox_rows WHERE msg_id = ? ORDER BY rowid', id)
    .map((r) => ({ key: r.recipient_key, row: JSON.parse(r.row_json) }));
const fileEntries = (id, dir) => {
  const dirPath = resolveMailboxDir(dir);
  let files = [];
  try {
    files = fs.readdirSync(dirPath).filter((f) => f.endsWith('.jsonl'));
  } catch {
    return [];
  }
  const out = [];
  for (const f of files) {
    const key = f.slice(0, -'.jsonl'.length);
    for (const row of readRows(key, { dir })) {
      if (row && (row.id === id || row.ack === id || row.withdraw === id)) out.push({ key, row });
    }
  }
  return out;
};
export const findRow = ({ id, dir } = {}) => {
  if (useMailboxDb(dir)) return withMailboxDb((store) => classifyRows(id, dbEntries(store, id)));
  return classifyRows(id, fileEntries(id, dir));
};

// Withdraw a queued row by id: {withdraw: id, ts}. The id is looked up and the
// withdraw is written under the row's REAL recipient key, never the caller's —
// a role-addressed send stores its row under the holder's session key, and a
// withdraw filed under `role:<name>` is read by no drain (agent-config#1379).
// The caller's `key` is only a hint; keyCorrected reports when it was wrong.
// A row that is already delivered, already withdrawn or unknown writes
// NOTHING and comes back {withdrawn: false, state, ...} so the caller can say
// why. In store mode the lookup and the insert share one IMMEDIATE
// transaction, so a drain cannot ack the row between them. It is one O_APPEND
// write in file mode, atomic against a concurrent consumer drain — whichever
// row the consumer reads first decides, and readUnacked/readUnackedBySession
// never return a withdrawn row. The sender calls this immediately before
// falling through to kitty-send, so a late mailbox drain cannot double-deliver
// the steer. Consumers that read the raw file (the omp mailbox.ts hook) must
// honor withdraw rows too; until that ships the kitty copy carries an
// act-once note (see agent-send.mjs).
export const cancelQueued = ({ key, id, now = Date.now(), dir } = {}) => {
  const row = { withdraw: id, ts: new Date(now).toISOString() };
  const verdict = (found) =>
    found.state === 'queued'
      ? { withdrawn: true, key: found.key, keyCorrected: key != null && key !== found.key }
      : { withdrawn: false, ...found };
  if (useMailboxDb(dir)) {
    return withMailboxDb((store) =>
      store.transaction(() => {
        const found = classifyRows(id, dbEntries(store, id));
        if (found.state === 'queued') {
          store.run(
            'INSERT INTO mailbox_rows (recipient_key, kind, msg_id, ts, row_json) VALUES (?, ?, ?, ?, ?)',
            found.key, 'withdraw', id, row.ts, JSON.stringify(row),
          );
        }
        return verdict(found);
      }),
    );
  }
  const found = classifyRows(id, fileEntries(id, dir));
  if (found.state === 'queued') {
    fs.mkdirSync(resolveMailboxDir(dir), { recursive: true });
    fs.appendFileSync(mailboxPath(found.key, { dir }), `${JSON.stringify(row)}\n`);
  }
  return verdict(found);
};
// A delivery that bypassed the mailbox (agent-send's typed kitty fallback)
// still leaves a message row, acked at once, so the store sees every delivery
// and a later same-topic send can find it (agent-config#1379 W5).
export const recordTypedDelivery = ({ to, from, priority, text, topic, now = Date.now(), dir } = {}) => {
  const row = appendMessage({ to, from, priority, text, topic, via: 'typed', now, dir });
  ack({ key: to, id: row.id, deliveredAs: 'typed', now, dir });
  return row;
};

// The newest message of this topic to this recipient that was delivered (acked)
// within windowMs, or null: {ts (the ack's), from, id}. windowMs <= 0 disables.
export const findRecentTopicDelivery = ({ key, topic, windowMs, now = Date.now(), dir } = {}) => {
  if (!(windowMs > 0)) return null;
  const rows = readRows(key, { dir });
  const msgs = new Map();
  for (const r of rows) if (r && typeof r.id === 'string' && r.topic === topic) msgs.set(r.id, r);
  let best = null;
  for (const r of rows) {
    if (!r || typeof r.ack !== 'string' || !msgs.has(r.ack)) continue;
    const t = Date.parse(r.ts);
    if (!Number.isFinite(t) || now - t > windowMs || t > now + 60_000) continue;
    if (!best || t > best.t) best = { t, ts: r.ts, from: msgs.get(r.ack).from, id: r.ack };
  }
  return best && { ts: best.ts, from: best.from, id: best.id };
};

// Poll for the ack row up to deadlineMs; true on ack, false on timeout.
// deadlineMs null/undefined waits unbounded (the --queue case).
export const waitForAck = ({ key, id, deadlineMs = 20_000, pollMs = 200, dir } = {}) => {
  const start = Date.now();
  for (;;) {
    const rows = readRows(key, { dir });
    if (rows.some((r) => r && r.ack === id)) return true;
    if (deadlineMs != null && Date.now() - start >= deadlineMs) return false;
    const left = deadlineMs == null ? pollMs : Math.min(pollMs, deadlineMs - (Date.now() - start));
    if (left <= 0) return false;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, left);
  }
};

// Remove mailbox files whose recipient has been absent from presence longer
// than PRESENCE_STALE_MS, or whose writer pid is dead (isLiveBeacon, imported). A moved session's
// pre-move key is kept while the session itself is live under ANY cwd: the
// reader scans by session id, so the file is still reachable, and pruning it
// would lose rows a sender addressed to the pre-move key. Returns removed keys.
export const pruneStale = ({ now = Date.now(), dir, presenceFile: file } = {}) => {
  // SQLite mode keeps no per-recipient files: presence-absence deletes
  // nothing (a closed session's rows survive until retention removes them),
  // so prune here only enforces the retention rule and removes no keys.
  if (useMailboxDb(dir)) {
    withMailboxDb((store) => pruneRetention(store, { now }));
    return [];
  }
  const beacons = readPresenceBeacons({ presenceFile: file, now });
  const live = new Set(beacons.map((b) => recipientKey({ cwd: b.cwd, sessionId: b.sessionId })));
  const liveSessions = new Set(beacons.map((b) => sanitizeSessionId(b.sessionId)));
  const dirPath = resolveMailboxDir(dir);
  let files = [];
  try {
    files = fs.readdirSync(dirPath).filter((f) => f.endsWith('.jsonl'));
  } catch {
    return [];
  }
  const removed = [];
  for (const f of files) {
    const key = f.slice(0, -'.jsonl'.length);
    if (live.has(key)) continue;
    // A role queue outlives every session: it waits for the next holder.
    if (key.startsWith(ROLE_PREFIX)) continue;
    const sep = key.lastIndexOf('__');
    if (sep !== -1 && liveSessions.has(key.slice(sep + 2))) continue;
    try {
      fs.rmSync(path.join(dirPath, f));
      removed.push(key);
    } catch {
      // Gone or locked between readdir and rm — not an error.
    }
  }
  return removed;
};
