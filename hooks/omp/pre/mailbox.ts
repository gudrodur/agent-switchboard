// omp mailbox consumer hook — deliver agent-mailbox rows as
// in-session messages. The session_start beacon carries the kitty window
// (kittyWindowId, from KITTY_WINDOW_ID) so agent-send can route to this
// tab's mailbox key and an omp-hosted lookup can
// exclude its own beacon.
//
// Four event handlers, all advisory (a failing hook never breaks the session):
//   session_start      → recordPresence, then flag this session's beacon with
//                         `mailbox: true` so agent-send.mjs routes here instead
//                         of kitty-send. The flag is set by editing our own
//                         beacon after recordPresence (not via a lib param):
//                         recordPresence MERGES on the update path — it only
//                         rewrites lastTick/branch/cwd/homeCwd/repo on our
//                         entry — so the flag survives the per-turn
//                         recordPresence calls every turn.
//                         Also starts the idle watcher + fallback poll below.
//   turn_start         → drain this session's unacked mailbox rows.
//   tool_execution_end → drain again, so a message sent mid-tool-call lands
//                         without waiting for the next turn.
//   session_shutdown   → stop the watcher/poll, then releasePresence so a send
//                         after exit falls back to kitty (no ghost consumer).
//
// Idle path (parked tab): turn_start and tool_execution_end never fire while
// the session is parked, so those drains never run and steers sent to a
// parked tab fall back to kitty-send unacked.
// session_start therefore fs.watches the mailbox directory for every file
// ending in this session's `__<session id>.jsonl` suffix and, when one
// changes while ctx.isIdle() is true, drains exactly as deliver does but
// sends with { deliverAs, triggerTurn: true } (HookAPI.sendMessage only
// wakes an idle agent with triggerTurn; without it the message queues until
// the next turn — which never comes while parked). Suffix match, not one
// captured key: after `/move` the ExtensionRunner's live `cwd` getter
// moves the beacon and new sends to the NEW key, while rows
// already queued under the pre-move key stay in the old file,
// so watching one captured key would miss them.
// A non-idle change is ignored: the in-turn drains deliver it. An empty drain
// sends nothing and triggers no turn, so our own ack appends (which also
// touch the watched files) cannot wake the agent in a loop. A slow poll backs
// the watch in case an event is missed. Delivery itself is the
// ack-first protocol: ack({deliveredAs}) per row, then pi.sendMessage.
// In store mode the fs.watch fast path goes quiet (no key files to watch);
// the 5 s poll still drains, so a parked tab keeps acking within ~5 s.
//
// Drain order per row: ack({deliveredAs}) FIRST, then pi.sendMessage. An ack
// proves the hook read the row; a delivery without an ack is what the sender
// will retry. A drain failure is reported once per session as
// `[mailbox] could not drain the mailbox: <reason>` with display but never
// triggerTurn — a parked tab woken every poll by its own failing drain could
// never go back to sleep.
//
// Priority → deliverAs mapping:
// but the installed runtime has no `aside`: SendMessageHandler in
// @earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts types
// deliverAs as "steer" | "followUp" | "nextTurn", and agent-session.js
// sendCustomMessage steers anything that is not followUp/nextTurn while
// streaming. So `now` takes the interrupting `steer` here — the closest to
// aside's land-promptly on this runtime — until the runtime gains `aside`.
// `nextTurn` is not used.

import type { HookAPI } from "@oh-my-pi/pi-coding-agent/extensibility/hooks";
import fs from "node:fs";
import path from "node:path";
import {
  recordPresence,
  releasePresence,
} from "../../../lib/presence.mjs";
import { readPresenceBeacons } from "../../../lib/agent-mailbox.mjs";
import { kittyWindowId } from "../lib/window-id.ts";
// Explicit `.ts` specifier (the source used the compiled `.js` extension):
// node >= 24 type-stripping resolves this with no build step, which is what
// `npm test` runs under. Whether the omp runtime also accepts it is
// unverified — see the port report.
import {
  readUnacked,
  readUnackedBySession,
  sanitizeSessionId,
  ack,
  recipientKey,
  MAILBOX_DIR,
} from "../../../lib/agent-mailbox.mjs";

// Fallback poll interval: well under agent-send's 20 s ack wait, so a parked
// tab still acks promptly when the fs.watch event is missed; slow enough
// (one small-file read per tick) to be cheap on every parked tab.
export const IDLE_POLL_MS = 5000;

