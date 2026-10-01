import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { TOKEN_ESC, TOKEN_FWD, detokenize, tokenize } from '../src/transform.js';
import { decide, mergeInto, pruneRedundantConflicts, readText } from '../src/transcripts.js';

// conversation lines carry a uuid; bookkeeping lines (title, mode, cost) don't
const a = '{"uuid":"1"}\n';
const b = '{"uuid":"2"}\n';
const c = '{"uuid":"3"}\n';
const meta = (k: string) => `{"type":"${k}"}\n`;

test('decide covers every case', () => {
  assert.equal(decide(a, null), 'write');
  assert.equal(decide(a + b, a), 'write');
  assert.equal(decide(a, a), 'same');
  assert.equal(decide(a, a + b), 'older');
  assert.equal(decide(a + b, a + c), 'conflict');
});

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'syncerbytugu-test-'));
}

test('mergeInto: newer overwrites, older and equal are skipped', () => {
  const dir = tmp();
  const f = path.join(dir, 's.jsonl');
  assert.equal(mergeInto(f, a, 'PC'), 'written');
  assert.equal(mergeInto(f, a + b, 'PC'), 'written');
  assert.equal(fs.readFileSync(f, 'utf8'), a + b);
  assert.equal(mergeInto(f, a, 'PC'), 'older');
  assert.equal(mergeInto(f, a + b, 'PC'), 'same');
  assert.equal(fs.readFileSync(f, 'utf8'), a + b);
});

test('mergeInto: diverged sessions produce a conflict file, never data loss', () => {
  const dir = tmp();
  const f = path.join(dir, 's.jsonl');
  fs.writeFileSync(f, a + b);
  assert.equal(mergeInto(f, a + c, 'OFFICE-PC'), 'conflict');
  assert.equal(fs.readFileSync(f, 'utf8'), a + b);
  assert.equal(fs.readFileSync(path.join(dir, 's.conflict-OFFICE-PC.jsonl'), 'utf8'), a + c);
  // the conflict copy itself keeps growing as that machine continues
  assert.equal(mergeInto(f, a + c + b, 'OFFICE-PC'), 'conflict');
  assert.equal(fs.readFileSync(path.join(dir, 's.conflict-OFFICE-PC.jsonl'), 'utf8'), a + c + b);
});

test('mergeInto compares in a shared space and writes in the destination space', () => {
  const dir = tmp();
  const f = path.join(dir, 's.jsonl');
  fs.writeFileSync(f, 'x:LOCAL\n');
  const res = mergeInto(
    f,
    'x:TOKEN\ny:TOKEN\n',
    'PC',
    (d) => d.replaceAll('LOCAL', 'TOKEN'),
    (s) => s.replaceAll('TOKEN', 'LOCAL'),
  );
  assert.equal(res, 'written');
  assert.equal(fs.readFileSync(f, 'utf8'), 'x:LOCAL\ny:LOCAL\n');
});

test('decide treats the escaped and forward-slash root tokens as the same', () => {
  const win = `{"cwd":"${TOKEN_ESC}"}\n`;
  const mac = `{"cwd":"${TOKEN_FWD}"}\n`;
  assert.equal(decide(mac, win), 'same');
  assert.equal(decide(mac + b, win), 'write');
  assert.equal(decide(mac, win + b), 'older');
});

test('copies that differ only in bookkeeping lines are not a conflict', () => {
  // the Mac opened the session (bookkeeping only) while Windows kept chatting
  const mac = a + meta('ai-title') + meta('cost-state');
  const win = a + meta('mode') + b;
  assert.equal(decide(win, mac), 'write');
  assert.equal(decide(mac, win), 'older');
  assert.equal(decide(a + meta('x'), a + meta('y')), 'same');
  // real messages on both sides are still a conflict
  assert.equal(decide(a + meta('x') + b, a + meta('y') + c), 'conflict');

  const dir = tmp();
  const f = path.join(dir, 's.jsonl');
  fs.writeFileSync(f, mac);
  assert.equal(mergeInto(f, win, 'work'), 'written');
  assert.equal(fs.readFileSync(f, 'utf8'), win);
  assert.deepEqual(fs.readdirSync(dir), ['s.jsonl']);
});

