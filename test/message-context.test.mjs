import test from 'node:test';
import assert from 'node:assert/strict';
import { renderMessages, startupContext } from '../lib/message-context.mjs';
test('native envelope renders exactly once with its routable sender intact', () => {
  const content = '<cross-session-message from="lan:host/claude:session" from-name="peer" via="agentbus">\nhello\n</cross-session-message>';
  assert.equal(renderMessages([{ from: 'lan:host/claude:session', from_name: 'peer', at: 'timestamp', content }]), content);
});
test('legacy unwrapped records retain explicit sender identity', () => {
  const text = renderMessages([{ from: 'codex:one', from_name: 'worker', content: 'hello' }, { from: 'codex:two', from_name: 'worker', content: 'world' }]);
  assert.match(text, /codex:one/); assert.match(text, /codex:two/);
  assert(!text.includes('reply with'));
});
test('startup describes purpose and exact discovery tools without a roster', () => {
  const text = startupContext('codex:self');
  assert.match(text, /coordinates agents/); assert.match(text, /list_agents/);
  assert.match(text, /host_status/); assert.match(text, /codex:self/);
  assert(!text.includes('live peers')); assert(text.length < 260);
});
