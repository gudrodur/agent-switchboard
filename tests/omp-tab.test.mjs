// Tests for omp-tab.sh: the readiness poll, the GROUND TRUTH refusal, and
// the --tools validation gate.
//
// omp-tab.sh launches a real kitty tab, so this file uses PATH stubs instead:
// `kitty` serves canned screens and records launch/send, `sleep` is a no-op so
// the 40-iteration poll costs nothing. No live windows. before() proves every
// stub is what the test PATH resolves to: a dropped stub otherwise falls
// through to the real binary on this machine, and nothing in the output says
// so.
//
// The stub models echo faithfully: send-text saves its payload and later
// get-text calls return the fixture screen plus that payload, which is what
// both kitty-send.sh's arrival proof and omp-tab.sh's started-working gate
// key on.
//
// Run: node --test scripts/omp-tab.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const SCRIPT = fileURLToPath(new URL('../bin/omp-tab.sh', import.meta.url));
const WID = '991001';

// Minimal new-TUI screen: banner box art (which shares the ╰ glyph) plus the
// empty input row as a bare ╰─ line. No ▶ anywhere.
const NEW_TUI = [
  '╭─── omp v18.1.14 ───╮',
  '│Muse Spark 1.3 Contributor│',
  '╰────────────────────╯',
  ' status: idle',
  '╰─',
  '',
].join('\n');

// Old renderer: a ▶ prompt glyph, no box art at all.
const OLD_TUI = ['omp v18.1.14', 'DeepSeek V4 Flash', '', '▶ ', ''].join('\n');

// Banner drawn but no input row yet: ╰ present, nothing ready.
const BANNER_ONLY = [
  '╭─── omp v18.1.14 ───╮',
  '│Muse Spark 1.3 Contributor│',
  '╰────────────────────╯',
  ' loading…',
  '',
].join('\n');

const WIZARD = ['Welcome to omp', 'Setup step 1 of 5', 'Select provider to login', ''].join('\n');

let binDir, stateDir, homeDir, linkDir;
const LINK_PTS = '7';
// Session rows the state script accepts for the stub window (which serves
// cwd /tmp/omptab-cwd and no created_at, so the age check is skipped): a
// session row, an optional FIRST model_change row naming the launch model,
// and an assistant stop tail (state=idle). omp-tab.sh closes the window when
// no model_change row proves the launch model, so every exit-0 test runs
// under a linked session; model=null leaves the model_change row out.
const writeLinkSession = async (dir, model) => {
  const now = new Date().toISOString();
  const sess = path.join(dir, 'tab.jsonl');
  const mc =
    model === null
      ? ''
      : `{"type":"model_change","id":"m1","parentId":null,"timestamp":"${now}","model":"${model}","resolvedModelIsFallback":false}\n`;
  await fs.writeFile(
    sess,
    `{"type":"session","version":3,"id":"01selftest","timestamp":"${now}","cwd":"/tmp/omptab-cwd"}\n` +
      mc +
      `{"type":"message","id":"a1","message":{"role":"assistant","content":[{"type":"text","text":"ok"}],"stopReason":"stop","timestamp":${Date.now()}}}\n`,
  );
  await fs.writeFile(path.join(dir, `pts-${LINK_PTS}`), `/tmp/omptab-cwd\n${sess}\n`);
  return sess;
};

// Every binary the script reaches that before() replaces with a stub, and the
// PATH that puts the stubs first. runScript and the before() check share it,
// so the check measures the PATH the script actually runs under.
const STUBS = ['kitty', 'sleep', 'omp', 'curl'];
const stubPath = () => `${binDir}:${process.env.PATH}`;

