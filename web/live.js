// Live WebSocket feed with auto-reconnect (exponential backoff 1 s → 30 s). Works in browsers and Node tests.
export const backoffDelay = (attempt) => Math.min(30000, 1000 * 2 ** attempt);

export function connectLive({ url, onMessage = () => {}, onStatus = () => {}, WebSocketImpl = globalThis.WebSocket }) {
  let ws = null;
  let attempt = 0;
  let stopId = null;
  let closed = false;
  let timer = null;

  const subscribe = () => {
    if (stopId != null && ws?.readyState === 1) ws.send(JSON.stringify({ subscribe: { stop_id: stopId } }));
  };

  function open() {
    ws = new WebSocketImpl(url);
    ws.onopen = () => {
      attempt = 0;
      onStatus('online');
      subscribe();
    };
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      onMessage(msg);
    };
    ws.onclose = () => {
      if (closed) return;
      onStatus('reconnecting');
      timer = setTimeout(open, backoffDelay(attempt++));
    };
    ws.onerror = () => {}; // onclose follows and handles the retry
  }

  open();
  return {
    setStop(id) { stopId = id; subscribe(); },
    close() { closed = true; clearTimeout(timer); ws?.close(); },
  };
}
