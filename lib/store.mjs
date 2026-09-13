// Shared SQLite store for agent-switchboard runtime state.
//
// One database file (WAL mode) holds the coordination state that used to live
// in JSON files: the mailbox, presence beacons, and later steps' claims and
// measurements. Versioned config (providers, lean overlay, issue areas) stays
// JSON in git; this file lives outside git under the switchboard dir.
//
// Path: AGENT_SWITCHBOARD_DB, default $AGENT_SWITCHBOARD_DIR/state.db. No
// personal path literal anywhere in this file.
//
// Runtime: node scripts use the built-in `node:sqlite`, omp's Bun hooks use
// `bun:sqlite`. Both speak SQLite 3.53 here, one file, so a bun writer and a
// node reader share the database. The pick is synchronous (createRequire), so
// every caller keeps its sync API.
//
// Retention (written rule, enforced by pruneRetention):
// - Acked or cancelled (withdrawn) message rows are deleted 14 days after the
//   ack/withdraw marker, markers included.
// - Unacked rows are NEVER deleted by retention: a closed session's rows
//   survive it, so a probe's evidence outlives its session. Presence-absence
//   deletes nothing; only an explicit ack, cancel, or a later overseer step
//   removes an unacked row.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const isBun = typeof process !== 'undefined' && !!process.versions?.bun;
const sqlite = isBun ? require('bun:sqlite') : require('node:sqlite');

export const runtimeName = () => (isBun ? 'bun:sqlite' : 'node:sqlite');

export const switchboardDir = () =>
  process.env.AGENT_SWITCHBOARD_DIR ??
  path.join(process.env.XDG_STATE_HOME ?? path.join(os.homedir(), '.local', 'state'), 'agent-switchboard');

export const defaultStorePath = () =>
  process.env.AGENT_SWITCHBOARD_DB ?? path.join(switchboardDir(), 'state.db');