before(async () => {
  binDir = await fs.mkdtemp(path.join(os.tmpdir(), 'omptab-bin-'));
  stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'omptab-state-'));
  await fs.writeFile(path.join(stateDir, 'pid'), String(process.pid));
  const lsJson =
    '[{"tabs":[{"title":"mock","windows":[{"id":' + WID + ',"title":"idle","pid":PIDHERE,"cwd":"/tmp/omptab-cwd"}]}]}]';
  const stub = [
    '#!/usr/bin/env bash',
    `state=${JSON.stringify(stateDir)}`,
    'case "$1/$2" in',
    '  @/ls)',
    '    pid=$(cat "$state/pid")',
    "    printf '%s\\n' " + JSON.stringify(lsJson.replace('PIDHERE', '"$pid"')),
    '    ;;',
    '  @/launch)',
    '    touch "$state/launched"',
    '    printf \'%s\\n\' "$*" > "$state/launch-args"',
    `    printf '%s\\n' ${WID}`,
    '    ;;',
    '  @/send-text)',
    '    printf \'%s\\n\' "${@: -1}" > "$state/echo"',
    '    touch "$state/sent"',
    '    ;;',
    '  @/close-window)',
    '    printf \'%s\\n\' "$*" > "$state/close-args"',
    '    touch "$state/closed"',
    '    ;;',
    '  @/get-text)',
    '    cat "$state/screen" 2>/dev/null',
    '    [ -f "$state/sent" ] && cat "$state/echo"',
    '    ;;',
    'esac',
    'exit 0',
    '',
  ].join('\n');
  await fs.writeFile(path.join(binDir, 'kitty'), stub, { mode: 0o755 });
  await fs.writeFile(path.join(binDir, 'sleep'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
  // The preflight probe runs `omp -p` on the model before any
  // launch. This stub answers OK unless the model (or `default` for a bare
  // probe) is listed in $state/omp-fail, in which case it dies the way a
  // drained provider does: rc 1, the 402 line on stderr. A model listed in
  // $state/omp-hang sleeps past the probe timeout instead (via /bin/sleep,
  // bypassing the no-op sleep stub), so `timeout` kills it with rc 124.
  const ompStub = [
    '#!/usr/bin/env bash',
    `state=${JSON.stringify(stateDir)}`,
    'printf \'%s\\n\' "$*" >> "$state/omp-calls"',
    // The tools gate probes `omp -p --no-session --tools "$TOOLS"` before
    // any launch. Emulate omp 18.1.17: browser notebook python computer ask are
    // rejected even though `omp --help` still lists them; everything else passes.
    'tools=""',
    'm=default',
    'while [ $# -gt 0 ]; do case "$1" in --model) m="$2"; shift 2 ;; --tools) tools="$2"; shift 2 ;; *) shift ;; esac; done',
    'bad=$(printf \'%s\' "$tools" | tr "," "\\n" | grep -x -e browser -e notebook -e python -e computer -e ask | paste -sd,) ',
    'if [ -n "$bad" ]; then',
    '  printf \'%s\\n\' "CliUsageError: Unknown tool in --tools: $bad. Valid tools: read, grep, glob, bash, write, edit, lsp, task, todo, web_search." >&2; exit 1',
    'fi',
    'if [ -f "$state/omp-fail" ] && grep -qxF -- "$m" "$state/omp-fail"; then',
    '  printf \'%s\\n\' "Working..." "402 Insufficient Balance" >&2; exit 1',
    'fi',
    'if [ -f "$state/omp-hang" ] && grep -qxF -- "$m" "$state/omp-hang"; then',
    '  exec /bin/sleep 30',
    'fi',
    'printf \'OK\\n\'',
    '',
  ].join('\n');
  await fs.writeFile(path.join(binDir, 'omp'), ompStub, { mode: 0o755 });
  // The balance check curls DeepSeek; the stub serves $state/balance.json.
  await fs.writeFile(
    path.join(binDir, 'curl'),
    `#!/usr/bin/env bash\ncat ${JSON.stringify(path.join(stateDir, 'balance.json'))} 2>/dev/null\n`,
    { mode: 0o755 },
  );
  await fs.writeFile(path.join(stateDir, 'brief-gt.md'), '# Brief\n\n## GROUND TRUTH\n\n- Today is 2026-09-09.\n');
  await fs.writeFile(path.join(stateDir, 'brief-nogt.md'), '# Brief\n\n## Context\n\n- Do the thing.\n');
  // The config root is a temp dir, not $HOME. The script reads its account
  // default from $HOME (overridable via OMP_TAB_CONFIG) — with the real HOME
  // this file passes on the developer machine and dies on every CI runner.
  homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'omptab-home-'));
  // Optional key step: a stub command whose stdout is `export...` lines,
  // passed as KEY_COMMAND. Unset means no key step at all.
  await fs.writeFile(
    path.join(binDir, 'key-command'),
    '#!/usr/bin/env bash\n# Stub: eval\'d before the preflight; the balance check reads the key it exports.\nprintf \'%s\\n\' "export DEEPSEEK_API_KEY=stub"\n',
    { mode: 0o755 },
  );
  await fs.mkdir(path.join(homeDir, '.omp', 'agent'), { recursive: true });
  await fs.writeFile(
    path.join(homeDir, '.omp', 'agent', 'config.yml'),
    'modelRoles:\n  smol: opencode-go/muse-spark-1.3-contributor\n  default: opencode-go/muse-spark-1.3-contributor:high\n',
  );
  // The session link every exit-0 test runs under: without it the model
  // proof closes the window, which is the point of the model-check tests and
  // noise everywhere else. Lives under stateDir so after() removes it.
  linkDir = await fs.mkdtemp(path.join(stateDir, 'link-'));
  await writeLinkSession(linkDir, 'opencode-go/muse-spark-1.3-contributor');
  // The stubs are the harness: if one is missing, PATH falls through to the
  // real binary (~/.local/bin/omp and kitty on the developer machine) and the
  // suite runs it with no visible difference. Refuse here, before any test.
  for (const name of STUBS) {
    const got = await run('bash', ['-c', `command -v ${name}`], { env: { ...process.env, PATH: stubPath() } })
      .then((r) => r.stdout.trim())
      .catch(() => '');
    assert.equal(
      got,
      path.join(binDir, name),
      `${name} resolves to ${got || 'nothing'}, not the stub in ${binDir}: the suite would run the real binary`,
    );
  }
});

after(async () => {
  await fs.rm(binDir, { recursive: true, force: true }).catch(() => {});
  await fs.rm(stateDir, { recursive: true, force: true }).catch(() => {});
  await fs.rm(homeDir, { recursive: true, force: true }).catch(() => {});
});
const reset = async (screen) => {
  for (const f of ['sent', 'echo', 'launched', 'launch-args', 'omp-fail', 'omp-hang', 'omp-calls', 'balance.json', 'closed', 'close-args'])
    await fs.rm(path.join(stateDir, f), { force: true });
  await fs.writeFile(path.join(stateDir, 'screen'), screen);
  // A test that appended rows to the shared link leaves it dirty for the
  // next; rewrite the idle default every reset.
  if (linkDir) await writeLinkSession(linkDir, 'opencode-go/muse-spark-1.3-contributor');
};
const launched = async () =>
  await fs
    .access(path.join(stateDir, 'launched'))
    .then(() => true)
    .catch(() => false);
const runScript = async (args, extraEnv = {}) => {
  try {
    const r = await run(SCRIPT, args, {
      env: {
        ...process.env,
        PATH: stubPath(),
        XDG_RUNTIME_DIR: stateDir,
        HOME: homeDir,
        // Every launch runs under the shared linked session (the model proof
        // needs it); a test with its own link or timeout overrides these.
        // The short send timeout bounds kitty-send's session-row wait: the
        // started-working gate below it still confirms, so exit 0 is intact.
        KITTY_SEND_TIMEOUT: '3',
        OMP_TAB_STATE_DIR: linkDir,
        OMP_TAB_STATE_PTS_N: LINK_PTS,
        KEY_COMMAND: path.join(binDir, 'key-command'),
        ...extraEnv,
      },
      timeout: 60_000,
    });
    return { code: 0, out: r.stdout, err: r.stderr };
  } catch (e) {
    return { code: e.code ?? 1, out: e.stdout ?? '', err: e.stderr ?? '' };
  }
};

const baseArgs = (brief) => ['--title', 'omp: t7 test', '--brief', path.join(stateDir, brief), '--cwd', '/tmp'];

// The harness controls HOME: a future test must not silently depend on the
// developer's machine again. Fails on the one laptop it would pass on if the
// override below ever stops being passed through.
test('the harness HOME is a temp dir, not the developer machine home', async () => {
  assert.notEqual(homeDir, os.homedir());
  const st = await fs.stat(path.join(binDir, 'key-command'));
  assert.ok(st.mode & 0o111, 'the stub key command must be executable');
});

// ---- --help answers from the header, launching nothing ----

