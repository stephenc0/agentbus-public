import fs from 'node:fs';
import { configureLaunch, createLauncher, spawnSession, refreshLauncherCapabilities, defaultBus, launchPolicy } from '../lib/session-launch.mjs';
import { listAgents, selfIdentity } from '../lib/core.mjs';
import { localLanRequest, UUID } from '../lib/lan.mjs';
import { seedClaudeTrust, readClaudeTrust, launchContext } from '../lib/claude-trust.mjs';

export async function runSessions(args) {
  const command = args.shift();
  const option = (key) => { const i = args.indexOf(key); if (i < 0) return undefined; if (!args[i + 1] || args[i + 1].startsWith('--')) throw Error(`${key} requires a value`); return args.splice(i, 2)[1]; };
  const flag = (key) => { const i = args.indexOf(key); if (i < 0) return false; args.splice(i, 1); return true; };
  const done = (value) => { console.log(JSON.stringify(value, null, 2)); if (value?.ok === false) process.exitCode = 1; };
  if (command === 'configure') {
    const roots = []; let root; while ((root = option('--root')) !== undefined) roots.push(root);
    const remote = flag('--remote'), max = option('--max'), codex = option('--codex'), claude = option('--claude'), profilesFile = option('--profiles-file');
    if (args.length) throw Error('unknown configure arguments');
    done(configureLaunch({ roots, remote, maxSessions: max === undefined ? 4 : Number(max), runtimes: { codex, claude }, permissionProfiles: profilesFile ? JSON.parse(fs.readFileSync(profilesFile, 'utf8')) : undefined }));
  } else if (command === 'trust-claude-roots') {
    // mark the configured launch roots (or the given ones) trusted in THIS account's .claude.json, as accepting the dialog
    // would. run it as the account the daemon launches with, with no claude session open. login is separate.
    const roots = []; let root; while ((root = option('--root')) !== undefined) roots.push(root);
    if (args.length) throw Error('usage: agentbus sessions trust-claude-roots [--root <path>]...  (defaults to the configured launch roots)');
    const policy = launchPolicy(defaultBus());
    const targets = roots.length ? roots : policy.roots || [];
    if (!targets.length) throw Error('no launch roots configured; pass --root or run sessions configure first');
    done({ ok: true, ...seedClaudeTrust(targets), context: await launchContext() });
  } else if (command === 'claude-trust') {
    // what the launching account's claude state says about a workspace, and who that account is.
    const cwd = option('--cwd') || process.cwd();
    if (args.length) throw Error('usage: agentbus sessions claude-trust [--cwd <path>]');
    const trust = readClaudeTrust(cwd);
    done({ ok: trust.trusted === true, cwd, ...trust, context: await launchContext() });
  } else if (command === 'capabilities') {
    const lan = await localLanRequest({ op: 'status' }, { timeout: 2000 });
    done({ local: await refreshLauncherCapabilities(undefined, { listLocal: listAgents }), peers: lan.peers?.map((p) => ({ hostId: p.hostId, name: p.name, launching: p.launching })) || [] });
  } else if (command === 'spawn') {
    const runtime = option('--runtime'), cwd = option('--cwd'), host = option('--host'), model = option('--model'), name = option('--name'), id = option('--id'), from = option('--from'), promptFile = option('--prompt-file'), permission_profile = option('--permission-profile');
    const claims = []; let claim; while ((claim = option('--claim')) !== undefined) claims.push(claim);
    const prompt = promptFile ? fs.readFileSync(promptFile, 'utf8') : args.join(' ');
    done(await spawnSession({ runtime, cwd, host, model, name, id, permission_profile, ...(claims.length ? { claims } : {}), from: selfIdentity(from)?.id, prompt }, { listLocal: listAgents }));
  } else if (command === 'reconcile') {
    // local host owner only: list receipts that hold no slot any more, or close one of them.
    const close = option('--close');
    if (args.length) throw Error('usage: agentbus sessions reconcile [--close <launch-uuid>]');
    const launcher = createLauncher({ listLocal: listAgents });
    if (close) { if (!UUID.test(close)) throw Error('--close requires a launch UUID'); done(launcher.close(close)); }
    else { const stale = launcher.stale(); done({ ok: true, stale, note: stale.length ? 'these no longer count toward maxSessions; `--close <id>` marks one stopped (termination unverified)' : 'no stale launch receipts' }); }
  } else if (command === 'status') {
    const host = option('--host'), from = option('--from'), id = args.shift();
    done(host && host !== 'local' ? await localLanRequest({ op: 'spawn-status', id, host, from: selfIdentity(from)?.id }) : await createLauncher({ listLocal: listAgents }).status(id));
  } else if (command === 'stop') {
    const host = option('--host'), from = option('--from'), id = args.shift();
    if (!UUID.test(id || '') || args.length) throw Error('stop requires one launch UUID');
    done(host && host !== 'local' ? await localLanRequest({ op: 'spawn-stop', id, host, from: selfIdentity(from)?.id }) : await createLauncher({ listLocal: listAgents }).stop(id));
  } else throw Error('usage: agentbus sessions configure --root <path> [--root <path>] [--remote] [--max 4] [--profiles-file <json>] [--codex <executable>] [--claude <executable>] | capabilities | spawn --runtime codex|claude-code|claude-desktop --cwd <destination-path> [--host name|uuid] [--from id] [--model model] [--id uuid] [--permission-profile name] [--claim gpu]... [--prompt-file file] <prompt> | status <uuid> [--host name] [--from id] | stop <launch-uuid> [--host name] [--from id] | reconcile [--close <launch-uuid>] | claude-trust [--cwd path] | trust-claude-roots [--root path]...');
}
