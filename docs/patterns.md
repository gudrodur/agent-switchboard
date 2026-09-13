# Eight patterns, more than one message each

Time runs down. Each step names its channel and the proof that it arrived.
Six were observed on one night of real work; two are proposed, because the
night showed they are missing. Lanes: the human, lead agents (Runtime A), the
supervisor and workers (Runtime B), research and review agents (Runtime B),
the channel store, the terminal, shared files, and the shared record (issues,
pull requests, checks, merges).

## 1. Steering down a chain, with a correction loop (observed)

Problem: a worker's report says the work is correct, and nobody above it has
checked that claim against the real world.

The human asks the lead to finish the last rows. The lead measures, writes
the plan and every brief, and starts the supervisor with its brief; the
supervisor starts the worker with its brief. The worker reports back, the
supervisor commits, pushes and opens the PR — and the lead still does not
trust the worker's own fixtures. The lead probes with real instances, sends
the failure back down as a steer, the worker reworks, the supervisor pushes
again, and the lead probes once more before merging.

1. Human → lead, chat: finish the last two rows. Proof: reply in chat.
2. Lead → lead, files: measure, write the plan and every brief. Proof: brief files with a ground-truth block.
3. Lead → supervisor, files: start with its brief. Proof: launch confirmed, state readable.
4. Supervisor → worker, files: start with its brief. Proof: launch logged.
5. Worker → supervisor, files: report, ending with a parking line. Proof: newer file time plus the parking line.
6. Supervisor → record: commit, push, open the PR. Proof: CI run newer than the baseline.
7. The worker's own fixtures passed 9 of 9. The lead does not trust them.
8. Lead → lead, files: probe with real instances, 3 of 4 caught. Proof: probe output quoting each case.
9. Lead → supervisor, cross-platform channel: steer 1, send it back, do not fix it. Proof: ack row.
10. Supervisor → worker, cross-platform channel: forwarded steer. Proof: ack row; forward logged.
11. Worker → supervisor, files: rework, and the report overwritten. Proof: newer file time plus the parking line.
12. Supervisor → record: push the rework. Proof: CI green on the new head.
13. Lead → record: probe again, then merge. Proof: merge hash; proof re-run on main.

Lessons: never steer a worker directly past its supervisor — two writers make
the same edit twice. A report is a claim; verification uses real instances of
what the change reads, never the worker's fixtures. A supervisor that parks
while its worker runs is woken by nobody, so it waits in a foreground loop.

## 2. Delivery that proves itself and never drops (observed)

Problem: a message to a busy or parked agent vanishes, and the sender cannot
tell a lost message from an ignored one.

The lead writes one row — id, address, deadline — and the consumer drains it
and acks. When no ack comes before the deadline because the recipient is
inside a long tool call, the lead withdraws the row, names it, and types the
message into the terminal with an act-once suffix; the agent reads it at its
next turn, and the suffix marks the terminal copy. When no address is known,
or nothing could be typed, the row goes back to the queue.

1. Lead → store, cross-platform channel: one row, id, address, deadline. Proof: row id printed by the sender.
2. Store → supervisor, cross-platform channel: drained at turn start, or watched while parked. Proof: row marked delivered.
3. Supervisor → store, cross-platform channel: ack row. Proof: ack readable by the sender.
4. Branch, no ack before the deadline: the recipient is inside a long tool call.
5. Lead → store, cross-platform channel: withdraw the row, naming it. Proof: row withdrawn.
6. Lead → terminal, fallback: type it in, with an act-once suffix. Proof: new inbound row in the session file.
7. Terminal → supervisor, fallback: the agent reads it at its next turn. Proof: the suffix marks the terminal copy.
8. Branch, no address known or nothing could be typed.
9. Lead → store, cross-platform channel: the row goes back to the queue. Proof: exit code 3; the row is still queued.

Lessons: a queued send to a supervisor waits for an idle moment that never
comes, so supervisors are sent to now. Never re-send blind — read the named
row first, or the work happens twice. Only the terminal copy carries the
act-once suffix, which is how a probe tells the two paths apart.

## 3. A lease on one scarce slot between two leads (observed)

Problem: two leads share one machine, and two heavy steps at once kill each
other.

