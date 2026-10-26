// Seat roles: a name that stays valid when the session behind it changes.
//
// A role maps to ONE holder session. A later claim takes the role over, so
// `--to role:lead` keeps working after the lead seat moves to a new window.
// Mail for a role with no live holder waits under the mailbox key
// `role:<name>` and is drained by whichever session holds the role next.
//
// These helpers take an open store (lib/store.mjs openStore) so callers
// control the transaction and the db path; withRolesDb opens the default one.

import { defaultStorePath, openStore } from './store.mjs';

export const ROLE_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const ROLE_PREFIX = 'role:';

export const validateRoleName = (role) => {
  if (typeof role !== 'string' || !ROLE_NAME_RE.test(role)) {
    throw new Error(`invalid role name '${role}': use [a-z0-9][a-z0-9-]{0,63}`);
  }
  return role;
};

// `role:lead` -> 'lead'; anything else -> null. Does not validate the name.
export const roleFromTarget = (target) =>
  typeof target === 'string' && target.startsWith(ROLE_PREFIX) ? target.slice(ROLE_PREFIX.length) : null;

// The mailbox key mail for a role is stored under.
export const roleMailboxKey = (role) => `${ROLE_PREFIX}${validateRoleName(role)}`;

export const claimRole = (db, { role, sessionId, cwd = null, windowId = null, now = Date.now() } = {}) => {
  validateRoleName(role);
  if (sessionId == null || sessionId === '') throw new Error('claimRole needs a session id');
  db.run(
    `INSERT INTO seat_roles (role, session_id, cwd, window_id, claimed_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (role) DO UPDATE SET
       session_id = excluded.session_id, cwd = excluded.cwd,
       window_id = excluded.window_id, claimed_at = excluded.claimed_at`,
    role, String(sessionId), cwd, windowId == null ? null : String(windowId), now,
  );
  return roleHolder(db, role);
};

// The holder row {role, session_id, cwd, window_id, claimed_at}, or null.
export const roleHolder = (db, role) => db.get('SELECT * FROM seat_roles WHERE role = ?', role) ?? null;

export const rolesForSession = (db, sessionId) =>
  sessionId == null
    ? []
    : db.all('SELECT role FROM seat_roles WHERE session_id = ? ORDER BY role', String(sessionId)).map((r) => r.role);

export const allRoleHolders = (db) => db.all('SELECT * FROM seat_roles ORDER BY role');

// Open the default store, run fn(db), close.
export const withRolesDb = (fn, dbPath = defaultStorePath()) => {
  const db = openStore(dbPath);
  try {
    return fn(db);
  } finally {
    db.close();
  }
};