test('--help prints usage and exits 0 without launching', async () => {
  await reset(NEW_TUI);
  for (const flag of ['--help', '-h']) {
    const r = await runScript([flag]);
    assert.equal(r.code, 0, `${r.out}${r.err}`);
    assert.match(r.out, /--brief/, `${flag} must print the Usage block`);
    assert.match(r.out, /Exit codes/, `${flag} must print the exit-code table`);
    assert.equal(await launched(), false, `${flag} must launch nothing`);
  }
});

// ---- no GROUND TRUTH means no launch ----

test('a brief without GROUND TRUTH refuses and launches nothing', async () => {
  await reset(NEW_TUI);
  const r = await runScript(baseArgs('brief-nogt.md'));
  assert.equal(r.code, 1, `${r.out}${r.err}`);
  assert.match(r.err, /--no-ground-truth/);
  assert.equal(await launched(), false);
});

test('--no-ground-truth overrides the refusal deliberately', async () => {
  await reset(NEW_TUI);
  const r = await runScript([...baseArgs('brief-nogt.md'), '--no-ground-truth']);
  assert.equal(r.code, 0, `${r.out}${r.err}`);
  assert.match(r.err, /--no-ground-truth/);
  assert.match(r.err, /confirmed running/);
  assert.equal(await launched(), true);
});

test('a brief with GROUND TRUTH still launches', async () => {
  await reset(NEW_TUI);
  const r = await runScript(baseArgs('brief-gt.md'));
  assert.equal(r.code, 0, `${r.out}${r.err}`);
  assert.match(r.err, /confirmed running/);
  assert.equal(await launched(), true);
});

// ---- --tools is validated headless before any window opens ----
//
// The 2026-09-11 launch passed `--tools …,browser`, the window died in
// seconds, and the script blamed the key step (rc 0 by hand) because the real
// error — `CliUsageError: Unknown tool in --tools: browser` — only appears
// headless. Now a bad --tools refuses with omp's own message and launches
// nothing.

test('valid --tools pass the gate and launch', async () => {
  await reset(NEW_TUI);
  const r = await runScript([...baseArgs('brief-gt.md'), '--tools', 'read,grep,glob,lsp,bash,web_search']);
  assert.equal(r.code, 0, `${r.out}${r.err}`);
  assert.match(r.err, /confirmed running/);
  assert.equal(await launched(), true);
  assert.match(await ompCalls(), /--tools read,grep,glob,lsp,bash,web_search/);
});

test('an unknown --tools name refuses with omp message and launches nothing', async () => {
  await reset(NEW_TUI);
  const r = await runScript([...baseArgs('brief-gt.md'), '--tools', 'read,grep,glob,bash,write,edit,browser']);
  assert.equal(r.code, 1, `${r.out}${r.err}`);
  assert.match(r.err, /Unknown tool in --tools: browser/);
  assert.match(r.err, /Nothing launched/);
  assert.doesNotMatch(r.err, /KEY_COMMAND failed/);
  assert.equal(await launched(), false);
});
test('omitting --tools skips the gate and launches', async () => {
  await reset(NEW_TUI);
  const r = await runScript(baseArgs('brief-gt.md'));
  assert.equal(r.code, 0, `${r.out}${r.err}`);
  assert.equal(await launched(), true);
  // The only headless omp call is the provider preflight's `--tools read`
  // probe: the gate adds no second probe when --tools is omitted.
  assert.equal(await ompCalls(), '-p --no-session --tools read\n');
});

// ---- a non-empty existing --out refuses without --overwrite ----
//
// The 2026-09-10 12:01 UTC incident: a tab reused the morning tab's --out path,
// the monitor fired on the OLD report, and the new tab later overwrote it. An
// existing EMPTY file stays allowed (a monitor may pre-touch it).

test('a non-empty existing --out refuses without --overwrite and launches nothing', async () => {
  await reset(NEW_TUI);
  const out = path.join(stateDir, 'out-existing.md');
  await fs.writeFile(out, '# Old report\n');
  const r = await runScript([...baseArgs('brief-gt.md'), '--out', out]);
  assert.equal(r.code, 1, `${r.out}${r.err}`);
  assert.match(r.err, /already exists/);
  assert.match(r.err, /--overwrite/);
  assert.match(r.err, new RegExp(out.replace(/[./]/g, '\\$&')), 'the refusal names the file');
  assert.equal(await launched(), false);
  assert.equal(await ompCalls(), '', 'the refusal runs before the provider probe');
});

test('the same non-empty --out launches with --overwrite', async () => {
  await reset(NEW_TUI);
  const out = path.join(stateDir, 'out-existing.md');
  await fs.writeFile(out, '# Old report\n');
  const r = await runScript([...baseArgs('brief-gt.md'), '--out', out, '--overwrite']);
  assert.equal(r.code, 0, `${r.out}${r.err}`);
  assert.match(r.err, /confirmed running/);
  assert.equal(await launched(), true);
});

// ---- the poll fires on both renderers ----

test('the new TUI input row (bare ╰─ line, no ▶) counts as ready', async () => {
  assert.equal(NEW_TUI.includes('▶'), false, 'fixture must carry no ▶ or it proves nothing');
  await reset(NEW_TUI);
  const r = await runScript(baseArgs('brief-gt.md'));
  assert.equal(r.code, 0, `${r.out}${r.err}`);
  assert.doesNotMatch(r.err, /prompt never appeared/);
  assert.match(r.err, /confirmed running/);
});

test('the old ▶ prompt glyph still counts as ready', async () => {
  await reset(OLD_TUI);
  const r = await runScript(baseArgs('brief-gt.md'));
  assert.equal(r.code, 0, `${r.out}${r.err}`);
  assert.doesNotMatch(r.err, /prompt never appeared/);
  assert.match(r.err, /confirmed running/);
});

test('banner box art alone (╰ present, no input row) does NOT count as ready', async () => {
  // Locks the line anchor: a bare-substring ╰ match would fire on the banner
  // border and skip this warning.
  await reset(BANNER_ONLY);
  const r = await runScript(baseArgs('brief-gt.md'));
  assert.equal(r.code, 0, `${r.out}${r.err}`);
  assert.match(r.err, /prompt never appeared/);
});

// ---- the wizard veto still comes first ----

