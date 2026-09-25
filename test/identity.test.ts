import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { fallbackKey, folderForKey, homePathForKey, normalizeRemote } from '../src/identity.js';

test('ssh and https forms normalize to the same key', () => {
  const want = 'github.com/kazuna1/airhouse';
  for (const url of [
    'git@github.com:KaZuNa1/AirHouse.git',
    'https://github.com/kazuna1/airhouse',
    'https://github.com/KaZuNa1/AirHouse.git',
    'https://user:ghp_token@github.com/KaZuNa1/AirHouse.git',
    'ssh://git@github.com/KaZuNa1/AirHouse.git',
    'ssh://git@github.com:22/KaZuNa1/AirHouse.git',
    'https://github.com:443/KaZuNa1/AirHouse/',
    '  git@github.com:KaZuNa1/AirHouse.git\n',
  ]) {
    assert.equal(normalizeRemote(url), want, url);
  }
});

test('other hosts and nested groups', () => {
  assert.equal(normalizeRemote('git@gitlab.com:grp/sub/proj.git'), 'gitlab.com/grp/sub/proj');
  assert.equal(normalizeRemote('https://dev.azure.com/org/p/_git/repo'), 'dev.azure.com/org/p/_git/repo');
});

test('local path remotes', () => {
  assert.equal(normalizeRemote('C:\\tmp\\Test.git'), 'local/c/tmp/test');
  assert.equal(normalizeRemote('/srv/git/x.git'), 'local/srv/git/x');
  assert.equal(normalizeRemote('file:///srv/git/x.git'), 'local/srv/git/x');
});

test('folder names are filesystem safe', () => {
  assert.equal(folderForKey('github.com/kazuna1/airhouse'), 'github.com_kazuna1_airhouse');
  assert.equal(folderForKey('name/my notes'), 'name_my_notes');
});

test('fallback key uses the folder name outside home', () => {
  assert.equal(fallbackKey('X:\\work\\Notes\\', 'C:\\Users\\me'), 'name/notes');
  assert.equal(fallbackKey('/srv/Notes', '/home/me'), 'name/notes');
});

test('folders inside home are keyed relative to home, so different user names still match', () => {
  const sep = path.sep;
  const homeA = `${sep}users${sep}alice`;
  const homeB = `${sep}users${sep}bob`;
  const key = fallbackKey(path.join(homeA, 'Desktop', 'My Talk'), homeA);
  assert.equal(key, 'home/desktop/my talk');
  assert.equal(fallbackKey(homeA, homeA), 'home');
  assert.equal(homePathForKey(key, homeB), path.join(homeB, 'desktop', 'my talk'));
  assert.equal(homePathForKey('home', homeB), homeB);
  assert.equal(homePathForKey('github.com/x/y', homeB), null);
});
