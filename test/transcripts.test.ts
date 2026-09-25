import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { decide, mergeInto } from '../src/transcripts.js';

const a = '{"n":1}\n';
const b = '{"n":2}\n';
const c = '{"n":3}\n';

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