test('a setup wizard screen exits 3 with nothing sent', async () => {
  await reset(WIZARD);
  const r = await runScript(baseArgs('brief-gt.md'));
  assert.equal(r.code, 3, `${r.out}${r.err}`);
  assert.match(r.err, /SETUP WIZARD/);
  assert.equal(
    await fs
      .access(path.join(stateDir, 'sent'))
      .then(() => true)
      .catch(() => false),
    false,
  );
});

// ---- --list is per-session, and prunes gone ----
//
// The state file is per-uid, so without attribution every row reads as "what
// THIS script launched" while belonging to any session on the machine — the
// 19:1x listing showed 8 dead rows plus 2 live tabs of the other session.
// --list now prints the launching session per live row and prunes gone rows
// (an id absent from kitty can never be acted on; --close already just deletes
// such a row). --close's refusal of strangers is unchanged and untested here.

const stateFile = () => path.join(stateDir, `omp-tab-launched.${process.getuid()}`);

test('--list shows which session launched each live row and prunes gone rows', async () => {
  const pid = (await fs.readFile(path.join(stateDir, 'pid'), 'utf8')).trim();
  await fs.writeFile(stateFile(), `${WID} ${pid} @sess-A omp: live work\n424242 99999 @sess-B omp: gone work\n`);
  // No session file links this window: the state column says unknown, never
  // another tab's state. The empty dir keeps it deterministic (no pty link).
  const empty = await fs.mkdtemp(path.join(os.tmpdir(), 'omptab-emptysess-'));
  try {
    const r = await runScript(['--list'], { OMP_TAB_STATE_DIR: empty });
    assert.equal(r.code, 0, `${r.out}${r.err}`);
    assert.match(r.out, new RegExp(`${WID}\\s+live\\s+sess-A\\s+state=unknown tool=- age=-\\s+omp: live work`));
    assert.doesNotMatch(r.out, /424242/, 'the gone row is listed nowhere');
    assert.match(r.err, /pruned 1 gone row/);
    const kept = await fs.readFile(stateFile(), 'utf8');
    assert.match(kept, new RegExp(`^${WID} ${pid} @sess-A omp: live work`, 'm'));
    assert.doesNotMatch(kept, /424242/, 'the gone row is deleted from the state file');
  } finally {
    await fs.rm(empty, { recursive: true, force: true });
  }
});

test('--list reads a pre-launcher row as unknown and keeps its full title', async () => {
  const pid = (await fs.readFile(path.join(stateDir, 'pid'), 'utf8')).trim();
  await fs.writeFile(stateFile(), `${WID} ${pid} omp: legacy title words here\n`);
  const empty = await fs.mkdtemp(path.join(os.tmpdir(), 'omptab-emptysess-'));
  try {
    const r = await runScript(['--list'], { OMP_TAB_STATE_DIR: empty });
    assert.equal(r.code, 0, `${r.out}${r.err}`);
    assert.match(r.out, new RegExp(`${WID}\\s+live\\s+unknown\\s+state=unknown tool=- age=-\\s+omp: legacy title words here`));
  } finally {
    await fs.rm(empty, { recursive: true, force: true });
  }
});

test('--list appends the linked tab state to each row', async () => {
  const pid = (await fs.readFile(path.join(stateDir, 'pid'), 'utf8')).trim();
  await fs.writeFile(stateFile(), `${WID} ${pid} @sess-A omp: live work\n`);
  // The seams make the state deterministic: OMP_TAB_STATE_DIR points at a
  // dir whose kitty-<id> file links this window to an idle fixture with a
  // matching cwd (the stub serves /tmp/omptab-cwd, no created_at).
  const sess = await fs.mkdtemp(path.join(os.tmpdir(), 'omptab-linksess-'));
  try {
    const fp = path.join(sess, 'tab.jsonl');
    const t = Date.now();
    await fs.writeFile(fp, [
      JSON.stringify({ type: 'session', version: 3, id: '01t', timestamp: new Date().toISOString(), cwd: '/tmp/omptab-cwd' }),
      JSON.stringify({ type: 'message', id: 'a1', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }], stopReason: 'stop', timestamp: t - 1000 } }),
    ].join('\n') + '\n');
    await fs.writeFile(path.join(sess, `kitty-${WID}`), `/tmp/omptab-cwd\n${fp}\n`);
    const r = await runScript(['--list'], { OMP_TAB_STATE_DIR: sess });
    assert.equal(r.code, 0, `${r.out}${r.err}`);
    assert.match(r.out, new RegExp(`${WID}\\s+live\\s+sess-A\\s+state=idle tool=- age=\\d+s\\s+omp: live work`));
  } finally {
    await fs.rm(sess, { recursive: true, force: true });
  }
});

test('--launch records the kitty window it ran in', async () => {
  await reset(NEW_TUI);
  await runScript(baseArgs('brief-gt.md'), { KITTY_WINDOW_ID: '4242', CLAUDE_SESSION_ID: '' });
  const rows = (await fs.readFile(stateFile(), 'utf8')).trim().split('\n').filter((l) => l.includes(' @4242 '));
  assert.equal(rows.length, 1, 'exactly the row this launch appended');
  assert.match(rows[0], new RegExp(`^${WID} \\d+ @4242 omp: t7 test$`));
});

test('--launch prefers CLAUDE_SESSION_ID when the environment carries one', async () => {
  await reset(NEW_TUI);
  await runScript(baseArgs('brief-gt.md'), { KITTY_WINDOW_ID: '4242', CLAUDE_SESSION_ID: 'sess-xyz' });
  const rows = (await fs.readFile(stateFile(), 'utf8')).trim().split('\n').filter((l) => l.includes(' @sess-xyz '));
  assert.equal(rows.length, 1, 'exactly the row this launch appended');
  assert.match(rows[0], new RegExp(`^${WID} \\d+ @sess-xyz omp: t7 test$`));
});

// ---- preflight every provider, fall back, name provider/model ----
//
// The launcher pinned a provider that ran out (-$0.03, every tab 402), then
// inherited a default it could not check. Now the provider a launch resolves to
// is proved usable first — by the check omp-providers.json names for it — and
// the default walks that file's fallback list when it cannot serve.

