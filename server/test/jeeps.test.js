import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aclEntries } from '../src/jeeps.js';

test('aclEntries: server reads all, each jeep writes only its own topics', () => {
  assert.deepEqual(aclEntries([101, 102], 'jeeptrack-server'), [
    { user: 'jeeptrack-server', lines: ['topic read jeeptrack/v1/jeep/#'] },
    { user: 'jeep-101', lines: ['topic write jeeptrack/v1/jeep/101/#'] },
    { user: 'jeep-102', lines: ['topic write jeeptrack/v1/jeep/102/#'] },
  ]);
});

test('aclEntries rejects non-integer ids', () => {
  assert.throws(() => aclEntries(['101/#'], 'jeeptrack-server'));
});
