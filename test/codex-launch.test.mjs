import test from 'node:test';
import assert from 'node:assert/strict';
import { etimeSeconds, restoredAppSafeToRelaunch, desktopLaunchArgs, launchDesktop, bridgeOwner } from '../lib/codex-launch.mjs';

test('ps etime parses to seconds', () => {
  assert.equal(etimeSeconds('00:07'), 7);
  assert.equal(etimeSeconds('03:05'), 185);
  assert.equal(etimeSeconds('1:02:03'), 3723);
  assert.equal(etimeSeconds('2-01:00:00'), 176400);
  assert.equal(etimeSeconds('garbage'), null);
});

test('a login-restored unbridged app is relaunched only when young and idle', () => {
  assert.equal(restoredAppSafeToRelaunch({ appAgeSec: 20, busyThreads: 0 }), true);
  assert.equal(restoredAppSafeToRelaunch({ appAgeSec: 240, busyThreads: 0 }), true);
  assert.equal(restoredAppSafeToRelaunch({ appAgeSec: 241, busyThreads: 0 }), false, 'user may have started working');
  assert.equal(restoredAppSafeToRelaunch({ appAgeSec: 20, busyThreads: 1 }), false, 'a running turn is never interrupted');
  assert.equal(restoredAppSafeToRelaunch({ appAgeSec: null, busyThreads: 0 }), false, 'unknown age is not safe');
});

test('launch args target the outer app bundle with the bridge wrapper env', () => {
  assert.deepEqual(desktopLaunchArgs({ binary: '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex', wrapper: '/Users/you/.agentbus/codex-bridge' }),
    ['-a', '/Applications/ChatGPT.app', '--env', 'CODEX_CLI_PATH=/Users/you/.agentbus/codex-bridge']);
});

// a fake mac: one app, its bridge child, a clock that only moves when the launcher sleeps.
const APP = '/Applications/ChatGPT.app', config = { binary: `${APP}/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex`, wrapper: '/Users/you/.agentbus/codex-bridge' };
function fakeMac({ app = null, busy = 0, onOpen = (m) => m.start(true), onQuit = (m) => { m.app = null; return true; } } = {}) {
  const m = { t: 1_000_000, app, busy, calls: [], opens: 0, quits: 0 };
  m.start = (bridged, ageSec = 0) => { m.app = { pid: 500 + m.opens, born: m.t - ageSec * 1000, bridged }; };
  m.system = {
    now: () => m.t, sleep: async (ms) => { m.t += ms; },
    ps: () => m.app ? [{ pid: m.app.pid, ppid: 1, ageSec: Math.floor((m.t - m.app.born) / 1000), comm: `${APP}/Contents/MacOS/ChatGPT` }, { pid: 900, ppid: m.app.pid, ageSec: 0, comm: '/usr/local/bin/node' }] : [],
    bridges: async () => m.app?.bridged ? [{ pid: 900, ready: true, status: 'accepted' }] : [],
    setenv: () => m.calls.push('setenv'), open: () => { m.opens++; m.calls.push('open'); if (!m.app) onOpen(m); },
    quit: async () => { m.quits++; m.calls.push('quit'); return onQuit(m); }, busyThreads: async () => m.busy,
  };
  return m;
}
const run = (m, extra = {}) => launchDesktop({ atLogin: true, config, system: m.system, log: () => {}, ...extra });

test('login: an app that is already bridged is left alone and the job exits clean', async () => {
  const m = fakeMac(); m.start(true, 3 * 86400);
  const r = await run(m);
  assert.equal(r.action, 'already-bridged'); assert.deepEqual(m.calls, [], 'no open (focus steal), no quit');
});

test('login: nothing running -> launch bridged', async () => {
  const m = fakeMac();
  assert.equal((await run(m)).action, 'launched'); assert.equal(m.quits, 0);
});

test('login: macos restored the app unbridged just before us -> quit normally and relaunch bridged', async () => {
  const m = fakeMac(); m.start(false, 20);
  const r = await run(m);
  assert.equal(r.action, 'launched'); assert.equal(m.quits, 1); assert.deepEqual(m.calls.filter((c) => c !== 'setenv'), ['quit', 'open']);
});

test('login: something else opens the app unbridged right after our open (the race) -> recovered', async () => {
  let first = true;
  const m = fakeMac({ onOpen: (mac) => { mac.start(!first); first = false; } }); // first open loses to a restore without env
  const r = await run(m);
  assert.equal(r.action, 'launched'); assert.equal(m.quits, 1); assert.equal(m.opens, 2);
});

test('login: an app restored with the env inherited gets a moment to bridge instead of being quit', async () => {
  const m = fakeMac(); m.start(false, 5);
  const orig = m.system.sleep; m.system.sleep = async (ms) => { await orig(ms); if (m.t - 1_000_000 >= 3000) m.app.bridged = true; };
  assert.equal((await run(m)).action, 'bridged'); assert.equal(m.quits, 0);
});

test('login: an old or busy unbridged app is the user\'s and is never quit', async () => {
  for (const [ageSec, busy] of [[3600, 0], [20, 1]]) {
    const m = fakeMac({ busy }); m.start(false, ageSec);
    await assert.rejects(run(m), /desktop bridge not ready.*no processes were stopped/);
    assert.equal(m.quits, 0, `age ${ageSec} busy ${busy}`);
  }
});

test('login: relaunches are bounded when the app keeps coming back unbridged', async () => {
  const m = fakeMac({ onOpen: (mac) => mac.start(false) });
  await assert.rejects(run(m), /not ready|not touching|no processes were stopped|within/);
  assert(m.quits <= 3, `quit ${m.quits} times`);
});

test('interactive launch keeps the refusal and never quits anything', async () => {
  const m = fakeMac(); m.start(false, 20);
  await assert.rejects(launchDesktop({ config, system: m.system, log: () => {} }), /checkpoint it, quit normally/);
  assert.equal(m.quits, 0);
});

test('a ready bridge only counts when it is a child of the app', () => {
  const rows = [{ pid: 1, ppid: 0, comm: `${APP}/Contents/MacOS/ChatGPT` }, { pid: 2, ppid: 1, comm: 'node' }, { pid: 3, ppid: 77, comm: 'node' }];
  assert.equal(bridgeOwner([{ pid: 3, ready: true, status: 'accepted' }], rows, APP), null);
  assert.equal(bridgeOwner([{ pid: 2, ready: true, status: 'accepted' }], rows, APP).pid, 2);
});