The second lead's worker holds the slot, so the second lead tells the first
and the first waits — its side of the exchange needs the human's approval
because the two leads run in different permission modes. The first lead
prepares its supervisor but launches nothing; when the second lead merges and
says the slot is free, the first lead launches.

1. Second lead → first lead, closed channel: my worker holds the slot; I will tell you. Proof: held for approval, permission modes differ.
2. Human → first lead, approval path: approve the held message. Proof: delivered after the click.
3. First lead → second lead, closed channel: ack, no worker from me until your line. Proof: held, approved, released.
4. First lead → supervisor, cross-platform channel: prepare, but launch nothing. Proof: supervisor parks on a waiting line.
5. Second lead → first lead, closed channel: heads-up, merging within ten minutes. Proof: delivered.
6. Second lead → record: merge. Proof: merge hash.
7. Second lead → first lead, closed channel: slot free. Proof: worktree list shows only the main checkout.
8. First lead → supervisor, cross-platform channel: slot free, launch the worker. Proof: ack row; launch logged.

Lessons: two heavy steps at once got a peer's push killed on an earlier
night; the slot is the whole point. Estimated times drift — every time in a
message comes from the clock. Each hold costs a click; the standing answer is
to accept inbound messages by default, while whether a running agent picks
that up is still open.

## 4. Two leads editing one shared document (observed)

Problem: two leads split work by task, and both rewrite the same paragraph of
a shared file.

Before either edits, the second lead asks whether the first lead's changes
touch the file; the first answers with the exact passages. The question and
the answer crossed, so the first lead repeats its answer with the next
message rather than assuming it landed. The second lead opens a PR with three
one-line additions elsewhere, the first lead reads the hunks to confirm they
are clear, the second merges, and the first tells its supervisor to rebase
before pushing.

1. Second lead → first lead, closed channel: do your changes touch this file? Proof: delivered.
2. First lead → second lead, closed channel: yes, these two passages are mine. Proof: delivered.
3. The question and the answer crossed, so the first lead repeats its answer with the next message.
4. Second lead → first lead, closed channel: agreed, my three lines are elsewhere. Proof: delivered.
5. Second lead → record: PR with three one-line additions. Proof: PR number.
6. First lead → first lead, record: read the hunks, clear of mine. Proof: first hunk ends paragraphs before mine.
7. Second lead → record: merge. Proof: merge hash.
8. Second lead → first lead, closed channel: merged, rebase onto it. Proof: delivered.
9. First lead → supervisor, cross-platform channel: rebase your worker's branch before you push. Proof: ack row; rebase logged.

Lessons: a split by task alone let two sessions rewrite one paragraph within
ten minutes on an earlier night; the split names passages. When messages
cross, repeating the answer is cheaper than a wrong merge order.

## 5. Escalation: a held message becomes a policy (observed)

Problem: the human is asked to approve routine traffic, and the agents cannot
see whether anything is waiting.

A message between the leads is held for approval; the human sees the hold and
can deny or deliver it, and tells the receiving lead to stop asking and
accept by default. The lead sets inbound messages to accept. The next message
still cannot be proven delivered from inside — the lead first wrote "arrived
with no hold", inferred from silence, and had to withdraw it. The open
question goes to the tracker with a revisit date.

1. Second lead → first lead, closed channel: a question about shared files. Proof: held, permission modes differ.
2. Human → human, chat: sees the hold, deny or deliver. Proof: visible to the human only.
3. Human → first lead, chat: do not ask me; accept by default. Proof: reply in chat.
4. First lead → first lead, files: set inbound messages to accept. Proof: setting readable in the file.
5. Second lead → first lead, closed channel: the next message. Proof: still held? Not provable from inside.
6. The lead first wrote "arrived with no hold", inferred from silence, and had to withdraw it.
7. First lead → record: the open question with a revisit date. Proof: issue carrying a Revisit: line.

Lessons: silence is not delivery — a held message is invisible to the
receiving agent. An open question is woken by the weekly sweep on its date,
not by memory.

## 6. Research, publish, review, reject with evidence (observed)

Problem: a delegated agent's findings reach a published page unchecked, or a
reviewer's verdicts are accepted wholesale.

