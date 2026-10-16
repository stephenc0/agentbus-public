import { registerStorage, removeStorage, storageStatus, formatStorage } from '../lib/storage.mjs';
import { lanSettings } from '../lib/lan.mjs';

export async function runStorage(args) {
  const command = args.shift() || 'list';
  const flag = (name) => { const i = args.indexOf(name); if (i < 0) return undefined; if (!args[i + 1] || args[i + 1].startsWith('--')) throw Error(`${name} needs a value`); return args.splice(i, 2)[1]; };
  const has = (name) => { const i = args.indexOf(name); if (i < 0) return false; args.splice(i, 1); return true; };
  if (command === 'add') {
    const create = has('--create'), name = flag('--name'), localPath = flag('--path'), uri = flag('--uri'), ownerHostId = flag('--owner') || lanSettings()?.hostId, id = flag('--id'), access = flag('--access') || 'rw', purpose = flag('--purpose');
    if (args.length || !localPath) throw Error('unexpected arguments or missing --path');
    if (create && ownerHostId !== lanSettings()?.hostId) throw Error('only the storage owner can create the identity marker');
    console.log(JSON.stringify(registerStorage({ name, localPath, uri, ownerHostId, id, access, purpose, create }), null, 2));
  } else if (command === 'remove') {
    const id = args.shift(); if (!id || args.length) throw Error('storage remove <storage-id>');
    removeStorage(id); console.log('registration removed; files unchanged');
  } else if (command === 'list') {
    const json = has('--json'); if (args.length) throw Error('unknown arguments');
    const status = await storageStatus(); console.log(json ? JSON.stringify(status, null, 2) : formatStorage(status));
  } else throw Error('storage add --name name --path directory --uri smb://host/share [--create] [--owner host-id] [--id storage-id] [--access ro|rw] | list [--json] | remove id');
}
