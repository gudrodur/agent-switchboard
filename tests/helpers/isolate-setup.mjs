// node --import entry: scrub ambient switchboard/mailbox pins before any
// test file (and therefore any lib import) captures them. See isolate-env.mjs.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scrubProcessEnv } from './isolate-env.mjs';

scrubProcessEnv();

// Point the store's DEFAULT path at a fresh per-process temp dir: the default
// store path (lib/store.mjs defaultStorePath, via AGENT_SWITCHBOARD_DIR or
// XDG_STATE_HOME) otherwise lands in the real home, so a store-mode test with
// no pin of its own writes the live state.db. A test that sets its own pin
// later (in its body, which runs after these imports) still wins by overwrite.
const isolateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-isolate-'));
process.env.AGENT_SWITCHBOARD_DIR = path.join(isolateDir, 'switchboard');
process.env.XDG_STATE_HOME = path.join(isolateDir, 'xdg');