const PROVIDERS = fileURLToPath(new URL('../config/omp-providers.json', import.meta.url));
const failModels = async (...ms) => fs.writeFile(path.join(stateDir, 'omp-fail'), ms.join('\n') + '\n');
const launchArgs = async () => fs.readFile(path.join(stateDir, 'launch-args'), 'utf8').catch(() => '');
const ompCalls = async () => fs.readFile(path.join(stateDir, 'omp-calls'), 'utf8').catch(() => '');
// The post-launch check compares the status bar to --model, so a tab pinned to
// Flash must show Flash or the script (correctly) exits 3.
const NEW_TUI_FLASH = NEW_TUI.replace('Muse Spark 1.3 Contributor', 'DeepSeek V4 Flash');

test('the provider table parses and every fallback entry names an enabled provider', async () => {
  const t = JSON.parse(await fs.readFile(PROVIDERS, 'utf8'));
  assert.ok(Array.isArray(t.fallback) && t.fallback.length > 0, 'a fallback list is the whole point');
  for (const m of t.fallback) {
    const [prov] = m.split('/');
    assert.ok(m.includes('/'), `${m} must be provider/model — the provider is part of the identity`);
    assert.ok(t.providers[prov], `${prov} must have a row so its check is known`);
    assert.notEqual(t.providers[prov].enabled, false, `${prov} is switched off but listed as a fallback`);
    assert.ok(['probe', 'balance'].includes(t.providers[prov].check), `${prov}: unknown check`);
  }
});

test('a usable default is probed once and the status line names provider/model', async () => {
  await reset(NEW_TUI);
  const r = await runScript(baseArgs('brief-gt.md'));
  assert.equal(r.code, 0, `${r.out}${r.err}`);
  assert.match(r.err, /preflight: default opencode-go\/muse-spark-1\.3-contributor can serve/);
  assert.match(r.err, /launched as opencode-go\/muse-spark-1\.3-contributor/);
  assert.doesNotMatch(await launchArgs(), /--model/, 'a usable default is inherited, never pinned');
  assert.equal((await ompCalls()).trim().split('\n').length, 1, 'one probe, no more');
});

test('an explicit --model that cannot serve is refused with the reason, and nothing is launched', async () => {
  await reset(NEW_TUI);
  await failModels('opencode-go/glm-5.3');
  const r = await runScript([...baseArgs('brief-gt.md'), '--model', 'opencode-go/glm-5.3']);
  assert.equal(r.code, 1, `${r.out}${r.err}`);
  assert.match(r.err, /--model opencode-go\/glm-5\.3 cannot serve/);
  assert.match(r.err, /402 Insufficient Balance/, 'the reason is the provider\'s own line');
  assert.match(r.err, /--fallback/, 'the refusal names the way out');
  assert.equal(await launched(), false);
});

test('--fallback takes the next usable entry for an explicit --model and says so', async () => {
  await reset(NEW_TUI_FLASH);
  await failModels('opencode-go/glm-5.3', 'opencode-go/muse-spark-1.3-contributor');
  // A private providers table keeps the walk (not the shipped table) under test.
  const prov = await flashProviders();
  const st = await mkSessionEnv('opencode-go/deepseek-v4-flash');
  const r = await runScript([...baseArgs('brief-gt.md'), '--model', 'opencode-go/glm-5.3', '--fallback'], {
    OMP_TAB_PROVIDERS: prov,
    ...st.env,
  });
  assert.equal(r.code, 0, `${r.out}${r.err}`);
  assert.match(r.err, /FALLBACK: opencode-go\/glm-5\.3 cannot serve .* launching on opencode-go\/deepseek-v4-flash/);
  assert.match(await launchArgs(), /--model opencode-go\/deepseek-v4-flash/, 'the tab is pinned to what was proved');
  assert.match(r.err, /launched as opencode-go\/deepseek-v4-flash/);
});

test('a default that cannot serve falls back without a flag', async () => {
  await reset(NEW_TUI_FLASH);
  // `default` is the bare probe; the first fallback entry IS the default and is
  // skipped by name, so the walk must land on the second.
  await failModels('default', 'opencode-go/muse-spark-1.3-contributor');
  // A private providers table keeps the walk (not the shipped table) under test.
  const prov = await flashProviders();
  const st = await mkSessionEnv('opencode-go/deepseek-v4-flash');
  const r = await runScript(baseArgs('brief-gt.md'), { OMP_TAB_PROVIDERS: prov, ...st.env });
  assert.equal(r.code, 0, `${r.out}${r.err}`);
  assert.match(r.err, /FALLBACK: opencode-go\/muse-spark-1\.3-contributor cannot serve/);
  assert.match(await launchArgs(), /--model opencode-go\/deepseek-v4-flash/);
  assert.doesNotMatch(await ompCalls(), /--model opencode-go\/muse-spark-1\.3-contributor/, 'the failed default is not probed twice');
});

// No OMP_TAB_PROVIDERS: this runs against the shipped config/omp-providers.json.
test('the shipped example table lets the fallback walk launch on Flash', async () => {
  await reset(NEW_TUI_FLASH);
  // `default` is the bare probe; the first fallback entry IS the default and is
  // skipped by name, so the walk must land on the second.
  await failModels('default', 'opencode-go/muse-spark-1.3-contributor');
  const st = await mkSessionEnv('opencode-go/deepseek-v4-flash');
  const r = await runScript(baseArgs('brief-gt.md'), { ...st.env });
  assert.equal(r.code, 0, `${r.out}${r.err}`);
  assert.match(r.err, /FALLBACK: opencode-go\/muse-spark-1\.3-contributor cannot serve/);
  assert.match(await launchArgs(), /--model opencode-go\/deepseek-v4-flash/);
  assert.doesNotMatch(await ompCalls(), /--model opencode-go\/muse-spark-1\.3-contributor/, 'the failed default is not probed twice');
});

test('when nothing in the table can serve, exit 1 lists every reason and launches nothing', async () => {
  await reset(NEW_TUI);
  const t = JSON.parse(await fs.readFile(PROVIDERS, 'utf8'));
  await fs.writeFile(path.join(stateDir, 'balance.json'), '{"is_available":false,"balance_infos":[{"total_balance":"-0.03"}]}');
  await failModels('default', ...t.fallback);
  const r = await runScript(baseArgs('brief-gt.md'));
  assert.equal(r.code, 1, `${r.out}${r.err}`);
  assert.match(r.err, /no provider can serve/);
  for (const m of t.fallback.filter((m) => !m.startsWith('deepseek/'))) assert.match(r.err, new RegExp(m.replace(/[./]/g, '\\$&')));
  assert.match(r.err, /-0\.03/, 'the deepseek row reports its balance, not a probe');
  assert.equal(await launched(), false);
});

