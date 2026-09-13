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
import { PRESENCE_FILE, PRESENCE_STALE_MS, presenceRowToBeacon, switchboardDir } from './presence.mjs';
import { defaultStorePath, openStore, importLegacy, pruneRetention } from './store.mjs';

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
export const DELIVERED_AS = Object.freeze(['prompt', 'mcp', 'steer', 'followUp', 'nextTurn']);

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
      return beacons.filter((b) => {
        const tick = Date.parse(b.lastTick);
        return Number.isFinite(tick) && now - tick < PRESENCE_STALE_MS;
      });
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
  return beacons.filter((b) => {
    const tick = Date.parse(b.lastTick);
    return Number.isFinite(tick) && now - tick < PRESENCE_STALE_MS;
  });
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

// Live beacons sharing a window's cwd — the fallback candidates for a window
// id or title target when no beacon recorded the window's own id (see
// beaconsForWindowId). A shared cwd means candidates, never an answer.
const beaconsForWindow = (beacons, win) => beacons.filter((b) => b.cwd === win.cwd);

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
  const exact = beaconsForWindowId(beacons, win).filter((b) => !isSenderBeacon(b, sender));
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
    if (aged.length > 0) {
      const tick = Date.parse(aged[0].lastTick);
      const ago = Number.isFinite(tick) ? `${Math.round((Date.now() - tick) / 1000)}s ago` : 'at an unreadable time';
      throw resErr(
        'mailbox-stale',
        `window ${win.id} has no LIVE presence beacon (last tick ${aged[0].lastTick ?? 'unknown'}, ${ago} — past the presence window); its consumer is parked or gone`,
      );
    }
    throw resErr('mailbox-no-beacon', `window ${win.id} has no live presence beacon`);
  }
  const others = same.filter((b) => !isSenderBeacon(b, sender));
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
// Resolve a --to target to a recipient. Accepts a mailbox key, a kitty window
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
  const byKey = beacons.find((b) => recipientKey({ cwd: b.cwd, sessionId: b.sessionId }) === target);
  if (byKey) return recipientOf(byKey, null);

  if (typeof target === 'string' && target.includes('__')) {
    const sid = target.slice(target.lastIndexOf('__') + 2);
    const sameSession = beacons.filter((b) => sanitizeSessionId(b.sessionId) === sid);
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
    if (!win) throw new Error(`no kitty window with id ${target}`);
    return resolveWindowRecipient(beacons, win, sender, { presenceFile: file });
  }

  const matches = wins.filter((w) => w.title.includes(target) || w.tabTitle.includes(target));
  if (matches.length === 0) throw new Error(`no kitty window matches '${target}'`);
  if (new Set(matches.map((w) => w.id)).size > 1) {
    const ids = matches.map((w) => w.id).join(', ');
    throw new Error(`ambiguous target '${target}' matches windows ${ids} — pass the window id instead`);
  }
  return resolveWindowRecipient(beacons, matches[0], sender, { presenceFile: file });
};

// Append a row; priority is one of PRIORITIES. Returns the row with its id
// and ts (date -u style ISO, from new Date().toISOString()).
export const appendMessage = ({ to, from, priority, text, now = Date.now(), dir } = {}) => {
  if (!PRIORITIES.includes(priority)) throw new Error(`priority must be one of ${PRIORITIES.join('|')}, got '${priority}'`);
  const row = {
    id: randomUUID(),
    ts: new Date(now).toISOString(),
    from: from ?? null,
    to,
    priority,
    text,
  };
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
  return messages.filter((m) => !acked.has(m.id) && !withdrawn.has(m.id));
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
// Withdraw a queued row: {withdraw: id, ts}. One O_APPEND write, so the
// cancel is atomic against a concurrent consumer drain — whichever row the
// consumer reads first decides, and readUnacked/readUnackedBySession never
// return a withdrawn row. The sender calls this immediately before falling
// through to kitty-send, so a late mailbox drain cannot double-deliver the
// steer. Consumers that read the raw file (the omp mailbox.ts hook) must
// honor withdraw rows too; until that ships the kitty copy carries an
// act-once note (see agent-send.mjs).
export const cancelQueued = ({ key, id, now = Date.now(), dir } = {}) => {
  const row = { withdraw: id, ts: new Date(now).toISOString() };
  if (useMailboxDb(dir)) {
    withMailboxDb((store) =>
      store.run(
        'INSERT INTO mailbox_rows (recipient_key, kind, msg_id, ts, row_json) VALUES (?, ?, ?, ?, ?)',
        key, 'withdraw', id, row.ts, JSON.stringify(row),
      ),
    );
    return row;
  }
  fs.mkdirSync(resolveMailboxDir(dir), { recursive: true });
  fs.appendFileSync(mailboxPath(key, { dir }), `${JSON.stringify(row)}\n`);
  return row;
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
// than PRESENCE_STALE_MS (imported, never restated). A moved session's
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
