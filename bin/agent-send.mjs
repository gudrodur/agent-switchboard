#!/usr/bin/env node
// Send a message to another agent through its mailbox and prove delivery by
// the consumer's own ack row, not by reading a screen. Same flag vocabulary as kitty-send.sh, so callers change one
// command name: --to, --text, --file, --now, --stop, --idle-when, --queue,
// --deadline. Priority mapping: --now (and a bare --text) is `now`,
// --stop is `stop`, --idle-when is `idle`, --queue is `queue`. A window id
// resolves by the window id the recipient recorded in its beacon
// (KITTY_WINDOW_ID, via mailbox-inject), not by cwd, so two sessions sharing
// one cwd stay addressable. Exit 0 on ack. After an unacked wait the sender
// re-reads the ack once (a "no ack" at the wait limit is not "not delivered":
// rows ack 20 s to 3 min later), withdraws the mailbox row, and falls through
// to kitty-send.sh, saying "queued, recipient busy/parked" with the next step
// instead of phrasing the wait limit as a failure; the row id and the mailbox
// path print on stderr either way. The message is never dropped on that path:
// with no kitty window to fall back to, the row is left queued, and
// when kitty-send sends nothing the message goes back in the mailbox; both
// exit 3. A recipient with no registered consumer
// (beacon mailbox flag, set by the consumer hook each turn) falls through to
// kitty-send.sh (resolved relative to this file, the way omp-tab.sh resolves
// its sibling) and says so on stderr; so does a window id or title with no
// mailbox consumer behind it at all (an omp tab, a plain shell — the
// supervisor steer path), while an ambiguous window stays a fatal error.
// --stop becomes --now there, the one kitty flag that sends mid-turn. The
// sender prunes stale mailboxes before resolving. --read prints and acks this
// session's unacked rows (the inbox-read entry omp sessions call); --cancel
// withdraws one queued row by id.
//
// A slash command cannot travel this way. A mailbox row reaches the
// recipient as a user message, so "/collab" arrives as the literal text
// "/collab" and runs nothing (measured 2026-09-12: two acked rows, two
// literal replies). A slash command runs in the terminal client: send it
// with kitty-send.sh into a window the sender may type into, and confirm it
// on the target's screen, since it writes no session row to prove it by.
//
// Tests only: AGENT_SEND_KITTY_SEND replaces the kitty-send.sh path
// (a stub records its argv), and the AGENT_MAILBOX_* seams of
// lib/agent-mailbox.mjs apply.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  ack,
  appendMessage,
  cancelQueued,
  mailboxPath,
  pruneStale,
  readUnacked,
  readUnackedBySession,
  recipientKey,
  resolveRecipient,
  waitForAck,
} from '../lib/agent-mailbox.mjs';

const die = (msg, code = 1) => {
  process.stderr.write(`agent-send: ${msg}\n`);
  process.exit(code);
};
const usage = () => `Usage:
  agent-send.mjs --to <window-id|title-substring|mailbox-key> (--text LINE | --file /abs/path)
                 [--now | --stop | --idle-when REGEX | --queue] [--deadline N]
  agent-send.mjs --read [--as <session-id>]
  agent-send.mjs --cancel --to <mailbox-key> --id <row-id>

  --now         priority now (default when no mode is given)
  --stop        priority stop: interrupts the consumer's current run
  --idle-when   priority idle (REGEX is the consumer's parked proof)
  --queue       priority queue; the ack wait below is unbounded unless --deadline caps it
  --deadline N  seconds to wait for the ack row (default 20)
  --read        print this session's unacked inbox rows and ack them (inbox read;
                the session is CLAUDE_CODE_SESSION_ID unless --as names it)
  --cancel      withdraw one queued row so a later drain cannot deliver it

  Exit: 0 acked, or delivered and proven by kitty-send; 3 not delivered yet and
  do not resend: the row is queued in the mailbox for the consumer, or kitty-send
  sent it and could not prove it; any other code is kitty-send.sh's own.
`;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const kittySend = () => process.env.AGENT_SEND_KITTY_SEND ?? process.env.AGENT_SWITCHBOARD_SEND ?? path.join(HERE, 'kitty-send.sh');
// kitty-send.sh exit codes that mean NOTHING WAS SENT (its header's table):
// 1 usage or precondition, 4 a dialog was open, 5 the idle wait ran out, 6 a
// send is already queued, 7 mid-turn without --now/--queue/--wait-idle, 9
// the composer already held a paste chip that is not kitty-send's own.
const KITTY_SENT_NOTHING = new Set([1, 4, 5, 6, 7, 9]);
const KITTY_NOTHING_REASON = {
  1: 'usage or precondition error',
  4: 'selection dialog open',
  5: 'idle wait ran out',
  6: 'send already queued',
  7: 'mid-turn without --now/--queue/--wait-idle',
  9: 'composer holds unsubmitted text',
};