test('a switched-off provider is refused before any check runs', async () => {
  await reset(NEW_TUI);
  const off = path.join(stateDir, 'providers-off.json');
  await fs.writeFile(off, JSON.stringify({
    providers: { deepseek: { enabled: false, check: 'balance' }, 'opencode-go': { enabled: true, check: 'probe' } },
    fallback: ['deepseek/deepseek-v4-flash', 'opencode-go/deepseek-v4-flash'],
  }));
  const r = await runScript([...baseArgs('brief-gt.md'), '--model', 'deepseek/deepseek-v4-flash'], { OMP_TAB_PROVIDERS: off });
  assert.equal(r.code, 1, `${r.out}${r.err}`);
  assert.match(r.err, /provider deepseek is switched off/);
  assert.equal(await ompCalls(), '', 'no probe for a provider that is off');
  assert.equal(await launched(), false);
  // And the walk skips it: a default that fails must land on opencode-go, not on the off row.
  await reset(NEW_TUI_FLASH);
  await failModels('default');
  // providers-off.json carries no allowlist, so the gate passes; the session
  // proof still needs the model the walk lands on.
  const st = await mkSessionEnv('opencode-go/deepseek-v4-flash');
  const r2 = await runScript(baseArgs('brief-gt.md'), { OMP_TAB_PROVIDERS: off, ...st.env });
  assert.equal(r2.code, 0, `${r2.out}${r2.err}`);
  assert.match(await launchArgs(), /--model opencode-go\/deepseek-v4-flash/);
});

test('the balance check refuses a drained deepseek/* with the figure and the top-up link', async () => {
  await reset(NEW_TUI);
  await fs.writeFile(path.join(stateDir, 'balance.json'), '{"is_available":false,"balance_infos":[{"currency":"USD","total_balance":"-0.03"}]}');
  const r = await runScript([...baseArgs('brief-gt.md'), '--model', 'deepseek/deepseek-v4-flash']);
  assert.equal(r.code, 1, `${r.out}${r.err}`);
  assert.match(r.err, /balance -0\.03/);
  assert.match(r.err, /platform\.deepseek\.com\/top_up/);
  assert.equal(await ompCalls(), '', 'balance is the check for deepseek, not a probe');
  assert.equal(await launched(), false);
  // A solvent balance passes without a probe either.
  await reset(NEW_TUI_FLASH);
  await fs.writeFile(path.join(stateDir, 'balance.json'), '{"is_available":true,"balance_infos":[{"currency":"USD","total_balance":"4.20"}]}');
  // A private providers table keeps the balance pass (not the shipped table)
  // under test.
  const bprov = await flashProviders();
  const bst = await mkSessionEnv('deepseek/deepseek-v4-flash');
  const r2 = await runScript([...baseArgs('brief-gt.md'), '--model', 'deepseek/deepseek-v4-flash'], {
    OMP_TAB_PROVIDERS: bprov,
    ...bst.env,
  });
  assert.equal(r2.code, 0, `${r2.out}${r2.err}`);
  assert.match(r2.err, /preflight: deepseek\/deepseek-v4-flash can serve/);
  assert.match(await launchArgs(), /--model deepseek\/deepseek-v4-flash/);
});

// ---- probe hang: the environment hung, not the provider, so refuse ----
//
// A probe killed by `timeout` (rc 124) is MCP discovery wedging the headless
// run, not a drained provider (2 of 3 headless runs wedged on 2026-08-22).
// Falling back on a hang would launch the WRONG provider for an environmental
// reason, so a hang dies with exit 1 and launches nothing, even with
// --fallback and even when fallback entries could serve.
const hangModels = async (...ms) => fs.writeFile(path.join(stateDir, 'omp-hang'), ms.join('\n') + '\n');

test('a hung probe of an explicit --model refuses even with --fallback', async () => {
  await reset(NEW_TUI_FLASH);
  await hangModels('opencode-go/glm-5.3');
  const r = await runScript([...baseArgs('brief-gt.md'), '--model', 'opencode-go/glm-5.3', '--fallback'], { OMP_TAB_PROBE_TIMEOUT: '1' });
  assert.equal(r.code, 1, `${r.out}${r.err}`);
  assert.match(r.err, /hung for 1 s; nothing launched/);
  assert.doesNotMatch(r.err, /FALLBACK/, 'a hang never walks the fallback list');
  assert.equal(await launched(), false);
});

test('a hung default probe refuses without launching a fallback entry', async () => {
  await reset(NEW_TUI);
  // `default` is the bare probe; the fallback list still names usable entries,
  // and none of them may be tried: the hang says nothing about any provider.
  await hangModels('default');
  const r = await runScript(baseArgs('brief-gt.md'), { OMP_TAB_PROBE_TIMEOUT: '1' });
  assert.equal(r.code, 1, `${r.out}${r.err}`);
  assert.match(r.err, /hung for 1 s; nothing launched/);
  assert.doesNotMatch(r.err, /FALLBACK/, 'a hang never walks the fallback list');
  assert.equal(await launched(), false);
});

// ---- a bare launch with no readable default refuses ----
//
// The live config lost modelRoles.default and the script still exited 0 on a
// model it could not name ("model: <status bar names no model> — launched as
// <unreadable default>") while the tab ran 67 s on subscription OAuth Opus.
// A bare launch with no default now launches nothing; an explicit --model
// still works, because the contract is stated rather than inherited.
const GOOD_CONFIG =
  'modelRoles:\n  smol: opencode-go/muse-spark-1.3-contributor\n  default: opencode-go/muse-spark-1.3-contributor:high\n';
const configFile = () => path.join(homeDir, '.omp', 'agent', 'config.yml');

test('a bare launch with an emptied default refuses and launches nothing', async () => {
  await reset(NEW_TUI);
  await fs.writeFile(configFile(), 'modelRoles:\n  default:\n');
  try {
    const r = await runScript(baseArgs('brief-gt.md'));
    assert.equal(r.code, 1, `${r.out}${r.err}`);
    assert.match(r.err, /no modelRoles\.default/);
    assert.match(r.err, /--model provider\/model/);
    assert.equal(await launched(), false);
  } finally {
    await fs.writeFile(configFile(), GOOD_CONFIG);
  }
});