test('mergeInto appends only the new tail and keeps existing bytes', () => {
  const dir = tmp();
  const f = path.join(dir, 's.jsonl');
  const win = `{"cwd":"${TOKEN_ESC}"}\n`;
  fs.writeFileSync(f, win);
  assert.equal(mergeInto(f, `{"cwd":"${TOKEN_FWD}"}\n` + b, 'mac'), 'written');
  assert.equal(fs.readFileSync(f, 'utf8'), win + b);
});

test('a session survives Windows -> Mac -> Windows without false conflicts', () => {
  const winRoot = 'D:\\tugu programs\\code\\slate';
  const macRoot = '/Users/tugu/code/slate';
  const line = (o: object) => JSON.stringify(o) + '\n';
  const dir = tmp();
  const repoFile = path.join(dir, 'repo', 's.jsonl');
  const winFile = path.join(dir, 'win', 's.jsonl');
  const macFile = path.join(dir, 'mac', 's.jsonl');
  fs.mkdirSync(path.dirname(winFile), { recursive: true });
  const win = { tok: (s: string) => tokenize(s, winRoot, true), detok: (s: string) => detokenize(s, winRoot) };
  const mac = { tok: (s: string) => tokenize(s, macRoot, false), detok: (s: string) => detokenize(s, macRoot) };
  const push = (file: string, side: typeof win, who: string) => mergeInto(repoFile, side.tok(readText(file)), who);
  const pull = (file: string, side: typeof win) => mergeInto(file, readText(repoFile), 'remote', side.tok, side.detok);

  // Windows starts the session
  fs.writeFileSync(winFile, line({ cwd: winRoot, text: `edit ${winRoot}\\src\\a.ts` }));
  assert.equal(push(winFile, win, 'work'), 'written');
  assert.equal(pull(macFile, mac), 'written');
  assert.equal(push(macFile, mac, 'mac'), 'same', 'unchanged Mac copy is not a conflict');

  // Windows continues; the Mac picks it up
  fs.appendFileSync(winFile, line({ cwd: winRoot, text: 'yes' }));
  assert.equal(push(winFile, win, 'work'), 'written');
  const macBefore = readText(macFile);
  assert.equal(pull(macFile, mac), 'written');
  assert.ok(readText(macFile).startsWith(macBefore), 'Mac keeps its existing lines byte-for-byte');
  assert.ok(readText(macFile).endsWith(line({ cwd: macRoot, text: 'yes' })));

  // the Mac continues; Windows picks it up
  fs.appendFileSync(macFile, line({ cwd: macRoot, text: 'from mac' }));
  assert.equal(push(macFile, mac, 'mac'), 'written');
  const winBefore = readText(winFile);
  assert.equal(pull(winFile, win), 'written');
  assert.ok(readText(winFile).startsWith(winBefore), 'Windows keeps its existing lines byte-for-byte');
  assert.ok(readText(winFile).includes('from mac'));
  assert.ok(!readText(winFile).includes(macRoot), 'no Mac path leaks into the Windows copy');

  assert.deepEqual(fs.readdirSync(path.dirname(repoFile)), ['s.jsonl'], 'no conflict files');
  assert.deepEqual(fs.readdirSync(path.dirname(macFile)), ['s.jsonl'], 'no conflict files');
});

test('pruneRedundantConflicts removes only conflict copies the main file already contains', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 's.jsonl'), `{"cwd":"${TOKEN_ESC}"}\n` + b);
  fs.writeFileSync(path.join(dir, 's.conflict-mac.jsonl'), `{"cwd":"${TOKEN_FWD}"}\n`); // false conflict
  fs.writeFileSync(path.join(dir, 't.jsonl'), a + b);
  fs.writeFileSync(path.join(dir, 't.conflict-work.jsonl'), a + c); // real conflict
  assert.equal(pruneRedundantConflicts(dir), 1);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['s.jsonl', 't.conflict-work.jsonl', 't.jsonl']);
});