// Where a queued kitty-send's delivery verdict lands. Numeric window targets
// only; mirrors kitty-send.sh's QUEUE_DIR default. A fallback can exit 0
// while the queue log later says exit 9 (nothing sent), so the verdict
// needs a name, not just an exit code.
const kittyQueueLog = (target) => {
  if (!/^\d+$/.test(String(target))) return null;
  const runtime = process.env.XDG_RUNTIME_DIR ?? process.env.TMPDIR ?? '/tmp';
  return path.join(runtime, 'kitty-send', `queue-${target}.log`);
};

// kitty-send.sh --file sends this note rather than the file's bytes (a path
// the target reads itself); the mailbox text carries the same note so the
// recipient behaves identically whichever transport delivers it.
const senderLabel = () => process.env.AGENT_SWITCHBOARD_SENDER ?? 'another agent session';
const fileNote = (file) =>
  `Note from ${senderLabel()}: read ${file}, ` +
  `a note written for you, and act on what it says. Use absolute paths and 'git -C <dir> ...'; do NOT rely on 'cd'.`;

const senderWindowId = () => {
  const raw = process.env.KITTY_WINDOW_ID;
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
};

const main = (argv) => {
  let to = null;
  let text = null;
  let file = null;
  let mode = null;
  let idleWhen = null;
  let deadline = null;
  let read = false;
  let cancel = false;
  let asSession = null;
  let rowId = null;
  const rest = [...argv];
  while (rest.length > 0) {
    const a = rest.shift();
    const need = (name) => {
      const v = rest.shift();
      if (v === undefined) die(`${name} needs a value`);
      return v;
    };
    if (a === '--to') to = need('--to');
    else if (a === '--text') text = need('--text');
    else if (a === '--file') file = need('--file');
    else if (a === '--now' || a === '--stop' || a === '--idle-when' || a === '--queue') {
      const want = a === '--now' ? 'now' : a === '--stop' ? 'stop' : a === '--idle-when' ? 'idle' : 'queue';
      if (mode != null && mode !== want) die('pass one of --now, --stop, --idle-when, --queue, not both');
      mode = want;
      if (a === '--idle-when') idleWhen = need('--idle-when');
    }
    else if (a === '--deadline') deadline = need('--deadline');
    else if (a === '--read') read = true;
    else if (a === '--cancel') cancel = true;
    else if (a === '--as') asSession = need('--as');
    else if (a === '--id') rowId = need('--id');
    else if (a === '--help' || a === '-h') {
      process.stdout.write(usage());
      process.exit(0);
    } else die(`unknown argument: ${a} (try --help)`);
  }
  // Inbox read: print this session's unacked rows and ack them, the pull path
  // for a session whose hook prompt has not delivered them yet (omp reads its
  // inbox this way; Claude sessions get theirs injected at the next prompt).
  if (read) {
    if (to != null || text != null || file != null || mode != null || cancel) die('--read takes only --as');
    const sessionId = asSession ?? process.env.CLAUDE_CODE_SESSION_ID ?? null;
    if (sessionId == null) die('--read needs --as <session-id> outside a Claude session');
    const found = readUnackedBySession(sessionId, {});
    for (const { key, row } of found) {
      process.stdout.write(`[${key}] from ${row.from} (${row.priority}, ${row.ts}): ${row.text}\n`);
      try {
        ack({ key, id: row.id, deliveredAs: 'mcp' });
      } catch {
        // Best-effort — the row is still printed above.
      }
    }
    process.stderr.write(`agent-send: inbox ${found.length} unacked row(s) for ${sessionId}\n`);
    process.exit(0);
  }
  // Cancel: withdraw one queued row so a later drain cannot deliver it.
  if (cancel) {
    if (to == null || rowId == null) die('--cancel needs --to <mailbox-key> and --id <row-id>');
    if (text != null || file != null || mode != null) die('--cancel takes only --to and --id');
    cancelQueued({ key: to, id: rowId });
    process.stderr.write(`agent-send: withdrew ${rowId} in ${mailboxPath(to)}\n`);
    process.exit(0);
  }
  if (text != null && file != null) die('pass one of --text or --file, not both');
  if (file != null) {
    if (!path.isAbsolute(file)) die('--file must be an absolute path');
    if (!fs.existsSync(file)) die(`no such file: ${file}`);
    text = fileNote(file);
  }
  if (text == null || text === '') die('pass --text LINE or --file /abs/path');
  if (deadline != null && !/^\d+$/.test(deadline)) die('--deadline must be a number of seconds');
  const priority = mode ?? 'now';
  const deadlineMs = deadline != null ? Number(deadline) * 1000 : priority === 'queue' ? null : 20_000;

  pruneStale({});

  // Who is sending: a window id or title must never resolve back to this key
  // (2026-09-11: --to <window> queued into the sender's own mailbox). A
  // mailbox key stays an explicit address and may name the sender itself.
  // A window with no mailbox consumer at all (an omp tab, a plain shell, a
  // window only the sender's cwd matched) is NOT an error here the way an
  // ambiguous window is: it falls back to kitty-send for that window, the
  // pre-mailbox path supervisors steer omp tabs with. The MCP cannot type
  // into a window, so send_message keeps those as errors.
  const senderSessionId = process.env.CLAUDE_CODE_SESSION_ID ?? null;
  // One kitty-send run; returns its exit status (null when a signal killed it).
  const runKittySend = (why, target, sendText) => {
    process.stderr.write(`agent-send: ${why}, falling back to kitty-send\n`);
    const args = ['--to', String(target)];
    if (file != null) args.push('--file', file);
    else args.push('--text', sendText);
    if (priority === 'idle') args.push('--idle-when', idleWhen);
    if (priority === 'queue') args.push('--queue');
    // A bare --text is priority now but forwards nothing: kitty-send.sh keeps
    // its own mid-turn default (exit 7). Only an explicit --now/--stop sends
    // mid-turn, --stop becoming --now (the one kitty flag that does).
    // --deadline goes along only without --now: kitty-send refuses the pair
    // (exit 1, "mutually exclusive"), and here --deadline bounded agent-send's
    // own ack wait, not a kitty-send idle wait.
    if (mode === 'now' || mode === 'stop') args.push('--now');
    else if (deadline != null) args.push('--deadline', deadline);
    const r = spawnSync(kittySend(), args, { stdio: 'inherit' });
    // kitty-send exit 8: sent under --now while mid-turn and still mid-turn at
    // the deadline — pending in the target's steering queue until the tool
    // boundary, not lost. The ack row (mailbox path) or the session row (kitty
    // path) is the ground truth; never resend blind.
    if (r.status === 8) {
      process.stderr.write(`agent-send: kitty-send exit 8 for ${args[1]}: pending in the steering queue until the tool boundary, not lost; do not resend\n`);
    }
    // A fallback that sent NOTHING must say so with the reason and where the
    // verdict lives: without this an exit 9 reads like delivery.
    if (KITTY_SENT_NOTHING.has(r.status)) {
      const qlog = kittyQueueLog(target);
      process.stderr.write(
        `agent-send: kitty-send exit ${r.status} for ${args[1]}: nothing was sent (${KITTY_NOTHING_REASON[r.status] ?? 'see kitty-send.sh'})` +
        `${qlog ? `; kitty queue log: ${qlog}` : ''}; do not resend blind — check the tab first\n`,
      );
    } else if (r.status === 0 && args.includes('--queue') && kittyQueueLog(target)) {
      // Queued, not delivered: the verdict arrives later and asynchronously,
      process.stderr.write(`agent-send: kitty-send queued for ${args[1]}; delivery is pending — confirm it in ${kittyQueueLog(target)} (a later exit 9 there means nothing was sent)\n`);
    }
    return r.status;
  };
  const kittyFallback = (why) => process.exit(runKittySend(why, to, text) ?? 1);
  let recipient;
  try {
    recipient = resolveRecipient(to, { senderSessionId, senderCwd: process.cwd(), senderWindowId: senderWindowId() });
  } catch (e) {
    // Never just "no consumer": a stale beacon (parked past the presence
    // window) and no beacon at all need different next steps.
    if (e?.code === 'mailbox-stale') kittyFallback(`stale mailbox beacon for ${to} (${e.message})`);
    if (e?.code === 'mailbox-self' || e?.code === 'mailbox-no-beacon') kittyFallback(`no mailbox consumer at ${to}`);
    die(e.message);
  }

  if (!recipient.hasConsumer) {
    kittyFallback(`no mailbox consumer flag for ${to} (live beacon, flag off)`);
  }
  const from = recipientKey({ cwd: process.cwd(), sessionId: process.env.CLAUDE_CODE_SESSION_ID ?? null });
  const row = appendMessage({ to: recipient.key, from, priority, text });
  const mbox = mailboxPath(recipient.key);
  process.stderr.write(`agent-send: queued ${row.id} in ${mbox}\n`);
  const ok = waitForAck({ key: recipient.key, id: row.id, deadlineMs });
  if (ok) {
    process.stderr.write(`agent-send: acked ${row.id} in ${mbox}\n`);
    process.exit(0);
  }
  // The wait limit is not the delivery verdict: a "no ack" at 20 s is
  // routinely acked seconds later (2026-09-12: queued 01:31:06, acked
  // 01:31:27 as steer). Re-read before falling through, so the fallback never
  // double-delivers a row that landed a moment later.
  if (!readUnacked(recipient.key, {}).some((r) => r.id === row.id)) {
    process.stderr.write(`agent-send: acked ${row.id} in ${mbox} (after the wait limit)\n`);
    process.exit(0);
  }
  // Still pending. Find the window BEFORE withdrawing: a mailbox
  // key whose beacon recorded no window id (an omp tab before its consumer
  // records one, or a cwd two sessions share) has nowhere to fall back to, so
  // the row stays queued for the consumer's next tool boundary.
  const target = recipient.windowId ?? recipient.beaconWindowId ?? (/__/.test(to) ? null : to);
  if (target == null) {
    process.stderr.write(`agent-send: queued, recipient busy/parked for ${row.id} in ${mbox}; no kitty window for ${to}, so the row stays queued for the consumer's next tool boundary (exit 3: not delivered yet, do not resend; withdraw it with --cancel --to ${recipient.key} --id ${row.id}, or re-send with --to <window-id>)\n`);
    process.exit(3);
  }
  // Withdraw, then deliver over kitty. The withdraw is one O_APPEND write
  // (atomic against a concurrent drain), so a late drain cannot deliver the
  // mailbox copy on top of the kitty copy; the kitty text carries an act-once
  // note for the one race left, a drain that read the row just before.
  cancelQueued({ key: recipient.key, id: row.id });
  process.stderr.write(`agent-send: queued, recipient busy/parked for ${row.id} in ${mbox}; withdrew the mailbox row, next: kitty-send to ${target} (its exit 8 means pending in the steering queue until the tool boundary, not lost)\n`);
  const status = runKittySend(
    `queued, recipient busy/parked for ${row.id}`,
    target,
    `${text} (If this same steer reaches you twice, act on it once: the mailbox copy was withdrawn.)`,
  );
  // On these codes kitty-send sent NOTHING (usage or no window, a dialog, the
  // idle wait ran out, a send already queued, mid-turn without --now). The row
  // is withdrawn, so without this the message is gone: put it back.
  if (KITTY_SENT_NOTHING.has(status)) {
    const again = appendMessage({ to: recipient.key, from, priority, text });
    process.stderr.write(`agent-send: kitty-send exit ${status} sent nothing for ${row.id}; re-queued as ${again.id} in ${mbox} for the consumer's next tool boundary (exit 3: not delivered yet, do not resend)\n`);
    process.exit(3);
  }
  if (status == null) {
    process.stderr.write(`agent-send: kitty-send died by a signal; delivery of ${row.id} is unknown and its mailbox row is withdrawn: check the tab before resending\n`);
  }
  process.exit(status ?? 1);
};

main(process.argv.slice(2));