test('a quoted-empty default (`default: ""`) refuses the same way', async () => {
  await reset(NEW_TUI);
  await fs.writeFile(configFile(), 'modelRoles:\n  default: ""\n');
  try {
    const r = await runScript(baseArgs('brief-gt.md'));
    assert.equal(r.code, 1, `${r.out}${r.err}`);
    assert.match(r.err, /no modelRoles\.default/);
    assert.equal(await launched(), false);
  } finally {
    await fs.writeFile(configFile(), GOOD_CONFIG);
  }
});

test('a missing default line refuses the same way', async () => {
  await reset(NEW_TUI);
  await fs.writeFile(configFile(), 'modelRoles:\n  smol: opencode-go/muse-spark-1.3-contributor\n');
  try {
    const r = await runScript(baseArgs('brief-gt.md'));
    assert.equal(r.code, 1, `${r.out}${r.err}`);
    assert.match(r.err, /no modelRoles\.default/);
    assert.equal(await launched(), false);
  } finally {
    await fs.writeFile(configFile(), GOOD_CONFIG);
  }
});

test('an explicit --model still launches when the default is emptied', async () => {
  await reset(NEW_TUI_FLASH);
  await fs.writeFile(configFile(), 'modelRoles:\n  default:\n');
  try {
    // A private providers table keeps the emptied-default path (not the
    // shipped table) under test.
    const eprov = await flashProviders();
    const est = await mkSessionEnv('opencode-go/deepseek-v4-flash');
    const r = await runScript([...baseArgs('brief-gt.md'), '--model', 'opencode-go/deepseek-v4-flash'], {
      OMP_TAB_PROVIDERS: eprov,
      ...est.env,
    });
    assert.equal(r.code, 0, `${r.out}${r.err}`);
    assert.equal(await launched(), true);
  } finally {
    await fs.writeFile(configFile(), GOOD_CONFIG);
  }
});

// ---- lean MCP by default, full on request ----
//
// Every omp startup spawns one process per discovered MCP server (measured
// 2026-09-12: 13 descendants holding ~310 MB on a live tab), so the launch
// carries a `--config` overlay disabling third-party MCP discovery unless
// the caller passes --mcp full. The overlay is per-launch: the live
// config.yml is untouched.
const LEAN_YML = fileURLToPath(new URL('../config/omp-tab-lean.yml', import.meta.url));

test('a default launch carries the lean MCP overlay and --help names --mcp full', async () => {
  await reset(NEW_TUI);
  const r = await runScript(baseArgs('brief-gt.md'));
  assert.equal(r.code, 0, `${r.out}${r.err}`);
  assert.match(await launchArgs(), /--config \S*omp-tab-lean\.yml/, 'the tab starts with MCP discovery disabled');
  const help = await runScript(['--help']);
  assert.match(help.out, /--mcp full/, 'usage names the opt-out');
});

test('--mcp full launches without the overlay', async () => {
  await reset(NEW_TUI);
  const r = await runScript([...baseArgs('brief-gt.md'), '--mcp', 'full']);
  assert.equal(r.code, 0, `${r.out}${r.err}`);
  assert.match(r.err, /confirmed running/);
  assert.equal(await launched(), true);
  assert.doesNotMatch(await launchArgs(), /--config/, 'full discovery carries no overlay');
});

test('an unknown --mcp value refuses and launches nothing', async () => {
  await reset(NEW_TUI);
  const r = await runScript([...baseArgs('brief-gt.md'), '--mcp', 'lean']);
  assert.equal(r.code, 1, `${r.out}${r.err}`);
  assert.match(r.err, /--mcp takes one value: full/);
  assert.equal(await launched(), false);
});

test('OMP_TAB_LEAN_YML overrides the checkout overlay on a default launch', async () => {
  await reset(NEW_TUI);
  const custom = path.join(stateDir, 'custom-lean.yml');
  await fs.writeFile(custom, 'disabledProviders: []\n');
  const r = await runScript(baseArgs('brief-gt.md'), { OMP_TAB_LEAN_YML: custom });
  assert.equal(r.code, 0, `${r.out}${r.err}`);
  assert.match(await launchArgs(), new RegExp(`--config ${custom.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`), 'the setting wins over the checkout default');
});

