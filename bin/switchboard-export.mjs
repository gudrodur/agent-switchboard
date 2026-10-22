#!/usr/bin/env node
// Read-only dump of one switchboard store table as JSON, so hand and agent
// inspection keeps working after the JSONL files stopped being the source.
//
// Usage: bin/switchboard-export.mjs <table>
//   mailbox  — every mailbox row (messages, acks, withdraws) in write order
//   presence — every presence beacon row as the hooks see it
//   meta     — store metadata (legacy import markers)
// Raw table names (mailbox_rows, presence_beacons) are accepted too.
// The database path comes from AGENT_SWITCHBOARD_DB (default
// $AGENT_SWITCHBOARD_DIR/state.db). Never writes to the store.
// Exit: 0 dumped, 2 usage error or no store at the path.

import fs from 'node:fs';
import { defaultStorePath, openStore } from '../lib/store.mjs';
import { presenceRowToBeacon } from '../lib/presence.mjs';

const arg = process.argv[2];
const TABLE =
  arg === 'mailbox' || arg === 'mailbox_rows'
    ? 'mailbox_rows'
    : arg === 'presence' || arg === 'presence_beacons'
      ? 'presence_beacons'
      : arg === 'meta'
        ? 'meta'
        : null;
if (!TABLE) {
  process.stderr.write('usage: switchboard-export.mjs <mailbox|presence|meta>\n');
  process.exit(2);
}

// A missing file is not an empty store: it means the path is wrong (a shell
// without the host's AGENT_SWITCHBOARD_DB pin reads the default path), and
// printing [] for it reads as "no rows" while the live store holds them.
const dbPath = defaultStorePath();
if (!fs.existsSync(dbPath)) {
  process.stderr.write(
    `switchboard-export: no store at ${dbPath} (set AGENT_SWITCHBOARD_DB to the store the hooks write)\n`,
  );
  process.exit(2);
}

const store = openStore(dbPath);
try {
  let rows;
  if (TABLE === 'mailbox_rows') {
    rows = store
      .all('SELECT recipient_key, row_json FROM mailbox_rows ORDER BY rowid')
      .map((r) => ({ recipient: r.recipient_key, ...JSON.parse(r.row_json) }));
  } else if (TABLE === 'presence_beacons') {
    rows = store.all('SELECT * FROM presence_beacons').map(presenceRowToBeacon);
  } else {
    rows = store.all('SELECT k, v FROM meta ORDER BY k');
  }
  process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
} finally {
  store.close();
}