// Acked/cancelled rows die this long after their marker; unacked rows live.
export const RETENTION_MS = 14 * 24 * 60 * 60 * 1000;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS mailbox_rows (
  rowid INTEGER PRIMARY KEY AUTOINCREMENT,
  recipient_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  msg_id TEXT NOT NULL,
  ts TEXT NOT NULL,
  row_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mailbox_recipient ON mailbox_rows (recipient_key, kind, msg_id);
CREATE TABLE IF NOT EXISTS presence_beacons (
  session_id TEXT NOT NULL,
  cwd TEXT NOT NULL,
  home_cwd TEXT,
  branch TEXT,
  repo TEXT,
  mailbox INTEGER,
  window_id INTEGER,
  first_tick TEXT NOT NULL,
  last_tick TEXT NOT NULL,
  PRIMARY KEY (session_id, cwd)
);
`;

// One-time import marker: which legacy file set has been absorbed into this db.
export const importMarkerFor = ({ mailboxDir, presenceFile }) => `import_legacy_v1:${mailboxDir ?? ''}:${presenceFile ?? ''}`;

const readJsonlRows = (file) => {
  let text;
  try {
    text = fs.readFileSync(file, 'utf-8');
  } catch {
    return [];
  }
  const rows = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      // A torn final line from a concurrent O_APPEND — skip, don't fail.
    }
  }
  return rows;
};

const classifyRow = (row) => {
  if (row && typeof row.ack === 'string') return { kind: 'ack', msgId: row.ack };
  if (row && typeof row.withdraw === 'string') return { kind: 'withdraw', msgId: row.withdraw };
  if (row && typeof row.id === 'string') return { kind: 'message', msgId: row.id };
  return null;
};

export const openStore = (dbPath = defaultStorePath()) => {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const Database = sqlite.DatabaseSync ?? sqlite.Database;
  const db = isBun ? new Database(dbPath, { create: true }) : new Database(dbPath);
  try {
    db.exec('PRAGMA busy_timeout = 5000;');
    // journal_mode change needs an exclusive lock, which a concurrent writer
    // may hold; unlike DML it does not wait on busy_timeout. WAL persists in
    // the file once any opener sets it, so skipping under contention is safe
    // (busy_timeout still serializes our own writes).
    const getMode = (sql) => (typeof db.prepare === 'function' ? db.prepare(sql).get() : db.query(sql).get());
    let mode = null;
    try {
      mode = getMode('PRAGMA journal_mode').journal_mode;
      if (typeof mode === 'string' && mode.toLowerCase() !== 'wal') db.exec('PRAGMA journal_mode = WAL;');
    } catch {
      // A concurrent opener holds the lock (the mode read or the change
      // itself does not wait on busy_timeout). WAL persists in the file once
      // any opener sets it, and busy_timeout still serializes our own writes.
    }
    db.exec(SCHEMA);
  } catch (e) {
    try {
      db.close();
    } catch {
      // Ignore close errors when open already failed.
    }
    throw e;
  }
  const prepare = (sql) => (typeof db.prepare === 'function' ? db.prepare(sql) : db.query(sql));
  const run = (sql, ...params) => prepare(sql).run(...params);
  const get = (sql, ...params) => prepare(sql).get(...params);
  const all = (sql, ...params) => prepare(sql).all(...params);
  const transaction = (fn) => {
    if (typeof db.transaction === 'function') return db.transaction(fn)();
    db.exec('BEGIN IMMEDIATE;');
    try {
      const out = fn();
      db.exec('COMMIT;');
      return out;
    } catch (e) {
      try {
        db.exec('ROLLBACK;');
      } catch {
        // Rollback of a failed begin is best-effort.
      }
      throw e;
    }
  };
  const close = () => db.close();
  return { path: dbPath, run, get, all, transaction, close };
};

// Absorb an existing mailbox dir (*.jsonl) and presence file ({beacons: [...]})
// into the open store. Idempotent per (db, mailboxDir, presenceFile): the
// marker in meta records it, so a second open imports nothing. The old files
// are left in place; deleting them is a separate overseer step.
export const importLegacy = (store, { mailboxDir = null, presenceFile = null } = {}) => {
  const marker = importMarkerFor({ mailboxDir, presenceFile });
  // The claim lives INSIDE the transaction: two processes opening one fresh
  // db both see the marker absent, so a check-then-insert outside would
  // double-import (UNIQUE constraint failed: meta.k). INSERT OR IGNORE
  // elects one winner; the loser rolls back an empty transaction.
  let outcome = { imported: false };
  store.transaction(() => {
    const claim = store.run('INSERT OR IGNORE INTO meta (k, v) VALUES (?, ?)', marker, new Date().toISOString());
    if (Number(claim.changes ?? 0) === 0) return;
    let messages = 0;
    let beacons = 0;
    if (mailboxDir) {
      let files = [];
      try {
        files = fs.readdirSync(mailboxDir).filter((f) => f.endsWith('.jsonl'));
      } catch {
        files = [];
      }
      for (const f of files) {
        const key = f.slice(0, -'.jsonl'.length);
        for (const row of readJsonlRows(path.join(mailboxDir, f))) {
          const c = classifyRow(row);
          if (!c) continue;
          store.run(
            'INSERT INTO mailbox_rows (recipient_key, kind, msg_id, ts, row_json) VALUES (?, ?, ?, ?, ?)',
            key,
            c.kind,
            c.msgId,
            typeof row.ts === 'string' ? row.ts : new Date(0).toISOString(),
            JSON.stringify(row),
          );
          messages += 1;
        }
      }
    }
    if (presenceFile) {
      let beaconsRaw = [];
      try {
        const parsed = JSON.parse(fs.readFileSync(presenceFile, 'utf-8'));
        if (parsed && Array.isArray(parsed.beacons)) beaconsRaw = parsed.beacons;
      } catch {
        beaconsRaw = [];
      }
      for (const b of beaconsRaw) {
        if (!b || typeof b.cwd !== 'string') continue;
        store.run(
          `INSERT INTO presence_beacons
             (session_id, cwd, home_cwd, branch, repo, mailbox, window_id, first_tick, last_tick)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (session_id, cwd) DO NOTHING`,
          b.sessionId ?? 'anon',
          b.cwd,
          b.homeCwd ?? null,
          b.branch ?? null,
          b.repo ?? null,
          b.mailbox == null ? null : b.mailbox ? 1 : 0,
          b.windowId == null ? null : Number(b.windowId),
          b.firstTick ?? b.lastTick ?? new Date(0).toISOString(),
          b.lastTick ?? b.firstTick ?? new Date(0).toISOString(),
        );
        beacons += 1;
      }
    }
    outcome = { imported: true, messages, beacons };
  });
  return outcome;
};

// Enforce the retention rule written at the top of this file. Returns the
// deleted message count. Unacked rows are never touched.
export const pruneRetention = (store, { now = Date.now() } = {}) => {
  const cutoff = new Date(now - RETENTION_MS).toISOString();
  let deleted = 0;
  store.transaction(() => {
    const staleMarkers = store.all(
      `SELECT DISTINCT msg_id FROM mailbox_rows
        WHERE kind IN ('ack', 'withdraw') AND ts < ?`,
      cutoff,
    );
    for (const { msg_id: id } of staleMarkers) {
      const r = store.run('DELETE FROM mailbox_rows WHERE msg_id = ?', id);
      deleted += Number(r.changes ?? 0);
    }
  });
  return { deleted };
};
