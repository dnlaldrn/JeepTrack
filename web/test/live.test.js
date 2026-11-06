import { test } from 'node:test';
import assert from 'node:assert/strict';
import { backoffDelay, connectLive } from '../live.js';

test('backoff 1 s doubling, capped at 30 s', () => {
  assert.deepEqual([0, 1, 4, 5, 10].map(backoffDelay), [1000, 2000, 16000, 30000, 30000]);
});

class FakeWS {
  static instances = [];
  constructor(url) { this.url = url; this.sent = []; this.readyState = 0; FakeWS.instances.push(this); }
  send(m) { this.sent.push(m); }
  close() { this.readyState = 3; this.onclose?.(); }
  open() { this.readyState = 1; this.onopen?.(); }
  drop() { this.readyState = 3; this.onclose?.(); }
  message(obj) { this.onmessage?.({ data: JSON.stringify(obj) }); }
}

test('reconnects after close, reports status, re-sends subscription, delivers messages', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  FakeWS.instances = [];
  const statuses = [];
  const got = [];
  const live = connectLive({ url: 'ws://x/ws', WebSocketImpl: FakeWS, onStatus: (s) => statuses.push(s), onMessage: (m) => got.push(m) });
  live.setStop(7);
  FakeWS.instances[0].open();
  assert.deepEqual(FakeWS.instances[0].sent.map(JSON.parse), [{ subscribe: { stop_id: 7 } }]);
  FakeWS.instances[0].message({ type: 'pos', jeep_id: 1 });
  assert.deepEqual(got, [{ type: 'pos', jeep_id: 1 }]);

  FakeWS.instances[0].drop();
  assert.equal(statuses.at(-1), 'reconnecting');
  assert.equal(FakeWS.instances.length, 1);
  t.mock.timers.tick(1000);
  assert.equal(FakeWS.instances.length, 2, 'reconnected after 1 s');
  FakeWS.instances[1].drop();
  t.mock.timers.tick(1999);
  assert.equal(FakeWS.instances.length, 2, 'second retry waits 2 s');
  t.mock.timers.tick(1);
  assert.equal(FakeWS.instances.length, 3);
  FakeWS.instances[2].open();
  assert.equal(statuses.at(-1), 'online');
  assert.deepEqual(FakeWS.instances[2].sent.map(JSON.parse), [{ subscribe: { stop_id: 7 } }]);
  live.close();
  t.mock.timers.tick(60000);
  assert.equal(FakeWS.instances.length, 3, 'no reconnect after close()');
});

test('setStop while open sends immediately; bad message JSON is ignored', () => {
  FakeWS.instances = [];
  const got = [];
  const live = connectLive({ url: 'ws://x/ws', WebSocketImpl: FakeWS, onMessage: (m) => got.push(m) });
  FakeWS.instances[0].open();
  live.setStop(3);
  assert.deepEqual(FakeWS.instances[0].sent.map(JSON.parse), [{ subscribe: { stop_id: 3 } }]);
  FakeWS.instances[0].onmessage({ data: 'not json' });
  assert.equal(got.length, 0);
  live.close();
});
