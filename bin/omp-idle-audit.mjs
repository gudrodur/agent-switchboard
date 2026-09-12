#!/usr/bin/env node
// Post-hoc idle audit over omp session files.
//
// An omp tab writes one JSON object per line. A background job starts ONLY as
// a `bash` toolResult row whose joined text blocks carry, on its own line,
// "Backgrounded as job bg_N; result will be delivered automatically." The
// harness appends that line after any partial output, or after the line
// "Backgrounded early to handle an incoming message; the command keeps
// running." plus a blank line. The same phrase embedded inside other text (a
// `read` result echoing another session file, a `bash` result quoting JSON)
// is data, not a start, so the match is line-anchored and toolName-gated.
//
// A job completes in two shapes: (a) a `custom_message` row with customType
// "async-result" whose content string carries "Background job bg_N has
// completed"; (b) a `hub` toolResult row whose text carries a completion
// heading "### bg_N [bash] — completed|failed|cancelled" (em dash as written
// by the harness; hyphen and en dash also accepted). Entries under a
// "## Still Running" section ("- `bg_N` [bash] — ...") are NOT completions.
// Job ids are reused after completion, so a start re-adds the id.
//
// The script walks each file in order, tracks started but not completed jobs
// by id, and emits one finding at every assistant stopReason "stop" row
// where jobs are still alive: class idle-with-job-alive when the turn's last
// text block lacks the parking phrase, class parked-with-job-alive when it
// carries it.
//
// Usage: node scripts/omp-idle-audit.mjs <session.jsonl>... [--format=json]
//   one file:   text is one line per finding; json keeps the findings array.
//   many files: text prefixes each finding with the file basename and prints
//               one summary line per file plus a total line; json becomes
//               [{file, findings, summary}].
//   --alive <session.jsonl> [--format=json]: print the started-not-completed
//               jobs at end of file, one per line
//               `bg_N <startTimestamp> <first 80 chars of command>`,
//               nothing when none; json prints the array. Exit 0 either way.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const PARKING_PHRASE = 'er lokið, ekkert í gangi';
const START_RE = /^Backgrounded as job (bg_\d+); result will be delivered automatically\./m;
const DONE_RE = /Background job (bg_\d+) has completed/;
const HUB_DONE_RE = /^###\s+(bg_\d+)\s+\[bash\]\s+[—–-]\s+(completed|failed|cancelled)\s*$/gm;
const SNIP = 120;

const snip = (s) => String(s ?? '').slice(0, SNIP);

const toolResultText = (row) => {
  const content = row?.message?.content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n');
};

const commandOf = (args) => {
  if (args == null) return '';
  let a = args;
  if (typeof a === 'string') {
    try {
      a = JSON.parse(a);
    } catch {
      return snip(a);
    }
  }
  if (typeof a === 'object' && typeof a.command === 'string') return snip(a.command);
  return '';
};

const lastTextOf = (row) => {
  const content = row?.message?.content;
  if (!Array.isArray(content)) return '';
  const texts = content.filter((b) => b && b.type === 'text' && typeof b.text === 'string');
  return texts.length ? texts[texts.length - 1].text : '';
};

// Shared walk: index toolCall ids to their command first so a start resolves
// even when the toolCall row was read earlier, then track started but not
// completed jobs by id. Calls onStop(alive, row) at every assistant
// stopReason "stop" row with jobs still alive; returns the alive map at end
// of file. auditRows reports a finding per stop; aliveAtEnd keeps only the
// final set.
const walkAlive = (rows, onStop) => {
  const commands = new Map();
  for (const row of rows) {
    if (row?.type !== 'message' || row?.message?.role !== 'assistant') continue;
    const content = row.message.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (b && b.type === 'toolCall' && typeof b.id === 'string') {
        commands.set(b.id, commandOf(b.arguments));
      }
    }
  }

  const alive = new Map();
  for (const row of rows) {
    if (row?.type === 'message' && row?.message?.role === 'toolResult') {
      if (row.message.toolName === 'bash') {
        const m = START_RE.exec(toolResultText(row));
        if (m) {
          alive.set(m[1], {
            startedAt: row.timestamp ?? '',
            command: commands.get(row.message.toolCallId) ?? '',
          });
        }
      } else if (row.message.toolName === 'hub') {
        for (const m of toolResultText(row).matchAll(HUB_DONE_RE)) {
          alive.delete(m[1]);
        }
      }
      continue;
    }
    if (row?.type === 'custom_message' && row?.customType === 'async-result' && typeof row?.content === 'string') {
      const m = DONE_RE.exec(row.content);
      if (m) alive.delete(m[1]);
      continue;
    }
    if (row?.type === 'message' && row?.message?.role === 'assistant' && row?.message?.stopReason === 'stop') {
      if (alive.size === 0) continue;
      onStop?.(alive, row);
    }
  }
  return alive;
};

