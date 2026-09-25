import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TOKEN_ESC, TOKEN_FWD, detokenize, tokenize } from '../src/transform.js';

const ROOT = 'C:\\dev\\airhouse';
const line = (cwd: string, extra = '') => JSON.stringify({ cwd, text: extra }) + '\n';

test('round trip is byte-identical', () => {
  const original =
    line(ROOT, 'see C:/dev/airhouse/src/a.ts and C:\\dev\\airhouse\\b.ts') +
    '{"type":"x","cwd":"C:\\\\dev\\\\airhouse"}\r\n' +
    line('C:\\other', 'unrelated C:\\dev\\airhouse2\\x');
  const tok = tokenize(original, ROOT, true);
  assert.ok(!tok.includes('airhouse\\\\'), 'escaped root replaced');
  assert.equal(detokenize(tok, ROOT), original);
});

test('escaped and forward-slash forms use distinct tokens', () => {
  const s = '"C:\\\\dev\\\\airhouse\\\\x" "C:/dev/airhouse/y"';
  assert.equal(tokenize(s, ROOT, true), `"${TOKEN_ESC}\\\\x" "${TOKEN_FWD}/y"`);
});

test('only matches at a path boundary', () => {
  const root = 'C:\\dev\\air';
  const s = line('C:\\dev\\airhouse2') + line('C:\\dev\\air') + '"C:/dev/air/z"';
  const tok = tokenize(s, root, true);
  assert.ok(tok.includes('airhouse2'));
  assert.equal(tok.split(TOKEN_ESC).length - 1, 1);
  assert.equal(tok.split(TOKEN_FWD).length - 1, 1);
});

test('case-insensitive drive letters on Windows mode', () => {
  const s = line('d:\\Code\\App') + line('D:\\code\\app\\sub');
  const tok = tokenize(s, 'D:\\code\\app', true);
  assert.ok(!/code\\\\app/i.test(tok));
  assert.equal(detokenize(tok, 'E:\\work\\app'), line('E:\\work\\app') + line('E:\\work\\app\\sub'));
});

test('case-sensitive mode leaves other casing alone', () => {
  const s = '"/home/U/app" "/home/u/app/x"';
  assert.equal(tokenize(s, '/home/u/app', false), `"/home/U/app" "${TOKEN_FWD}/x"`);
});

test('pull to a different path on another PC', () => {
  const tok = tokenize(line(ROOT, 'C:/dev/airhouse/readme.md'), ROOT, true);
  assert.equal(detokenize(tok, 'D:\\code\\AirHouse'), line('D:\\code\\AirHouse', 'D:/code/AirHouse/readme.md'));
});

test('regex special characters in paths and $ in content are safe', () => {
  const root = 'C:\\Users\\me\\proj (1)+[x]';
  const s = line(root, 'cost $& $1 {{ROOT_ESC}}');
  assert.equal(detokenize(tokenize(s, root, true), root), s);
});

test('trailing separator on root is ignored', () => {
  const s = line(ROOT);
  assert.equal(tokenize(s, ROOT + '\\', true), tokenize(s, ROOT, true));
});
