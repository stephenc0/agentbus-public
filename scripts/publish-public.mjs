#!/usr/bin/env node
// Export one git ref of the private dev repo as a single commit in a separate public checkout.
// Private history never leaves: only the tree at <ref> is copied. Refuses on any finding.
//
//   node scripts/publish-public.mjs --ref feat/internet-guests --public-dir ../agentbus-public [--message msg] [--skip-tests]
//
// Owner-specific identifiers belong in a deny list OUTSIDE the repo (one regex per line, # comments):
//   ~/.agentbus/publish-denylist.txt   (override with --denylist PATH or AGENTBUS_PUBLISH_DENYLIST)
// Never commit that file: it would publish exactly what it protects.
// Pushing is deliberately manual; the script prints the command.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const flag = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const has = (name) => args.includes(name);
const repo = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const ref = flag('--ref');
const publicDir = flag('--public-dir') && path.resolve(flag('--public-dir'));
const denylistPath = flag('--denylist', process.env.AGENTBUS_PUBLISH_DENYLIST || path.join(os.homedir(), '.agentbus', 'publish-denylist.txt'));
if (!ref || !publicDir) { console.error('usage: publish-public.mjs --ref REF --public-dir DIR [--message MSG] [--denylist PATH] [--skip-tests]'); process.exit(2); }
if (publicDir === repo || publicDir.startsWith(repo + path.sep)) { console.error('public dir must be outside the private repo'); process.exit(2); }

// Generic patterns that are never acceptable in a public tree, whoever the owner is.
const builtin = [
  ['private key block', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['github token', /\b(gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/],
  ['openai/anthropic style key', /\bsk-(ant-)?[A-Za-z0-9_-]{24,}\b/],
  ['aws access key', /\bAKIA[0-9A-Z]{16}\b/],
  ['slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/],
  ['oauth access token', /\bgho_[A-Za-z0-9]{30,}\b/],
  ['nanp phone number outside 555-01xx', /\+1(?!5555550[01]\d\d)[2-9]\d{2}[2-9]\d{6}\b/],
  ['macos home path', /\/Users\/(?!(you|alice|bob|test|example|USER|<[^>]+>)\b)[A-Za-z][A-Za-z0-9._-]+\//],
  ['windows profile path', /[A-Za-z]:\\{1,2}Users\\{1,2}(?!(you|alice|bob|example|USER|Public)\b)[A-Za-z][A-Za-z0-9._-]+/i],
];
const forbiddenFiles = [/(^|\/)\.env(\.|$)/, /\.(key|pem|p12|pfx)$/i, /(^|\/)claw-messenger\/config\.json$/, /credential/i, /(^|\/)publish-denylist/i, /(^|\/)\.agentbus\//];

let deny = [];
if (fs.existsSync(denylistPath)) {
  deny = fs.readFileSync(denylistPath, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).map((l) => [`denylist: ${l.slice(0, 3)}…`, new RegExp(l, 'i')]);
} else if (!has('--allow-no-denylist')) {
  console.error(`no deny list at ${denylistPath}. create one with owner identifiers (names, host ids, numbers), or pass --allow-no-denylist`);
  process.exit(2);
}

const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'agentbus-publish-'));
const fail = (msg) => { console.error(msg); fs.rmSync(stage, { recursive: true, force: true }); process.exit(1); };
const sha = execFileSync('git', ['rev-parse', '--verify', `${ref}^{commit}`], { cwd: repo, encoding: 'utf8' }).trim();
const tar = spawnSync('git', ['archive', '--format=tar', sha], { cwd: repo, maxBuffer: 1 << 30 });
if (tar.status !== 0) fail('git archive failed');
const untar = spawnSync('tar', ['-x', '-C', stage], { input: tar.stdout });
if (untar.status !== 0) fail('tar extract failed');

const files = [];
const walk = (dir) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) walk(p); else files.push(p); } };
walk(stage);
const findings = [];
for (const file of files) {
  const rel = path.relative(stage, file).split(path.sep).join('/');
  for (const re of forbiddenFiles) if (re.test(rel)) findings.push(`${rel}: forbidden file name (${re})`);
  if (/(^|\/)package-lock\.json$/.test(rel)) continue; // registry urls and integrity hashes only
  const buf = fs.readFileSync(file);
  if (buf.includes(0)) continue;
  const lines = buf.toString('utf8').split('\n');
  lines.forEach((line, i) => {
    for (const [label, re] of [...builtin, ...deny]) if (re.test(line)) findings.push(`${rel}:${i + 1}: ${label}`);
  });
}
if (findings.length) fail(`refusing to publish, ${findings.length} finding(s):\n` + findings.map((f) => '  ' + f).join('\n'));
console.log(`scan clean: ${files.length} files, ${builtin.length} builtin + ${deny.length} deny list patterns`);

const gl = spawnSync('gitleaks', ['dir', stage, '--no-banner', '--redact', '--exit-code', '1'], { encoding: 'utf8' });
if (gl.error?.code === 'ENOENT') { if (!has('--allow-no-gitleaks')) fail('gitleaks not installed (brew install gitleaks), or pass --allow-no-gitleaks'); console.log('gitleaks skipped'); }
else if (gl.status !== 0) fail(`gitleaks findings:\n${gl.stdout}${gl.stderr}`);
else console.log('gitleaks clean');

if (!has('--skip-tests')) {
  for (const [cmd, a] of [['npm', ['ci', '--no-audit', '--no-fund']], ['npm', ['test']]]) {
    const r = spawnSync(cmd, a, { cwd: stage, stdio: 'inherit', shell: process.platform === 'win32' });
    if (r.status !== 0) fail(`${cmd} ${a.join(' ')} failed in the export`);
  }
  fs.rmSync(path.join(stage, 'node_modules'), { recursive: true, force: true });
}

if (!fs.existsSync(path.join(publicDir, '.git'))) { fs.mkdirSync(publicDir, { recursive: true }); execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: publicDir }); }
for (const e of fs.readdirSync(publicDir)) if (e !== '.git') fs.rmSync(path.join(publicDir, e), { recursive: true, force: true });
fs.cpSync(stage, publicDir, { recursive: true });
fs.rmSync(stage, { recursive: true, force: true });
const version = JSON.parse(fs.readFileSync(path.join(publicDir, 'package.json'), 'utf8')).version;
const ident = ['user.name', 'user.email'].map((k) => spawnSync('git', ['config', k], { cwd: publicDir, encoding: 'utf8' }).stdout.trim());
if (!ident[0] || !ident[1] || /\.local$/i.test(ident[1]) || [...builtin, ...deny].some(([, re]) => re.test(ident.join(' ')))) {
  console.error(`public checkout author "${ident[0]} <${ident[1]}>" is unset or identifying. set a public identity first:\n  git -C ${JSON.stringify(publicDir)} config user.name NAME && git -C ${JSON.stringify(publicDir)} config user.email ID+NAME@users.noreply.github.com`);
  process.exit(1);
}
execFileSync('git', ['add', '-A'], { cwd: publicDir });
const changed = spawnSync('git', ['diff', '--cached', '--quiet'], { cwd: publicDir }).status !== 0;
if (!changed) { console.log('public checkout already matches; nothing to commit'); process.exit(0); }
execFileSync('git', ['commit', '-q', '-m', flag('--message', `agentbus ${version}`)], { cwd: publicDir, stdio: 'inherit' });
console.log(`committed agentbus ${version} in ${publicDir}. review, then push manually:\n  git -C ${JSON.stringify(publicDir)} push -u origin main`);
