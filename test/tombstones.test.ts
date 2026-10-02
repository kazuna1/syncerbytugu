import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { isSessionId, loadDeleted, markDeleted, removeLocalSession, removeRepoSession } from '../src/tombstones.js';
import { sessionInfo } from '../src/transcripts.js';

const ID = '96281218-31c9-46d1-b6ee-582070a92e86';
const OTHER = 'fd461cbf-7678-4668-8975-d6c4a7994dae';

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'syncerbytugu-test-'));
}

function touch(file: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{}\n');
}

test('only well-formed session ids are accepted', () => {
  assert.ok(isSessionId(ID));
  for (const bad of ['', '..', '../x', '*', 'abc', `${ID}/..`, `${ID}.jsonl`]) {
    assert.ok(!isSessionId(bad), bad);
    assert.throws(() => removeLocalSession(bad));
  }
});

test('markDeleted / loadDeleted round trip', () => {
  const repo = tmp();
  assert.deepEqual([...loadDeleted(repo)], []);
  markDeleted(repo, ID, 'work');
  assert.deepEqual([...loadDeleted(repo)], [ID]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(repo, 'deleted', `${ID}.json`), 'utf8')).by, 'work');
});

test('removeLocalSession removes every file of that session and nothing else', () => {
  const claude = tmp();
  process.env.SYNCERBYTUGU_CLAUDE_DIR = claude;
  try {
    const slug = path.join(claude, 'projects', 'D--code-slate');
    const other = path.join(claude, 'projects', 'C--Users-me');
    touch(path.join(slug, `${ID}.jsonl`));
    touch(path.join(slug, ID, 'subagents', 'agent-1.jsonl'));
    touch(path.join(slug, `${ID}.conflict-mac.jsonl`));
    touch(path.join(other, `${ID}.jsonl`)); // same session under a second folder
    touch(path.join(claude, 'file-history', ID, 'a@v1'));
    touch(path.join(claude, 'session-env', ID, 'x'));
    touch(path.join(slug, `${OTHER}.jsonl`));
    touch(path.join(slug, 'memory', 'MEMORY.md'));

    assert.equal(removeLocalSession(ID), 6);
    assert.deepEqual(fs.readdirSync(slug).sort(), [`${OTHER}.jsonl`, 'memory']);
    assert.deepEqual(fs.readdirSync(other), []);
    assert.ok(!fs.existsSync(path.join(claude, 'file-history', ID)));
    assert.equal(removeLocalSession(ID), 0, 'second run finds nothing');
  } finally {
    delete process.env.SYNCERBYTUGU_CLAUDE_DIR;
  }
});

test('removeRepoSession removes the session from every project folder', () => {
  const sessions = tmp();
  touch(path.join(sessions, 'github.com_x_slate', `${ID}.jsonl`));
  touch(path.join(sessions, 'github.com_x_slate', `${ID}.conflict-work.jsonl`));
  touch(path.join(sessions, 'github.com_x_slate', '.project.json'));
  touch(path.join(sessions, 'home', `${OTHER}.jsonl`));
  assert.equal(removeRepoSession(sessions, ID), 2);
  assert.deepEqual(fs.readdirSync(path.join(sessions, 'github.com_x_slate')), ['.project.json']);
  assert.deepEqual(fs.readdirSync(path.join(sessions, 'home')), [`${OTHER}.jsonl`]);
});

test('sessionInfo prefers /rename title, then Claude title, then first prompt', () => {
  const line = (o: object) => JSON.stringify(o) + '\n';
  const user = line({ type: 'user', message: { content: 'fix the "login" bug' }, timestamp: '2026-10-01T10:00:00.000Z' });
  const cmd = line({ type: 'user', message: { content: '<command-name>/clear</command-name>' } });
  const reply = line({ type: 'assistant', timestamp: '2026-10-01T10:05:00.000Z' });
  assert.deepEqual(sessionInfo(cmd + user + reply), { title: 'fix the "login" bug', updated: '2026-10-01T10:05:00.000Z' });
  const ai = line({ type: 'ai-title', aiTitle: 'Read MF file' });
  assert.equal(sessionInfo(user + ai + reply).title, 'Read MF file');
  const custom = line({ type: 'custom-title', customTitle: 'syncerbytugu' });
  assert.equal(sessionInfo(user + custom + ai + reply).title, 'syncerbytugu');
  assert.equal(sessionInfo('').title, '(untitled)');
});
