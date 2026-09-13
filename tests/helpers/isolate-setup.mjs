// node --import entry: scrub ambient switchboard/mailbox pins before any
// test file (and therefore any lib import) captures them. See isolate-env.mjs.
import { scrubProcessEnv } from './isolate-env.mjs';

scrubProcessEnv();