// Presence keepalive: a supervisor idle ~30 min, or stuck in one long busy
// turn, ages past the 20-min presence window, so agent-send stops seeing its
// mailbox flag and every steer falls back to kitty-send. Per-turn
// recordPresence never fires while parked or mid-turn, and the 5 s idle poll
// below drains without re-touching presence. Touch the beacon well inside
// the window; recordPresence merges, so turns keep working as before.
export const PRESENCE_TOUCH_MS = 5 * 60 * 1000;
// Re-touch our own presence beacon without disturbing what turns maintain.
// branch/repo/windowId are read back and passed through (recordPresence
// overwrites branch unconditionally, so omitting it would null it), and
// mailbox:true re-asserts the consumer flag — which also self-heals a beacon
// that already aged out (prune drops it, this re-adds it with the flag).
export const touchPresenceBeacon = ({ cwd, sessionId = null, presenceFile = undefined } = {}) => {
  // Unfiltered read: a beacon past the presence window is still there to be
  // re-touched (the old code read the raw file, never the pruned view), so
  // its branch/windowId survive the resurrection.
  const beaconOpts = { ...(presenceFile ? { presenceFile } : {}), includeStale: true };
  const opts = presenceFile ? { file: presenceFile } : {};
  let branch = null;
  let repo = null;
  let windowId = null;
  try {
    const mine = readPresenceBeacons(beaconOpts).find(
      (b) => `${b.sessionId ?? "anon"}:${b.cwd}` === `${sessionId ?? "anon"}:${cwd}`,
    );
    branch = mine?.branch ?? null;
    repo = mine?.repo ?? null;
    windowId = mine?.windowId ?? kittyWindowId();
  } catch {
    windowId = kittyWindowId();
  }
  recordPresence({ ...opts, cwd, sessionId, branch, repo, mailbox: true, windowId });
  return true;
};

const MESSAGE_TYPE = "mailbox";

export const DELIVERY_FOR_PRIORITY = {
  now: "steer",
  stop: "steer",
  idle: "followUp",
  queue: "followUp",
};

export const sessionIdOf = (sessionManager) => {
  if (process.env.OMP_SESSION_ID) return process.env.OMP_SESSION_ID;
  try {
    const f = sessionManager?.getSessionFile?.();
    if (typeof f === "string" && f) return path.basename(f).replace(/\.jsonl$/, "");
  } catch {
    // fall through to null → lib keys on cwd alone
  }
  return null;
};

// Flag our own presence beacon as a mailbox consumer (or clear it). Runs
// after recordPresence so the beacon exists; recordPresence's merge preserves
// the field on later turns.
export const setMailboxFlag = ({ cwd, sessionId = null, value, presenceFile = undefined } = {}) => {
  const opts = presenceFile ? { file: presenceFile } : {};
  const mine = readPresenceBeacons({ ...(presenceFile ? { presenceFile } : {}), includeStale: true }).find(
    (b) => `${b.sessionId ?? "anon"}:${b.cwd}` === `${sessionId ?? "anon"}:${cwd}`,
  );
  if (!mine) return false;
  recordPresence({
    ...opts, cwd, sessionId,
    branch: mine.branch ?? null, repo: mine.repo ?? null,
    mailbox: value, windowId: mine.windowId ?? null,
  });
  return true;
};

export const flagAtStart = ({ cwd, sessionId = null, presenceFile = undefined } = {}) => {
  const opts = presenceFile ? { file: presenceFile } : {};
  recordPresence({ ...opts, cwd, sessionId, windowId: kittyWindowId() });
  setMailboxFlag({ cwd, sessionId, value: true, ...(presenceFile ? { presenceFile } : {}) });
};

export const releaseAtShutdown = ({ cwd, sessionId = null, presenceFile = undefined } = {}) => {
  releasePresence({ ...(presenceFile ? { file: presenceFile } : {}), sessionId, cwd });
};


// Drain this session's unacked rows: ack first, then deliver. Throws on
// failure so the caller can report it (display-only, never a wake).
// With a session id, drains EVERY key file for this session (pre-move keys
// included: after `/move` the beacon records the new cwd but rows already
// queued under the old key stay in the old file), acking each row under its
// own key. With a null session id there is no suffix to scan for, so keep
// today's behaviour and drain the current key only.
export const drainInbox = ({ cwd, sessionId = null, dir } = {}) => {
  const pairs =
    sessionId != null
      ? readUnackedBySession(sessionId, { dir })
      : (() => {
          const key = recipientKey({ cwd, sessionId });
          return readUnacked(key, { dir }).map((row) => ({ key, row }));
        })();
  const delivered = [];
  for (const { key, row } of pairs) {
    const deliveredAs = DELIVERY_FOR_PRIORITY[row.priority] ?? "followUp";
    ack({ key, id: row.id, deliveredAs, dir });
    delivered.push({ row, deliveredAs });
  }
  return delivered;
};

