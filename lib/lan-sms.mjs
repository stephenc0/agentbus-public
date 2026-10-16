import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { AGENT_ID, remoteId } from './lan.mjs';

// A narrow gateway to the primary's existing lock authority. No pairing, route
// mutation, forced unlock, global service changes, or second relay connection.
export async function smsGateway(request, sourceHost, { config, knownAgent, call = clawRequest }) {
  if (config.smsPrimary !== config.hostId) return { ok: false, error: 'this host is not the configured sms primary' };
  const method = request.method, route = request.path;
  const read = method === 'GET' && (['/status', '/locks', '/routes'].includes(route) || /^\/inbox\?(?:since=\d+&limit=\d+|limit=\d+&since=\d+)$/.test(route || ''));
  const write = (method === 'POST' && ['/send', '/typing', '/read'].includes(route)) || (['PUT', 'DELETE'].includes(method) && /^\/locks\/(?:%2[Bb]|\+)\d{10,15}$/.test(route || ''));
  if (!read && !write) return { ok: false, error: 'sms operation is not permitted over lan' };
  const body = { ...(request.body || {}) };
  if (write) {
    if (!AGENT_ID.test(request.agent || '') || !knownAgent(sourceHost, request.agent)) return { ok: false, error: 'sms caller must be a freshly discovered live agent on the authenticated host' };
    if (body.force) return { ok: false, error: 'forced unlock is local-only' };
    const holder = remoteId(sourceHost, request.agent);
    if (route.startsWith('/locks/')) body.holder = holder;
    else body.agent = holder;
    if (route === '/send') {
      if (typeof body.requestId !== 'string' || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(body.requestId)) return { ok: false, error: 'stable requestId required' };
      // Namespace retries across both host and session, retaining relay dedupe.
      body.requestId = `lan:${sourceHost}:${crypto.createHash('sha256').update(`${request.agent}:${body.requestId}`).digest('hex')}`;
    }
  }
  const response = await call(method, route, read ? undefined : body);
  return { ok: true, response };
}

export function clawRequest(method, route, body) {
  const socketPath = process.env.CLAW_MESSENGER_SOCK || path.join(os.homedir(), '.claw-messenger', 'daemon.sock');
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? '' : JSON.stringify(body);
    const req = http.request({ socketPath, method, path: route, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } }, (res) => {
      let data = ''; res.on('data', (b) => { data += b; if (Buffer.byteLength(data) > 512 * 1024) req.destroy(Error('claw response too large')); });
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(data) }); } catch { reject(Error('invalid claw response')); } });
    });
    const timer = setTimeout(() => req.destroy(Error('sms primary request timed out; mutation may have been accepted')), 45000);
    req.on('close', () => clearTimeout(timer)); req.on('error', reject); req.end(payload);
  });
}
