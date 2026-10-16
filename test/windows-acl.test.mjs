import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { restrictToOwner, ownerOnly, ownerOnlySddl, ownerOnlyAclExport } from '../lib/lan.mjs';

const sid = 'S-1-5-21-100-200-300-1001';
const allow = `(A;;FA;;;${sid})`;
test('owner-only SDDL matches caller SID without translated account names', () => {
  assert.equal(ownerOnlySddl('D:P' + allow, sid), true);
  assert.equal(ownerOnlySddl(`D:AI(A;ID;FA;;;${sid})`, sid), true);
  assert.equal(ownerOnlySddl(`D:PAI(A;OICI;FA;;;${sid})(A;ID;0x1200a9;;;${sid})`, sid), true);
  assert.equal(ownerOnlySddl('D:P(A;;FA;;;SY)', 'S-1-5-18'), true);
  assert.equal(ownerOnlySddl('D:P(A;;FA;;;SY)', sid), false);
});

test('local administrator alias requires an explicitly resolved matching account SID', () => {
  const local = 'S-1-5-21-100-200-300-500';
  const domain = 'S-1-5-21-400-500-600-500';
  assert.equal(ownerOnlySddl('D:P(A;;FA;;;LA)', local), false);
  assert.equal(ownerOnlySddl('D:P(A;;FA;;;LA)', local, local), true);
  assert.equal(ownerOnlySddl('D:P(A;;FA;;;LA)', domain, local), false);
  assert.equal(ownerOnlySddl('D:P(A;;FA;;;BA)', local, local), false);
  assert.equal(ownerOnlyAclExport(Buffer.from('file\r\nD:P(A;;FA;;;LA)\r\n', 'utf16le'), local, local), true);
});

test('foreign trustees, missing or malformed DACL and unsupported ACE forms reject', () => {
  for (const value of ['', 'D:', 'D:P', 'D:NO_ACCESS_CONTROL', 'O:' + sid, 'D:P' + allow + '(A;;FR;;;WD)',
    'D:P' + allow + '(D;;FR;;;BA)', 'D:P(A;;FA;;;S-1-5-21-100-200-300-1002)',
    `D:P(OA;;FA;;;${sid})`, `D:P(XA;;FA;;;${sid};(@User.some == 1))`,
    `D:P(A;;FA;object-guid;;${sid})`, `D:P(A;;;;;${sid})`, `D:P(A;bogus;FA;;;${sid})`, `D:P(A;;bogus;;;${sid})`, 'D:P' + allow + 'garbage', 'D:P((' + allow + '))']) {
    assert.equal(ownerOnlySddl(value, sid), false, value);
  }
});

test('icacls UTF-16 export requires one object with a complete owner-only DACL', () => {
  const text = `some file.txt\r\nD:P${allow}\r\n`;
  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
  assert.equal(ownerOnlyAclExport(utf16, sid), true);
  assert.equal(ownerOnlyAclExport(Buffer.from(text), sid), true);
  for (const name of ['some file.txt', '密钥文件', '🔑 clé']) {
    const bytes = Buffer.from(`${name}\r\nD:P${allow}\r\n`, 'utf16le');
    assert.equal(ownerOnlyAclExport(bytes, sid), true, 'BOM-less UTF-16LE supports Unicode filenames');
    assert.equal(ownerOnlyAclExport(bytes.subarray(0, bytes.length - 1), sid), false, 'truncated UTF-16LE rejects');
  }
  for (const text of ['', 'file\r\n', `file\r\nD:P${allow}\r\nsecond\r\nD:P${allow}\r\n`, `\r\nD:P${allow}\r\n`]) assert.equal(ownerOnlyAclExport(Buffer.from(text), sid), false);
});

test('windows ACL check uses actual process identity despite spoofed account environment and rejects a foreign grant', { skip: process.platform !== 'win32', timeout: 30000 }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-acl-regression-'));
  const original = { USERDOMAIN: process.env.USERDOMAIN, USERNAME: process.env.USERNAME };
  const tool = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'icacls.exe');
  // Diagnostics are restricted to this disposable fixture. Never inspect a
  // production key, relay registration, token, or user-owned directory here.
  const diagnose = (target) => {
    const diagnostic = { target, spoofedDomain: process.env.USERDOMAIN, spoofedUser: process.env.USERNAME };
    const run = (binary, args) => {
      try { return { ok: true, stdout: execFileSync(binary, args, { encoding: 'utf8', windowsHide: true, timeout: 5000, maxBuffer: 65536 }) }; }
      catch (error) { return { ok: false, status: error.status, code: error.code, error: error.message, stdout: error.stdout?.toString(), stderr: error.stderr?.toString() }; }
    };
    diagnostic.whoami = run(path.join(path.dirname(tool), 'whoami.exe'), ['/user', '/fo', 'csv', '/nh']);
    diagnostic.sid = /"(S-1-[0-9-]+)"/.exec(diagnostic.whoami.stdout || '')?.[1] || null;
    diagnostic.display = run(tool, [target]);
    const exported = path.join(root, 'synthetic-diagnostic-acl.txt');
    diagnostic.exportCommand = run(tool, [target, '/save', exported, '/q']);
    try {
      const bytes = fs.readFileSync(exported);
      diagnostic.exportBytes = { length: bytes.length, hex: bytes.subarray(0, 8192).toString('hex'), utf16le: bytes.subarray(0, 8192).toString('utf16le'), utf8: bytes.subarray(0, 8192).toString('utf8') };
      diagnostic.parserResult = ownerOnlyAclExport(bytes, diagnostic.sid);
    } catch (error) { diagnostic.exportReadError = error.message; }
    finally { fs.rmSync(exported, { force: true }); }
    return JSON.stringify(diagnostic, null, 2);
  };
  const check = (target, expected, label) => {
    const actual = ownerOnly(target);
    assert.equal(actual, expected, actual === expected ? label : `${label}\n${diagnose(target)}`);
  };
  try {
    // Spoof before the first identity lookup, not just after its cache is warm.
    process.env.USERDOMAIN = 'NOT_THE_ACTUAL_DOMAIN'; process.env.USERNAME = 'not_the_actual_user';
    restrictToOwner(root);
    const file = path.join(root, '密钥 test key'); fs.writeFileSync(file, 'not a real secret');
    restrictToOwner(file);
    check(root, true, 'restricted synthetic directory must be owner-only');
    check(file, true, 'restricted synthetic file must be owner-only');
    execFileSync(tool, [file, '/grant', '*S-1-1-0:R'], { windowsHide: true });
    check(file, false, 'Everyone grant remains forbidden');
    // Exact restriction must remove explicit foreign grants as well as inherited ones.
    execFileSync(tool, [file, '/grant', '*S-1-5-32-544:F', '*S-1-5-18:F'], { windowsHide: true });
    restrictToOwner(file);
    check(file, true, 'restricted synthetic file must be owner-only');
    assert.equal(ownerOnly(path.join(root, 'missing')), false);
  } finally {
    for (const [key, value] of Object.entries(original)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    fs.rmSync(root, { recursive: true, force: true });
  }
});