// Idle-path drain for the parked-tab watcher and fallback poll. Same
// ack-first protocol as drainInbox, but: (a) runs only when isIdle() is true
// — a busy session gets the message via the turn_start/tool_execution_end
// drains; (b) sends with triggerTurn: true so the parked agent wakes;
// (c) sends nothing when the drain is empty, so our own ack appends (which
// also touch the watched file) cannot wake the agent in a loop. A drain
// failure is reported once per session, display-only and never triggerTurn,
// so a persistently failing drain cannot wake the parked agent every poll.
// `send` defaults to a no-op and `isIdle` to busy, so a missing caller fails
// silent-idle rather than waking or crashing. `dir` is the lib's test seam:
// omitted in the hook (real MAILBOX_DIR), set in hermetic checks.
// Distinct drain failures are deduped per session via reportedDrainFailures.
// Failure reports never wake: a wake is a new LLM turn, and a report that
// fires on every 5 s poll while parked would turn a stuck drain into an
// infinite turn loop.
// Each distinct drain-failure message is reported once per session: the idle
// poll retries every 5 s, and an unwoken parked tab would otherwise stack one
// wake per poll per watch event for a single stuck drain.
export const reportedDrainFailures = new Set();
export const deliverIdle = ({ cwd, sessionId = null, dir, isIdle = () => false, send = () => {} } = {}) => {
  let idle = false;
  try {
    idle = !!isIdle();
  } catch {
    return [];
  }
  if (!idle) return [];
  let delivered;
  try {
    delivered = drainInbox({ cwd, sessionId, dir });
  } catch (err) {
    try {
      const content = `[mailbox] could not drain the mailbox: ${err?.message ?? err}`;
      if (!reportedDrainFailures.has(content)) {
        reportedDrainFailures.add(content);
        send({
          customType: MESSAGE_TYPE,
          display: true,
          content,
        });
      }
    } catch {
      // reporting is advisory; never crash the watcher on a send failure
    }
    return [];
  }
  if (delivered.length === 0) return delivered;
  for (const { row, deliveredAs } of delivered) {
    try {
      send(
        {
          customType: MESSAGE_TYPE,
          display: true,
          content: `[mailbox] from ${row.from} (${row.priority}): ${row.text}`,
        },
        { deliverAs: deliveredAs, triggerTurn: true },
      );
    } catch {
      // one row's send failing must not block the rest; rows are acked
    }
  }
  return delivered;
};
// Pure filename gate for the idle watcher, and the hermetic seam its tests
// use (see tests/mailbox-hook.test.mjs). With a session id, any file ending `__<sanitized id>.jsonl`
// belongs to this session (pre-move keys included); without one, only the
// current key's exact file matches. A null, non-string or empty filename
// never matches (fs.watch may pass null).
export const watchMatches = (filename, { cwd, sessionId = null } = {}) => {
  if (typeof filename !== "string" || filename.length === 0) return false;
  if (sessionId != null) return filename.endsWith(`__${sanitizeSessionId(sessionId)}.jsonl`);
  return filename === `${recipientKey({ cwd, sessionId })}.jsonl`;
};