The human asks for the paths drawn and lets agents do the groundwork. A
research agent maps every path; the lead checks its sources, finds two false
absences, and publishes. A screenshot shows a crossed label, so the lead
briefs a review agent naming the known defect. The reviewer fixes it — plus
three wrong verdicts, each with its own evidence line, so the lead accepts
the fixes and rejects the three with evidence, then asks the reviewer for its
retro. A second screenshot shows a new collision; the lead renders once,
looks, and republishes.

1. Human → lead, chat: draw the paths; let agents do the groundwork. Proof: reply in chat.
2. Lead → research agent, files: brief, map every path. Proof: launch confirmed.
3. Research agent → files: data plus report. Proof: parking line.
4. Lead → lead, files: check sources, two absences were false. Proof: file and line for each.
5. Lead → files: publish the page. Proof: version 1.
6. Human → lead, chat: screenshot, a label is crossed. Proof: image in chat.
7. Lead → review agent, files: brief, naming the known defect. Proof: launch confirmed.
8. Review agent → files: fixes, plus three wrong verdicts. Proof: report with evidence per claim.
9. Lead → lead, files: accept the fixes, reject three with evidence. Proof: log line per rejection.
10. Lead → review agent, cross-platform channel: verdicts, and a request for its retro. Proof: ack row.
11. Review agent → files: retro, actors taken from one source. Proof: retro file.
12. Human → lead, chat: screenshot, a new collision. Proof: image in chat.
13. Lead → files: render once, look, republish. Proof: version 4.

Lessons: checking coordinates missed text painted over text; only a rendered
page shows it. Deciding who acted from one log line got three verdicts wrong;
the actor and the channel need two sources.

## 7. Correction propagation to every copy (proposed)

Problem: a wrong claim is withdrawn where it was noticed and stays live
everywhere else it was written.

The lead logs a claim and repeats it in a tracker comment; a peer lead
corrects it on the closed channel, so the lead strikes the comment. A
research agent reads the log first and inherits the claim — its own report
flags the stale line, which is how the lead learns the log copy is still
live. From here on nothing does this by itself yet: the proposal is a sweep
of every repo, branch and memory for the phrase, rechecked on a date whose
proof re-runs.

1. Lead → files: log the claim. Proof: log line.
2. Lead → record: the same claim in a tracker comment. Proof: comment.
3. Peer lead → lead, closed channel: every message still needs a click. Proof: delivered.
4. Lead → record: strike and withdraw the comment. Proof: edited comment.
5. Research agent → files: reads the log and inherits the claim. Proof: its report flags the stale line.
6. Lead → files: correct the log line in place. Proof: correction line beneath it.
7. Proposed from here on: nothing does this by itself yet.
8. Lead → files: sweep every repo, branch and memory for the phrase. Proof: zero hits on every branch.
9. Lead → record: recheck on a date, the proof re-runs. Proof: the sweep writes held or failed.

Lessons: fixing one copy left the others live, and a research agent quoted
the stale one. What would build it: a claim-sweep script over files, branches
and tracker comments, run by the weekly recheck.

## 8. A reply that finds its asker across runtimes (proposed)

Problem: a Runtime B agent asks a question, the answer is given on the closed
channel, and it never reaches the asker.

The supervisor writes its question as a row addressed to the lead, and the
lead's inbox hook injects it. The lead asks a peer a sub-question on the
closed channel and gets the answer there — where, today, the answer stops,
because the closed channel cannot reach Runtime B. The proposal: the lead
writes a reply row quoting the question's id, and the consumer matches the
reply to the question and wakes the asker.

1. Supervisor → store, cross-platform channel: question, row r1, reply to me. Proof: row id r1.
2. Store → lead, cross-platform channel: inbox hook injects r1. Proof: ack row.
3. Lead → peer lead, closed channel: a sub-question to a peer. Proof: delivered.
4. Peer lead → lead, closed channel: the answer. Proof: delivered.
5. Today the answer stops here: the closed channel cannot reach Runtime B.
6. Lead → store, cross-platform channel: reply quoting r1. Proof: row r2, in reply to r1.
7. Store → supervisor, cross-platform channel: consumer matches r2 to r1 and wakes the asker. Proof: ack on r2; r1 closed.

Lessons: an answer on the wrong channel never reaches a Runtime B agent, and
nothing says so. What would build it: an in-reply-to field on rows, and a
consumer that wakes a parked asker on a match.
