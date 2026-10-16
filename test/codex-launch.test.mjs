import test from 'node:test';
import assert from 'node:assert/strict';
import { etimeSeconds, restoredAppSafeToRelaunch, desktopLaunchArgs } from '../lib/codex-launch.mjs';

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
