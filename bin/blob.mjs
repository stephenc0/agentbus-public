// agentbus blob: move job inputs/results to and from a peer's owned task storage over the lan/wan psk link.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { loadLan } from '../lib/lan.mjs';
import { uploadFile, downloadFile, blobStat, blobPurge, validName } from '../lib/blob.mjs';
import { resolvePeer, ownedStorage } from '../lib/wan.mjs';

const USAGE = `usage:
  agentbus blob put  --host HOST --task new|TASK_UUID [--storage ID] [--area in|out] [--as NAME] [--overwrite] FILE [FILE...]
  agentbus blob get  --host HOST --task TASK_UUID [--storage ID] [--area out|in] [--out DIR] [--wait-for NAME [--timeout 24h]] [NAME...|--all]
  agentbus blob stat --host HOST --task TASK_UUID [--storage ID] [--json]
  agentbus blob purge --host HOST --task TASK_UUID [--storage ID] [--area in|out --name NAME]
HOST is a peer name or host id from \`agentbus list\` / \`agentbus lan status\`. put prints the task id and the
task's absolute path on the owner (use it as the cwd when spawning the job there).`;

const human = (n) => n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(2)} GiB` : n >= 1024 ** 2 ? `${(n / 1024 ** 2).toFixed(1)} MiB` : `${n} B`;
function progress(label) {
  let last = 0, start = Date.now();
  const tty = process.stderr.isTTY;
  return (done, total) => {
    const now = Date.now();
    if (done !== total && now - last < (tty ? 250 : 15000)) return;
    last = now;
    const rate = done / Math.max(1, (now - start) / 1000);
    const msg = `${label} ${human(done)}/${human(total)} ${total ? Math.floor((done / total) * 100) : 100}% ${human(rate)}/s`;
    process.stderr.write(tty ? `\r${msg}\x1b[K${done === total ? '\n' : ''}` : msg + '\n');
  };
}
const duration = (v) => { const m = /^(\d+)(s|m|h)?$/.exec(v || ''); if (!m) throw Error('bad --timeout; use e.g. 90m or 24h'); return Number(m[1]) * { s: 1000, m: 60000, h: 3600000 }[m[2] || 's']; };

export async function runBlob(args) {
  const command = args.shift();
  const option = (name) => { const i = args.indexOf(name); if (i < 0) return undefined; if (!args[i + 1] || args[i + 1].startsWith('--')) throw Error(`${name} requires a value`); return args.splice(i, 2)[1]; };
  const has = (name) => { const i = args.indexOf(name); if (i < 0) return false; args.splice(i, 1); return true; };
  if (!['put', 'get', 'stat', 'purge'].includes(command)) throw Error(USAGE);
  const host = option('--host'); let task = option('--task');
  if (!host || !task) throw Error(USAGE);
  const config = loadLan(), peer = await resolvePeer(host);
  const storageId = ownedStorage(peer, option('--storage'));
  const onRetry = (e, n, wait) => process.stderr.write(`retry ${n} in ${Math.round(wait / 1000)}s: ${e.message}\n`);
  if (command === 'put') {
    if (task === 'new') task = crypto.randomUUID();
    const area = option('--area') || 'in', as = option('--as'), overwrite = has('--overwrite');
    const files = args.splice(0);
    if (!files.length || (as && files.length > 1)) throw Error(USAGE);
    const results = [];
    for (const file of files) {
      if (!fs.statSync(file).isFile()) throw Error(`${file} is not a file (tar or zip directories first)`);
      const name = as || path.basename(file);
      if (!validName(name)) throw Error(`remote name ${name} is not allowed; pass --as NAME`);
      results.push(await uploadFile(config, peer, { storageId, task, area, name, file, overwrite, onProgress: progress(`put ${name}`), onRetry }));
    }
    const st = await blobStat(config, peer, { storageId, task });
    console.log(JSON.stringify({ ok: true, host: peer.name, hostId: peer.hostId, task, ownerPath: st.path, inputs: `${st.path}${st.path.includes('\\') ? '\\' : '/'}in`, uploaded: results }, null, 2));
  } else if (command === 'get') {
    const area = option('--area') || 'out', outDir = option('--out') || '.', waitFor = option('--wait-for'), timeout = duration(option('--timeout') || '24h'), all = has('--all');
    let st = await blobStat(config, peer, { storageId, task });
    if (!st.ok) throw Error(st.error);
    if (waitFor) {
      const deadline = Date.now() + timeout;
      while (!st[area].some((f) => f.name === waitFor && f.complete)) {
        if (Date.now() > deadline) throw Error(`timed out waiting for ${area}/${waitFor}`);
        await new Promise((r) => setTimeout(r, 15000));
        st = await blobStat(config, peer, { storageId, task }).catch((e) => ({ ok: false, error: e.message, [area]: [] }));
      }
    }
    const names = all || !args.length ? st[area].filter((f) => f.complete).map((f) => f.name) : args.splice(0);
    if (!names.length) throw Error(`nothing complete in ${area}/ yet`);
    const results = [];
    for (const name of names) results.push(await downloadFile(config, peer, { storageId, task, area, name, dest: path.join(outDir, ...name.split('/')), onProgress: progress(`get ${name}`), onRetry }));
    console.log(JSON.stringify({ ok: true, task, downloaded: results }, null, 2));
  } else if (command === 'stat') {
    const json = has('--json'), st = await blobStat(config, peer, { storageId, task });
    if (json || !st.ok) { console.log(JSON.stringify(st, null, 2)); if (!st.ok) process.exitCode = 1; return; }
    console.log(`task ${task} on ${peer.name}: ${st.path}${st.exists ? '' : ' (not created yet)'}`);
    for (const area of ['in', 'out']) for (const f of st[area]) console.log(`  ${area}/${f.name}  ${f.complete ? human(f.size) : `partial ${human(f.have)}/${f.size === null ? '?' : human(f.size)}`}`);
  } else {
    const area = option('--area'), name = option('--name');
    if ((area === undefined) !== (name === undefined)) throw Error('purge one file with both --area and --name, or the whole task with neither');
    console.log(JSON.stringify(await blobPurge(config, peer, { storageId, task, area, name }), null, 2));
  }
}
