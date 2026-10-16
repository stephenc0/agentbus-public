#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { attachProxy } from '../lib/codex-proxy.mjs';

const busDir = process.env.AGENTBUS_DIR || path.join(os.homedir(), '.agentbus');
let config = {};
try { config = JSON.parse(fs.readFileSync(path.join(busDir, 'bridge-config.json'), 'utf8')); } catch {}
const binary = process.env.AGENTBUS_CODEX_REAL || config.binary;
if (!binary || fs.realpathSync(binary) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  console.error('agentbus: configure AGENTBUS_CODEX_REAL or run agentbus install-codex-bridge'); process.exit(1);
}
const args = process.argv.slice(2);
const index = args.indexOf('app-server');
// Only wrap the stdio server. CLI commands, daemon management, schemas and
// remote listeners must preserve their native transport and terminal behavior.
const tail = index >= 0 ? args.slice(index + 1) : [];
const otherCommand = tail.some((a) => ['daemon', 'proxy', 'generate-ts', 'generate-json-schema', 'help'].includes(a));
const listenIndex = tail.indexOf('--listen');
const listen = listenIndex >= 0 ? tail[listenIndex + 1] : tail.find((a) => a.startsWith('--listen='))?.slice(9);
const wrap = index >= 0 && !otherCommand && !args.includes('--help') && !args.includes('-h') && (!listen || listen === 'stdio://');
const child = spawn(binary, args, { stdio: wrap ? ['pipe', 'pipe', 'inherit'] : 'inherit', windowsHide: true, env: { ...process.env, AGENTBUS_PUSH_BRIDGE_PID: wrap ? String(process.pid) : '' } });
if (wrap) attachProxy({ child, input: process.stdin, output: process.stdout, busDir });
child.on('error', (e) => { console.error(`agentbus: ${e.message}`); process.exit(1); });
child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => child.kill(signal));
