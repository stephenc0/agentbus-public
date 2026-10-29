#!/usr/bin/env node
// Scan the tracked tree, the commits about to be pushed and the committer identity for secrets and owner identifiers.
// Refuses on any finding. Meant as a pre-push hook in a checkout of a public repo:
//
//   printf '#!/bin/sh\nexec node scripts/leak-check.mjs --pre-push\n' > .git/hooks/pre-push && chmod +x .git/hooks/pre-push
//   node scripts/leak-check.mjs            # by hand: tree + identity
//
// Owner-specific identifiers belong in a deny list OUTSIDE the repo (one regex per line, # comments):
//   ~/.agentbus/publish-denylist.txt   (override with --denylist PATH or AGENTBUS_PUBLISH_DENYLIST)
// Never commit that file: it would publish exactly what it protects.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const flag = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const has = (name) => args.includes(name);
const repo = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8', maxBuffer: 1 << 30 });
const denylistPath = flag('--denylist', process.env.AGENTBUS_PUBLISH_DENYLIST || path.join(os.homedir(), '.agentbus', 'publish-denylist.txt'));

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
const patterns = [...builtin, ...deny];
const findings = [];
const scanText = (where, text) => text.split('\n').forEach((line, i) => { for (const [label, re] of patterns) if (re.test(line)) findings.push(`${where}:${i + 1}: ${label}`); });

// 1. the tracked tree as it is on disk
for (const rel of git('ls-files', '-z').split('\0').filter(Boolean)) {
  for (const re of forbiddenFiles) if (re.test(rel)) findings.push(`${rel}: forbidden file name (${re})`);
  if (/(^|\/)package-lock\.json$/.test(rel)) continue; // registry urls and integrity hashes only
  const file = path.join(repo, rel);
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) continue;
  const buf = fs.readFileSync(file);
  if (!buf.includes(0)) scanText(rel, buf.toString('utf8'));
}

// 2. committer identity: it ends up in every commit
const ident = ['user.name', 'user.email'].map((k) => spawnSync('git', ['config', k], { cwd: repo, encoding: 'utf8' }).stdout.trim());
if (!ident[0] || !ident[1] || /\.local$/i.test(ident[1]) || patterns.some(([, re]) => re.test(ident.join(' ')))) {
  findings.push(`git identity "${ident[0]} <${ident[1]}>" is unset or identifying. set a public one: git config user.name NAME && git config user.email ID+NAME@users.noreply.github.com`);
}

// 3. pre-push: every commit being pushed (authors, messages, diffs). git feeds "<local ref> <local sha> <remote ref> <remote sha>" lines
if (has('--pre-push')) {
  const zero = /^0+$/;
  for (const line of fs.readFileSync(0, 'utf8').split('\n').filter(Boolean)) {
    const [, local, , remote] = line.split(' ');
    if (zero.test(local)) continue; // a delete
    const range = zero.test(remote) ? [local, '--not', '--remotes'] : [`${remote}..${local}`];
    for (const sha of git('rev-list', ...range).split('\n').filter(Boolean)) {
      scanText(`commit ${sha.slice(0, 7)} header`, git('show', '-s', '--format=%an <%ae>%n%cn <%ce>%n%B', sha));
      const added = git('show', '--format=', '--unified=0', '--no-color', sha, '--', '.', ':!package-lock.json', ':!**/package-lock.json').split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).join('\n');
      scanText(`commit ${sha.slice(0, 7)} diff`, added);
    }
  }
}

if (findings.length) { console.error(`leak check: ${findings.length} finding(s):\n` + findings.map((f) => '  ' + f).join('\n')); process.exit(1); }

// gitleaks sees only tracked files (a copy), never node_modules, worktrees or other untracked state
const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'agentbus-leak-'));
for (const rel of git('ls-files', '-z').split('\0').filter(Boolean)) {
  const src = path.join(repo, rel);
  if (!fs.existsSync(src) || !fs.statSync(src).isFile()) continue;
  fs.mkdirSync(path.dirname(path.join(stage, rel)), { recursive: true }); fs.copyFileSync(src, path.join(stage, rel));
}
const gl = spawnSync('gitleaks', ['dir', stage, '--no-banner', '--redact', '--exit-code', '1'], { encoding: 'utf8' });
fs.rmSync(stage, { recursive: true, force: true });
if (gl.error?.code === 'ENOENT') { if (!has('--allow-no-gitleaks')) { console.error('gitleaks not installed (brew install gitleaks), or pass --allow-no-gitleaks'); process.exit(2); } }
else if (gl.status !== 0) { console.error(`gitleaks findings:\n${gl.stdout}${gl.stderr}`); process.exit(1); }
console.log(`leak check clean: ${patterns.length} patterns${gl.error ? '' : ', gitleaks clean'}`);