test('the lean overlay disables project config and the third-party providers', async () => {
  const yml = await fs.readFile(LEAN_YML, 'utf8');
  assert.match(yml, /^mcp:\n  enableProjectConfig: false$/m, 'project-root mcp.json files are excluded');
  for (const p of ['claude', 'codex', 'gemini', 'opencode', 'cursor', 'windsurf', 'marketplace', 'vscode'])
    assert.match(yml, new RegExp(`^  - ${p}$`, 'm'), `provider ${p} is denied`);
  assert.doesNotMatch(yml, /^\w+\.\w+:/m, 'no dotted overlay key remains (silently ignored)');
  assert.match(yml, /^# skills:\n#   customDirectories:\n#     - \S+$/m, 'the skills stanza ships as a commented example, never a personal path');
});

// ---- The allowlist and the session-file model proof ----
//
// On 2026-09-13 a tab launched "as anthropic/claude-opus-5" (modelRoles.default
// read Opus at launch) and ran 5 assistant turns on it before anyone noticed,
// although an earlier change was believed to check the session file already.
// Now the providers table carries allowedModels, a resolved model outside it
// is refused before launch, and after the prompt the FIRST model_change row
// must name the launched model or the window is closed with exit 3.
const allowProviders = async (list) => {
  const p = path.join(stateDir, `providers-${Date.now()}-${Math.floor(Math.random() * 1e6)}.json`);
  await fs.writeFile(p, JSON.stringify({ providers: {}, fallback: [], allowedModels: list }));
  return p;
};
// A providers table for the fallback tests that land on Flash: same checks
// as the real table, but the allowlist permits every fallback entry, so the
// walk (not the gate) is what is under test.
const flashProviders = async () => {
  const p = path.join(stateDir, `providers-flash-${Date.now()}-${Math.floor(Math.random() * 1e6)}.json`);
  await fs.writeFile(
    p,
    JSON.stringify({
      providers: {
        'opencode-go': { enabled: true, check: 'probe' },
        deepseek: {
          enabled: true,
          check: 'balance',
          balanceUrl: 'https://api.deepseek.com/user/balance',
          topUp: 'https://platform.deepseek.com/top_up',
        },
      },
      fallback: [
        'opencode-go/muse-spark-1.3-contributor',
        'opencode-go/deepseek-v4-flash',
        'deepseek/deepseek-v4-flash',
      ],
      allowedModels: [
        'opencode-go/muse-spark-1.3-contributor',
        'opencode-go/deepseek-v4-flash',
        'deepseek/deepseek-v4-flash',
      ],
    }),
  );
  return p;
};
// A private linked session for one test (the shared linkDir serves the rest).
// model=null omits the model_change row.
const mkSessionEnv = async (model) => {
  const dir = await fs.mkdtemp(path.join(stateDir, 'sess-'));
  const sess = await writeLinkSession(dir, model);
  return { dir, sess, env: { OMP_TAB_STATE_DIR: dir, OMP_TAB_STATE_PTS_N: LINK_PTS } };
};
const closedArgs = async () => fs.readFile(path.join(stateDir, 'close-args'), 'utf8').catch(() => '');
const wasSent = async () =>
  await fs
    .access(path.join(stateDir, 'sent'))
    .then(() => true)
    .catch(() => false);

test('a disallowed default is refused before launch', async () => {
  await reset(NEW_TUI);
  const prov = await allowProviders(['opencode-go/muse-spark-1.3-contributor']);
  await fs.writeFile(configFile(), 'modelRoles:\n  default: anthropic/claude-opus-5\n');
  try {
    const r = await runScript(baseArgs('brief-gt.md'), { OMP_TAB_PROVIDERS: prov });
    assert.equal(r.code, 1, `${r.out}${r.err}`);
    assert.match(r.err, /not in allowedModels/, 'the refusal names the allowlist');
    assert.ok(r.err.includes(prov), 'the refusal names the file');
    assert.equal(await launched(), false);
  } finally {
    await fs.writeFile(configFile(), GOOD_CONFIG);
  }
});

test('an allowed default whose session file names another model is closed with exit 3', async () => {
  await reset(NEW_TUI);
  const prov = await allowProviders(['opencode-go/muse-spark-1.3-contributor']);
  const st = await mkSessionEnv('anthropic/claude-opus-5');
  const r = await runScript(baseArgs('brief-gt.md'), { OMP_TAB_PROVIDERS: prov, ...st.env });
  assert.equal(r.code, 3, `${r.out}${r.err}`);
  assert.match(r.out + r.err, /WINDOW_ID=991001/, 'exit 3 still prints the window id');
  assert.match(r.err, /anthropic\/claude-opus-5/, 'the verdict names the model it found');
  assert.match(await closedArgs(), /991001/, 'the mismatched window was closed');
  assert.equal(await wasSent(), true, 'the proof runs after the brief is sent (omp writes the file then)');
});

test('a session file naming the launched model passes', async () => {
  await reset(NEW_TUI);
  const prov = await allowProviders(['opencode-go/muse-spark-1.3-contributor']);
  const st = await mkSessionEnv('opencode-go/muse-spark-1.3-contributor');
  // kitty-send proves a linked tab by a NEW role:user row past the pre-send
  // line count; nothing appends one here, so steer one in the background the
  // way kitty-send.test.sh case 15 does.
  const userRow = `{"type":"message","id":"u1","message":{"role":"user","content":[{"type":"text","text":"steer"}],"timestamp":${Date.now()}}}\n`;
  const append = new Promise((res, rej) => setTimeout(() => fs.appendFile(st.sess, userRow).then(res, rej), 1000));
  const r = await runScript(baseArgs('brief-gt.md'), { OMP_TAB_PROVIDERS: prov, ...st.env });
  await append;
  assert.equal(r.code, 0, `${r.out}${r.err}`);
  assert.match(r.err, /proven from the tab's session file/, 'the launched-as note carries the proven model');
  assert.equal(await launched(), true);
});

// omp writes the session file only at the first persisted message (measured
// 2026-09-13: a tab sent nothing wrote no file in 20 s). The proof must wait
// for the send; placed before it, this case exited 3 and every real launch
// was refused.
test('a session file that appears only after the brief is sent is proven', async () => {
  await reset(NEW_TUI);
  const prov = await allowProviders(['opencode-go/muse-spark-1.3-contributor']);
  const dir = await fs.mkdtemp(path.join(stateDir, 'sess-late-'));
  const sess = await writeLinkSession(dir, 'opencode-go/muse-spark-1.3-contributor');
  const body = await fs.readFile(sess, 'utf8');
  await fs.rm(sess);
  const userRow = `{"type":"message","id":"u1","message":{"role":"user","content":[{"type":"text","text":"brief"}],"timestamp":${Date.now()}}}\n`;
  let written = false;
  const timer = setInterval(async () => {
    if (written) return;
    const sent = await fs.access(path.join(stateDir, 'sent')).then(() => true, () => false);
    if (sent) { written = true; await fs.writeFile(sess, body + userRow); }
  }, 100);
  try {
    const r = await runScript(baseArgs('brief-gt.md'), { OMP_TAB_PROVIDERS: prov, OMP_TAB_STATE_DIR: dir, OMP_TAB_STATE_PTS_N: LINK_PTS });
    assert.equal(written, true, 'the fixture wrote the session file only once the brief was sent');
    assert.equal(r.code, 0, `${r.out}${r.err}`);
    assert.match(r.err, /proven from the tab's session file/);
  } finally {
    clearInterval(timer);
  }
});

test('a missing session file closes the window with exit 3', async () => {
  await reset(NEW_TUI);
  const prov = await allowProviders(['opencode-go/muse-spark-1.3-contributor']);
  const dir = await fs.mkdtemp(path.join(stateDir, 'sess-empty-'));
  const r = await runScript(baseArgs('brief-gt.md'), {
    OMP_TAB_PROVIDERS: prov,
    OMP_TAB_STATE_DIR: dir,
    OMP_TAB_STATE_PTS_N: '7',
  });
  assert.equal(r.code, 3, `${r.out}${r.err}`);
  assert.match(r.err, /could not prove the launch model/, '"could not check" says so');
  assert.match(await closedArgs(), /991001/, 'the unproven window was closed');
  assert.equal(await wasSent(), true, 'the proof runs after the brief is sent (omp writes the file then)');
});
