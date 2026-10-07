// The standalone page: makes the screen context that the suite would otherwise give, and mounts Chat.
// callTool posts to /api/tools/<name>; live events come over a WebSocket at /ws, with polling
// (chat.list_events) whenever the socket is not there; the path lives in the address after #.
import { mount } from './chat.mjs';

const listeners = new Set();
const emit = (e) => { for (const fn of listeners) { try { fn(e); } catch (err) { console.error(err); } } };

const ctx = {
  standalone: true,
  path: location.hash.replace(/^#/, '') || '/',
  async callTool(name, input = {}) {
    const r = await fetch(`/api/tools/${name}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input), credentials: 'same-origin' });
    let j = {};
    try { j = await r.json(); } catch {}
    if (r.status === 401) { location.href = `/login?next=${encodeURIComponent(location.pathname + location.hash)}`; throw new Error('Signed out'); }
    if (r.status === 202 && j.pending) return j;
    if (!r.ok || j.error) throw new Error(j.error?.message || 'Something went wrong. Try again.');
    return j.result;
  },
  on(name, fn) { listeners.add(fn); return () => listeners.delete(fn); },
  navigate(path, { replace = false } = {}) {
    if (replace) history.replaceState(null, '', `#${path}`);
    else location.hash = path;
  },
  toast() {},
};

const view = mount(document.getElementById('app'), ctx);
window.addEventListener('hashchange', () => { ctx.path = location.hash.replace(/^#/, '') || '/'; view.update(ctx.path); });

// Live: a WebSocket first; while it is down, ask for a resync every 3 seconds (the screen then reads
// chat.list_events from its cursor, so nothing is missed either way).
const live = {
  ws: null, poller: null, backoff: 1000,
  connect() {
    let ws;
    try { ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`); } catch { return this.poll(); }
    this.ws = ws;
    const giveUp = setTimeout(() => { if (ws.readyState !== 1) this.poll(); }, 5000);
    ws.onopen = () => { clearTimeout(giveUp); this.backoff = 1000; this.stop(); document.body.dataset.live = 'socket'; };
    ws.onmessage = (msg) => {
      let e;
      try { e = JSON.parse(msg.data); } catch { return; }
      if (e.type === 'hello') return emit({ type: 'resync' });
      if (e.type !== 'pong') emit(e);
    };
    ws.onclose = () => {
      clearTimeout(giveUp);
      this.poll();
      setTimeout(() => this.connect(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, 30000);
    };
  },
  poll() {
    if (this.poller) return;
    document.body.dataset.live = 'polling';
    this.poller = setInterval(() => emit({ type: 'resync' }), 3000);
  },
  stop() { clearInterval(this.poller); this.poller = null; },
};
live.connect();

// Mentions and direct messages as notifications, also with the tab closed (public/sw.js).
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