// Walk parsed rows in order; index toolCall ids to their command first so a
// start resolves even when the toolCall row was read earlier.
export const auditRows = (rows) => {
  const findings = [];
  walkAlive(rows, (alive, row) => {
    const last = lastTextOf(row);
    findings.push({
      timestamp: row.timestamp ?? '',
      class: last.includes(PARKING_PHRASE) ? 'parked-with-job-alive' : 'idle-with-job-alive',
      jobs: [...alive.entries()].map(([id, j]) => ({ id, startedAt: j.startedAt, command: j.command })),
      lastText: snip(last),
    });
  });
  return findings;
};

// The started-not-completed set at end of file: what --alive prints and what
// omp-tab-state.sh counts for its jobs= field.
export const aliveAtEnd = (rows) =>
  [...walkAlive(rows).entries()].map(([id, j]) => ({ id, startedAt: j.startedAt, command: j.command }));

export const auditFile = (filePath) => {
  const text = fs.readFileSync(filePath, 'utf8');
  const rows = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    rows.push(JSON.parse(line));
  }
  return auditRows(rows);
};

export const aliveAtEndOfFile = (filePath) => {
  const text = fs.readFileSync(filePath, 'utf8');
  const rows = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    rows.push(JSON.parse(line));
  }
  return aliveAtEnd(rows);
};

const ALIVE_SNIP = 80;

const formatAlive = (j) => `${j.id} ${j.startedAt} ${String(j.command ?? '').slice(0, ALIVE_SNIP)}`.trimEnd();

export const summarize = (findings) => ({
  findings: findings.length,
  idleWithJobAlive: findings.filter((f) => f.class === 'idle-with-job-alive').length,
  parkedWithJobAlive: findings.filter((f) => f.class === 'parked-with-job-alive').length,
});

const formatFinding = (f) => {
  const jobs = f.jobs.map((j) => `${j.id}@${j.startedAt}[${j.command}]`).join(' ');
  return `${f.timestamp} ${f.class} ${jobs} :: ${f.lastText.replace(/\r?\n/g, ' ')}`;
};

const formatText = (findings) => findings.map(formatFinding).join('\n');

const summaryText = (s) =>
  `${s.findings} findings (${s.idleWithJobAlive} idle-with-job-alive, ${s.parkedWithJobAlive} parked-with-job-alive)`;

const main = () => {
  const args = process.argv.slice(2);
  const files = args.filter((a) => !a.startsWith('--'));
  const format = args.includes('--format=json') ? 'json' : 'text';
  if (files.length === 0) {
    process.stderr.write(`usage: node ${path.basename(process.argv[1])} <session.jsonl>... [--format=json]\n`);
    process.exit(1);
  }
  if (args.includes('--alive')) {
    const results = files.map((file) => {
      let alive;
      try {
        alive = aliveAtEndOfFile(file);
      } catch (err) {
        process.stderr.write(`omp-idle-audit: cannot read ${file}: ${err.message}\n`);
        process.exit(1);
      }
      return { file, alive };
    });
    if (format === 'json') {
      const out = files.length === 1 ? results[0].alive : results;
      process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    } else if (files.length === 1) {
      if (results[0].alive.length > 0) {
        process.stdout.write(`${results[0].alive.map(formatAlive).join('\n')}\n`);
      }
    } else {
      const lines = [];
      for (const r of results) {
        const base = path.basename(r.file);
        for (const j of r.alive) lines.push(`${base}: ${formatAlive(j)}`);
      }
      if (lines.length > 0) process.stdout.write(`${lines.join('\n')}\n`);
    }
    return;
  }

  const results = files.map((file) => {
    let findings;
    try {
      findings = auditFile(file);
    } catch (err) {
      process.stderr.write(`omp-idle-audit: cannot read ${file}: ${err.message}\n`);
      process.exit(1);
    }
    return { file, findings, summary: summarize(findings) };
  });
  if (format === 'json') {
    const out = files.length === 1 ? results[0].findings : results;
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  } else if (files.length === 1) {
    if (results[0].findings.length > 0) {
      process.stdout.write(`${formatText(results[0].findings)}\n`);
    }
  } else {
    const lines = [];
    for (const r of results) {
      const base = path.basename(r.file);
      for (const f of r.findings) lines.push(`${base}: ${formatFinding(f)}`);
      lines.push(`${base}: ${summaryText(r.summary)}`);
    }
    const total = results.reduce((n, r) => n + r.summary.findings, 0);
    lines.push(`total: ${total} findings in ${results.length} files`);
    process.stdout.write(`${lines.join('\n')}\n`);
  }
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
