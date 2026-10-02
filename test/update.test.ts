import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareVersions } from '../src/update.js';

test('compareVersions orders dotted versions numerically', () => {
  assert.equal(compareVersions('0.1.1', '0.1.0'), 1);
  assert.equal(compareVersions('0.1.0', '0.1.1'), -1);
  assert.equal(compareVersions('0.10.0', '0.9.9'), 1);
  assert.equal(compareVersions('1.0', '1.0.0'), 0);
});