export default function mailboxHook(pi: HookAPI): void {
  const ctxCwd = (ctx) => {
    try {
      return ctx?.cwd ?? process.cwd();
    } catch {
      return process.cwd();
    }
  };

  const deliver = (ctx) => {
    const cwd = ctxCwd(ctx);
    const sessionId = sessionIdOf(ctx?.sessionManager);
    try {
      for (const { row, deliveredAs } of drainInbox({ cwd, sessionId })) {
        pi.sendMessage(
          {
            customType: MESSAGE_TYPE,
            display: true,
            content: `[mailbox] from ${row.from} (${row.priority}): ${row.text}`,
          },
          { deliverAs: deliveredAs },
        );
      }
    } catch (err) {
      const content = `[mailbox] could not drain the mailbox: ${err?.message ?? err}`;
      if (!reportedDrainFailures.has(content)) {
        reportedDrainFailures.add(content);
        pi.sendMessage({
          customType: MESSAGE_TYPE,
          display: true,
          content,
        });
      }
    }
  };
  let idleWatcher = null;
  let idlePoll = null;
  let draining = false;
  // One touch clock shared by the idle poll and the busy-turn tool handler:
  // both paths touch at most once per PRESENCE_TOUCH_MS, well inside the
  // 20-min presence window. Best-effort and advisory like the rest.
  let lastTouchMs = 0;
  const touchThrottled = ({ cwd, sessionId }) => {
    const nowMs = Date.now();
    if (nowMs - lastTouchMs < PRESENCE_TOUCH_MS) return false;
    lastTouchMs = nowMs;
    try {
      touchPresenceBeacon({ cwd, sessionId });
    } catch {
      // next window retries
    }
    return true;
  };
  const stopIdle = () => {
    try {
      idleWatcher.close();
    } catch {
      // never error on the way out (also covers the never-started null)
    }
    try {
      clearInterval(idlePoll);
    } catch {
      // clearInterval no-ops without a live timer; never error
    }
    idleWatcher = null;
    idlePoll = null;
  };
  const startIdle = ({ cwd, sessionId, isIdle }) => {
    stopIdle();
    // Match by session-id suffix via watchMatches,
    // not one captured key: after `/move` new rows land in the NEW key's
    // file while old rows sit in the pre-move file. Null session id has no
    // suffix: fall back to the one current key.
    // suffix/target live inside watchMatches; kept out of here so the only
    // match path is the exported, hermetically tested one.
    const attempt = () => {
      if (draining) return;
      draining = true;
      try {
        deliverIdle({ cwd, sessionId, isIdle, send: (message, options) => pi.sendMessage(message, options) });
        // deliverIdle reports its own failures quietly; attempt() never throws
      } finally {
        draining = false;
      }
      touchThrottled({ cwd, sessionId });
    };
    try {
      fs.mkdirSync(MAILBOX_DIR, { recursive: true });
    } catch {
      // poll below still covers delivery; never break session start
    }
    try {
      // Watch the DIRECTORY, not the file: fs.watch on a not-yet-existing
      // file throws, and the file may not exist until the first steer lands.
      idleWatcher = fs.watch(MAILBOX_DIR, (_eventType, filename) => {
        try {
          if (!watchMatches(filename, { cwd, sessionId })) return;
          attempt();
        } catch {
          // watcher callbacks must never throw; the poll covers the row
        }
      });
    } catch {
      idleWatcher = null;
    }
    try {
      idlePoll = setInterval(() => {
        try {
          attempt();
        } catch {
          // poll is advisory; next tick retries
        }
      }, IDLE_POLL_MS);
    } catch {
      idlePoll = null;
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    const cwd = ctxCwd(ctx);
    const sessionId = sessionIdOf(ctx?.sessionManager);
    // A session-less run (omp -p --no-session) has no session id and can
    // never receive mail: record no beacon and start no idle watcher, so it
    // leaves nothing behind. Sessions with an id behave exactly as before.
    if (sessionId == null) return;
    try {
      flagAtStart({ cwd, sessionId });
    } catch {
      // presence is advisory; never break session start
    }
    try {
      startIdle({ cwd, sessionId, isIdle: () => ctx.isIdle() });
    } catch {
      // watcher is advisory; the in-turn drains still deliver
    }
  });

  pi.on("turn_start", async (_event, ctx) => {
    try {
      deliver(ctx);
    } catch {
      // deliver() already reported the failure as a message
    }
  });

  pi.on("tool_execution_end", async (_event, ctx) => {
    try {
      deliver(ctx);
    } catch {
      // deliver() already reported the failure as a message
    }
    // Busy-turn keepalive: a working tab's turn never ends while it runs,
    // so neither a new turn_start nor the parked-tab poll ever fires —
    // without this the beacon ages out mid-turn. Shares the idle poll's
    // touch clock.
    try {
      touchThrottled({ cwd: ctxCwd(ctx), sessionId: sessionIdOf(ctx?.sessionManager) });
    } catch {
      // presence is advisory; the drain above already ran
    }
  });
  pi.on("session_shutdown", async (_event, ctx) => {
    try {
      stopIdle();
    } catch {
      // best-effort stop; never error on the way out
    }
    try {
      const cwd = ctxCwd(ctx);
      const sessionId = sessionIdOf(ctx?.sessionManager);
      releaseAtShutdown({ cwd, sessionId });
    } catch {
      // best-effort release; never error on the way out
    }
  });
}
