// wOS Chat screens. Every piece of data comes from a tool (POST /api/tools/<name>), the same tools agents
// use over MCP. Every button, menu item and form names its tool in data-tool; buttons that only open,
// close or fill something on the page say so (data-open, data-close, data-copy, data-insert).
// It is the suite's screen part (CONTRACTS.md): mount(el, ctx) draws into el, ctx.callTool is the only way
// to the server and ctx.on brings live events. The standalone page (page.mjs) makes that ctx itself, with a
// WebSocket to /ws and polling when the socket is not there.

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const mobile = () => matchMedia('(max-width: 900px)').matches;
const coarse = () => matchMedia('(pointer: coarse)').matches;

const S = {
  me: null, people: [], channels: [], browse: null, settings: null,
  convos: new Map(), // channel id -> { channel, messages, more_before, last_read_id, at_latest }
  current: null, thread: null, cursor: 0, seen: new Set(), typing: new Map(), approvals: [],
  pending: [], threadPending: [], holdRead: new Set(), route: {},
};

// ---------- tools ----------

let CTX = null; // the screen context: callTool, on, path, navigate, toast; standalone or from the suite
let ROOT = null; // the element the app draws into

async function call(name, input = {}) {
  const r = await CTX.callTool(name, input);
  // A confirm: human tool asked by an app comes back as pending; a person's own click never does.
  if (r && r.pending && !('result' in r)) { toast(r.pending.message); return r; }
  return r;
}

async function upload(file) {
  const r = await fetch(`/files/chat?name=${encodeURIComponent(file.name)}`, { method: 'POST', headers: { 'content-type': file.type || 'application/octet-stream' }, body: file, credentials: 'same-origin' });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(j.error?.message || 'Upload failed.');
  return j.result;
}

// ---------- small pieces ----------

const P = {
  hash: '<path d="M5 9h14M5 15h14M10 4 8 20M16 4l-2 16"/>',
  lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4-4"/>',
  bell: '<path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>',
  bellOff: '<path d="M6 16V11a6 6 0 0 1 9.5-4.9M18 11v5l1.5 2H8"/><path d="M10 20.5a2 2 0 0 0 4 0M4 4l16 16"/>',
  at: '<circle cx="12" cy="12" r="3.5"/><path d="M15.5 12v1.5a2.5 2.5 0 0 0 5 0V12a8.5 8.5 0 1 0-3.3 6.7"/>',
  home: '<path d="M4 11 12 4l8 7v8.5a1.5 1.5 0 0 1-1.5 1.5H15v-6H9v6H5.5A1.5 1.5 0 0 1 4 19.5z"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 0 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 0 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 0 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 0 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z"/>',
  compose: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13.5 6.5 4 4"/>',
  smile: '<circle cx="12" cy="12" r="8.5"/><path d="M8.5 14a4 4 0 0 0 7 0M9 9.5h.01M15 9.5h.01"/>',
  reply: '<path d="M20 12.5c0 3.6-3.6 6.5-8 6.5-1 0-2-.1-2.8-.4L4.5 20l1.2-3.4C4.6 15.5 4 14.1 4 12.5 4 8.9 7.6 6 12 6s8 2.9 8 6.5z"/>',
  video: '<rect x="3" y="6" width="13" height="12" rx="2.5"/><path d="m16 10.5 5-3v9l-5-3"/>',
  more: '<circle cx="5.5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="18.5" cy="12" r="1.3"/>',
  clip: '<path d="m20 11.5-7.8 7.8a5 5 0 0 1-7-7l8.1-8.2a3.3 3.3 0 0 1 4.7 4.7l-8 8.1a1.7 1.7 0 0 1-2.4-2.4l7.4-7.4"/>',
  send: '<path d="M4 12 20 4l-6 16-3-7z"/><path d="m11 13 9-9"/>',
  back: '<path d="M15 5l-7 7 7 7"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  people: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M21.5 20a6.5 6.5 0 0 0-3.6-5.8"/>',
  file: '<path d="M14 3.5H7A2.5 2.5 0 0 0 4.5 6v12A2.5 2.5 0 0 0 7 20.5h10a2.5 2.5 0 0 0 2.5-2.5V9z"/><path d="M14 3.5V9h5.5"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  spark: '<path d="M12 3.5 13.8 10.2 20.5 12l-6.7 1.8L12 20.5l-1.8-6.7L3.5 12l6.7-1.8z"/>',
};
const ic = (n, s = 16) => `<svg class="ic" width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[n] ?? ''}</svg>`;
const tone = (s) => { let h = 0; for (const c of String(s ?? '')) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h % 6; };
const initials = (s) => String(s ?? '').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?';
const avatar = (p, cls = '') => p?.kind === 'agent'
  ? `<span class="ui-avatar is-square ${cls}" aria-hidden="true">${ic('spark', 14)}</span>`
  : `<span class="ui-avatar ${cls}" data-tone="${tone(p?.handle ?? p?.name)}" aria-hidden="true">${esc(initials(p?.name))}</span>`;
const person = (id) => S.people.find((p) => p.id === id);
const byHandle = (h) => S.people.find((p) => p.handle === h);
const chan = (id) => S.channels.find((c) => c.id === id) ?? S.browse?.find((c) => c.id === id) ?? S.convos.get(id)?.channel;
const isDm = (c) => c?.kind === 'dm' || c?.kind === 'group_dm';
const chanLabel = (c) => (isDm(c) ? c.name : `#${c.name}`);
const first = (name) => String(name ?? '').split(' ')[0];
const EMOJI = ['👍', '❤️', '😂', '🎉', '🙌', '👀', '✅', '🔥', '🙏', '💯', '🤔', '😮', '😢', '👏', '🚀', '⭐', '☕', '📞', '🦷', '📅', '💡', '✍️', '👋', '🆗'];

function fmtTime(iso) { return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); }
function dayLabel(iso) {
  const d = new Date(iso), t = new Date();
  const k = (x) => x.toDateString();
  if (k(d) === k(t)) return 'Today';
  const y = new Date(t); y.setDate(t.getDate() - 1);
  if (k(d) === k(y)) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric', ...(d.getFullYear() !== t.getFullYear() ? { year: 'numeric' } : {}) });
}
function ago(iso) {
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  const d = dayLabel(iso);
  return d === 'Yesterday' ? 'yesterday' : `on ${d}`;
}
const size = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`);

function toast(text) {
  const t = $('#toast');
  t.textContent = text;
  t.classList.add('is-on');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.classList.remove('is-on'), 3200);
}
const fail = (e) => toast(e.message || String(e));

// ---------- shell ----------

function applyTheme(theme) { if (CTX.standalone) document.documentElement.dataset.mode = theme || 'auto'; }

function renderShell() {
  const team = S.settings.team;
  ROOT.innerHTML = `
  <aside class="ui-side" aria-label="Channels">
    <div class="side-head"><a data-tool="none" data-why="moves to another screen" class="ui-brand" href="#/"><span class="mark">${ic('hash', 14)}</span><span>${esc(team.name)}</span></a>
      <button type="button" class="ui-btn is-ghost is-icon is-sm" data-open="new-dm" data-tool="none" data-why="opens the new message form" title="New message" aria-label="New message">${ic('compose')}</button></div>
    <a data-tool="none" data-why="moves to another screen" class="side-search" href="#/search">${ic('search', 15)}<span>Search</span><kbd class="ui-kbd">/</kbd></a>
    <nav class="side-scroll" id="side-list" aria-label="Channels and direct messages"></nav>
    <nav class="side-foot ui-side-nav" aria-label="More">
      <a data-tool="none" data-why="moves to another screen" href="#/activity" data-nav="activity">${ic('at')}<span>Activity</span><em id="act-count"></em></a>
      <a data-tool="none" data-why="moves to another screen" href="#/browse" data-nav="browse">${ic('hash')}<span>All channels</span></a>
      <a data-tool="none" data-why="moves to another screen" href="#/settings" data-nav="settings">${ic('gear')}<span>Settings</span></a>
    </nav>
    <a data-tool="none" data-why="moves to another screen" class="ui-side-me" href="#/settings" id="side-me"></a>
  </aside>
  <div class="ui-main">
    <header class="ui-topbar" id="topbar"></header>
    ${CTX.viewer ? viewerBar() : S.settings.team.demo ? demoBar() : ''}
    <div class="view" id="view"><div class="loading">Loading</div></div>
    <nav class="ui-dock" aria-label="Main">
      <a data-tool="none" data-why="moves to another screen" href="#/home" data-nav="home">${ic('home', 20)}<span>Home</span></a>
      <a data-tool="none" data-why="moves to another screen" href="#/activity" data-nav="activity">${ic('at', 20)}<span>Activity</span></a>
      <a data-tool="none" data-why="moves to another screen" href="#/search" data-nav="search">${ic('search', 20)}<span>Search</span></a>
      <a data-tool="none" data-why="moves to another screen" href="#/settings" data-nav="settings">${ic('gear', 20)}<span>You</span></a>
    </nav>
  </div>
  <div class="ui-toast" id="toast" role="status" aria-live="polite"></div>`;
  ROOT.removeAttribute('aria-busy');
  renderSide();
}

// The hosted copy, signed out: looking is free, the first press asks for an account.
function viewerBar() {
  return `<div class="demo-bar is-viewer"><span class="ui-chip is-outline">Example</span><span>Acme Dental is example data. Look around freely; sign in to post<span class="desk-only"> in a team chat of your own</span>.</span>
    <a class="ui-btn is-accent is-sm" data-tool="none" data-why="starts sign-in" href="/auth/waronsaas?next=%2F">Sign in</a></div>`;
}

function demoBar() {
  const people = S.people.filter((p) => p.kind === 'person');
  return `<div class="demo-bar"><span class="ui-chip is-outline">Demo</span><span class="desk-only">Acme Dental is example data. This copy is yours alone and resets after a day.</span>
    <span class="who">You are ${people.map((p) => `<a href="/demo/as/${esc(p.handle)}" ${p.id === S.me.id ? 'aria-current="true"' : ''}>${esc(first(p.name))}</a>`).join(' · ')}</span></div>`;
}

function channelLinks(list) {
  return list.map((c) => {
    const here = S.route.channel === c.id;
    const lead = isDm(c) ? (c.with?.length === 1 ? avatar(c.with[0]) : `<span class="hash">${ic('people', 14)}</span>`) : `<span class="hash">${c.kind === 'private' ? ic('lock', 13) : '#'}</span>`;
    const badge = c.mentions ? `<span class="ui-badge">${c.mentions}</span>` : '';
    return `<li><a data-tool="none" data-why="moves to another screen" href="#/c/${esc(c.id)}" class="${c.unread && !here ? 'is-unread' : ''}" ${here ? 'aria-current="page"' : ''}>${lead}<span class="nm">${esc(c.name)}</span>${badge}</a></li>`;
  }).join('');
}

function sideListHtml() {
  const rooms = S.channels.filter((c) => !isDm(c));
  const dms = S.channels.filter(isDm);
  return `<section class="side-sec"><div class="side-sec-h"><span>Channels</span><button type="button" class="ui-btn is-ghost is-icon is-sm" data-open="new-channel" data-tool="none" data-why="opens the new channel form" aria-label="Create a channel" title="Create a channel">${ic('plus', 14)}</button></div><ul class="chans">${channelLinks(rooms)}</ul></section>
    <section class="side-sec"><div class="side-sec-h"><span>Direct messages</span><button type="button" class="ui-btn is-ghost is-icon is-sm" data-open="new-dm" data-tool="none" data-why="opens the new message form" aria-label="New message" title="New message">${ic('plus', 14)}</button></div><ul class="chans">${channelLinks(dms)}</ul></section>`;
}

function renderSide() {
  const side = $('#side-list');
  if (side) side.innerHTML = sideListHtml();
  const home = $('#home-list');
  if (home) home.innerHTML = sideListHtml();
  const me = person(S.me.id) ?? S.me;
  $('#side-me').innerHTML = `${avatar(me, 'is-sm')}<span><b>${esc(me.name)}</b><small>${me.status ? `${esc(me.status.emoji)} ${esc(me.status.text)}` : 'Set a status'}</small></span>`;
  const n = S.approvals.length + S.channels.reduce((a, c) => a + (isDm(c) ? 0 : c.mentions), 0);
  $('#act-count').textContent = n ? String(n) : '';
  const total = S.channels.reduce((a, c) => a + c.mentions, 0);
  if (CTX.standalone) document.title = `${total ? `(${total}) ` : ''}${S.settings.team.name} · Chat`;
  if (CTX.standalone && 'setAppBadge' in navigator) (total ? navigator.setAppBadge(total) : navigator.clearAppBadge?.())?.catch?.(() => {});
  $$('[data-nav]').forEach((a) => (a.dataset.nav === S.route.view ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current')));
}

function topbar({ title = S.settings.team.name, back = null, extra = '' } = {}) {
  $('#topbar').innerHTML = `${back ? `<a class="ui-btn is-ghost is-icon" href="${back}" aria-label="Back">${ic('back', 18)}</a>` : `<a data-tool="none" data-why="moves to another screen" class="ui-brand" href="#/home"><span class="mark">${ic('hash', 14)}</span></a>`}<span class="tb-title">${title}</span>${extra}`;
}

// ---------- routing ----------

function parseRoute() {
  const h = String(CTX.path || '/').replace(/^#?\/?/, '');
  const [pathPart, query = ''] = h.split('?');
  const parts = pathPart.split('/').filter(Boolean).map(decodeURIComponent);
  const q = Object.fromEntries(new URLSearchParams(query));
  if (parts[0] === 'c' && parts[1]) return { view: 'convo', channel: parts[1], thread: parts[2] === 't' ? parts[3] : null, focus: parts[2] === 'm' ? parts[3] : null };
  if (['search', 'activity', 'settings', 'browse', 'home'].includes(parts[0])) return { view: parts[0], q };
  return { view: 'start' };
}

// A slower screen must never draw over a newer one: each route has a number, and stale ones stop.
let routeSeq = 0;
const stale = (n) => n !== routeSeq;

async function route() {
  routeSeq++;
  lastRouted = CTX.path;
  const r = parseRoute();
  closePops();
  if (r.view === 'start') {
    if (mobile()) return go('#/home', true);
    let last = null;
    try { last = localStorage.getItem('chat.last'); } catch {}
    const c = S.channels.find((x) => x.id === last) ?? S.channels.find((x) => x.name === 'general') ?? S.channels[0];
    return c ? go(`#/c/${c.id}`, true) : go('#/browse', true);
  }
  if (r.view === 'home' && !mobile()) return go('#/', true);
  S.route = r;
  renderSide();
  const view = $('#view');
  view.className = `view${r.view === 'convo' ? ' is-convo' : ''}`;
  try {
    if (r.view === 'convo') await showConvo(r);
    else { S.current = null; S.thread = null; await ({ search: showSearch, activity: showActivity, settings: showSettings, browse: showBrowse, home: showHome })[r.view](r); }
  } catch (e) {
    view.innerHTML = `<div class="loading">${esc(e.message)}</div>`;
  }
}
// Paths look like /c/<channel>/t/<thread>. Links in the page are written #/c/..., which the standalone page
// uses as they are; inside the suite, clicks on them become ctx.navigate.
let lastRouted = null;
function go(hash, replace = false) {
  const path = hash.replace(/^#/, '') || '/';
  CTX.navigate(path, { replace });
  if (!CTX.standalone || replace) { CTX.path = path; route(); }
}

// ---------- a conversation ----------

async function loadConvo(id, { focus } = {}) {
  let cv = S.convos.get(id);
  if (focus) {
    const [older, newer] = await Promise.all([call('chat.read_messages', { channel: id, before: `${focus}~`, limit: 25 }), call('chat.read_messages', { channel: id, after: focus, limit: 30 })]);
    cv = { ...(cv ?? {}), channel: older.channel, messages: [...older.messages, ...newer.messages], more_before: older.more_before, last_read_id: older.last_read_id, at_latest: newer.messages.length < 30 };
  } else if (!cv || !cv.at_latest) {
    const r = await call('chat.read_messages', { channel: id, limit: 50 });
    cv = { ...(cv ?? {}), channel: r.channel, messages: r.messages, more_before: r.more_before, last_read_id: r.last_read_id, at_latest: true };
  }
  if (!cv.info || cv.infoStale) { cv.info = await call('chat.get_channel', { channel: id }); cv.infoStale = false; }
  S.convos.set(id, cv);
  return cv;
}

async function showConvo(r) {
  const prevChannel = S.current;
  S.current = r.channel;
  const n = routeSeq;
  const cv = await loadConvo(r.channel, { focus: r.focus });
  if (stale(n)) return;
  const info = cv.info;
  try { localStorage.setItem('chat.last', r.channel); } catch {}
  // Where the "new" line goes: what was unread when you opened the channel.
  if (prevChannel !== r.channel || cv.newFrom === undefined) cv.newFrom = info.member && info.unread ? cv.last_read_id ?? '' : null;
  const title = isDm(info) ? esc(info.name) : `${info.kind === 'private' ? ic('lock', 14) : '#'}${esc(info.name)}`;
  topbar({ title: `${title}<small>${esc(info.topic || (isDm(info) ? dmSubtitle(info) : ''))}</small>`, back: '#/home', extra: `<button type="button" class="ui-btn is-ghost is-icon" data-open="channel-menu" data-tool="none" data-why="opens the channel menu" data-channel="${esc(info.id)}" aria-label="Channel options">${ic('more', 18)}</button>` });
  const view = $('#view');
  view.innerHTML = `<section class="convo" aria-label="${esc(chanLabel(info))}">
    <header class="convo-h">
      <div class="t"><h1>${title}${info.archived ? ' <span class="ui-chip is-outline">Archived</span>' : ''}</h1><p class="topic">${esc(info.topic || (isDm(info) ? dmSubtitle(info) : 'No topic yet'))}</p></div>
      <div class="acts">
        ${S.meet && !info.archived && info.member ? `<button type="button" class="ui-btn is-ghost is-sm" data-tool="meet.huddle" data-channel="${esc(info.id)}" aria-label="Start a call" title="Start a call">${ic('video')}<span class="hide-sm">Call</span></button>` : ''}
        <button type="button" class="ui-btn is-ghost is-sm hide-sm" data-open="members" data-tool="none" data-why="shows who is in the channel" data-channel="${esc(info.id)}" aria-label="People in this channel"><span class="ui-avatars">${info.members.slice(0, 3).map((m) => avatar(m, 'is-xs')).join('')}</span>${info.members.length}</button>
        <button type="button" class="ui-btn is-ghost is-icon is-sm hide-sm" data-open="notify-menu" data-tool="none" data-why="opens the notification menu" data-channel="${esc(info.id)}" aria-label="Notifications" title="Notifications: ${esc(notifyLabel(info.notify))}">${ic(info.notify === 'none' ? 'bellOff' : 'bell')}</button>
        <button type="button" class="ui-btn is-ghost is-icon is-sm hide-sm" data-open="channel-menu" data-tool="none" data-why="opens the channel menu" data-channel="${esc(info.id)}" aria-label="Channel options">${ic('more')}</button>
      </div>
    </header>
    <div class="stream" id="stream" tabindex="-1"></div>
    <div class="typing" id="typing" aria-live="polite"></div>
    ${composerHtml(info, null)}
  </section>${r.thread ? '<aside class="thread" id="thread" aria-label="Thread"></aside>' : ''}`;
  renderStream(r.focus);
  if (r.thread) await showThread(r.channel, r.thread);
  else S.thread = null;
  renderTyping();
  if (!coarse() && !r.thread) $('#composer textarea')?.focus({ preventScroll: true });
  maybeMarkRead();
}

function dmSubtitle(info) {
  const others = info.members.filter((m) => m.id !== S.me.id);
  if (others.length === 1 && others[0].kind === 'agent') {
    const a = person(others[0].id);
    return a?.agent?.example ? 'Example agent: fixed answers, no AI model' : 'AI agent';
  }
  const p = others.length === 1 ? person(others[0].id) : null;
  return p?.status ? `${p.status.emoji} ${p.status.text}` : `Direct message${others.length > 1 ? ` with ${others.length} people` : ''}`;
}

const notifyLabel = (n) => ({ all: 'every message', mentions: 'mentions only', none: 'nothing', default: 'your usual rule' })[n ?? 'default'] ?? 'your usual rule';

function composerHtml(info, root) {
  if (info.archived) return '<p class="archived-note">This channel is archived. You can read it, but not post.</p>';
  if (!info.member && !isDm(info)) return `<p class="archived-note">You are reading #${esc(info.name)}. <button type="button" class="ui-btn is-accent is-sm" data-tool="chat.join_channel" data-channel="${esc(info.id)}">Join channel</button></p>`;
  const where = root ? 'Reply' : isDm(info) ? `Message ${esc(info.name)}` : `Message #${esc(info.name)}`;
  const pend = root ? S.threadPending : S.pending;
  return `<form class="composer" id="${root ? 'thread-composer' : 'composer'}" data-tool="${root ? 'chat.post_reply' : 'chat.post_message'}" data-channel="${esc(info.id)}" ${root ? `data-message="${esc(root)}"` : ''} autocomplete="off">
    <div class="pending-files">${pend.map((f) => `<span class="file-chip">${ic('file', 14)}${esc(f.name)} <small>${size(f.size)}</small><button type="button" class="ui-btn is-ghost is-icon is-sm" data-tool="none" data-why="takes the file off before sending" data-unpend="${esc(f.id)}" data-close data-tool="none" data-why="closes this without changing anything" aria-label="Remove file">${ic('x', 13)}</button></span>`).join('')}</div>
    <label class="sr" for="${root ? 'tc' : 'mc'}">${where}</label>
    <textarea id="${root ? 'tc' : 'mc'}" name="body" rows="1" placeholder="${where}" enterkeyhint="send"></textarea>
    <div class="composer-bar">
      <label class="attach" title="Attach a file"><input type="file" multiple data-tool="chat.upload_file" aria-label="Attach a file">${ic('clip', 17)}</label>
      <button type="button" class="ui-btn is-ghost is-icon is-sm" data-open="emoji-insert" data-tool="none" data-why="opens the emoji picker" aria-label="Add an emoji">${ic('smile', 17)}</button>
      ${root ? '' : '<span class="hint">Enter to send, Shift+Enter for a new line. @ to mention.</span>'}<span class="grow"></span>
      <button type="submit" class="ui-btn is-accent is-sm" data-tool="${root ? 'chat.post_reply' : 'chat.post_message'}" aria-label="Send">${ic('send', 15)}</button>
    </div>
  </form>`;
}

function messageHtml(m, { prev, inThread = false, focus = null } = {}) {
  const me = S.me;
  const cont = prev && !prev.deleted && !m.deleted && prev.author.id === m.author.id && Date.parse(m.created_at) - Date.parse(prev.created_at) < 5 * 60000 && !prev.reply_count;
  const mentionMe = !m.mine && (m.html.includes(`data-handle="${me.handle}"`) || /data-handle="(channel|here|everyone)"/.test(m.html));
  const html = m.html.replaceAll(`class="mention" data-handle="${me.handle}"`, `class="mention is-me" data-handle="${me.handle}"`);
  const files = m.files.map((f) => (/^image\//.test(f.type) ? `<a href="${esc(f.url)}" target="_blank" rel="noopener"><img src="${esc(f.url)}" alt="${esc(f.name)}" loading="lazy"></a>` : `<a class="file-chip" href="${esc(f.url)}" download>${ic('file', 15)}<span>${esc(f.name)}</span><small>${size(f.size)}</small></a>`)).join('');
  const rxs = m.reactions.map((r) => `<button type="button" class="rx${r.mine ? ' is-mine' : ''}" data-tool="${r.mine ? 'chat.remove_reaction' : 'chat.add_reaction'}" data-message="${esc(m.id)}" data-emoji="${esc(r.emoji)}" title="${esc(r.people.map((h) => `@${h}`).join(', '))}" aria-pressed="${r.mine}">${esc(r.emoji)} ${r.count}</button>`).join('');
  const label = m.author.kind === 'agent' ? `<span class="ui-chip is-outline">${m.author.example ? 'Example agent' : 'Agent'}</span>` : '';
  return `<article class="msg${cont ? ' is-cont' : ''}${m.author.kind === 'agent' ? ' is-agent' : ''}${mentionMe ? ' is-mention' : ''}${focus === m.id ? ' is-hit' : ''}" id="m-${esc(m.id)}" data-id="${esc(m.id)}" data-channel="${esc(m.channel)}" tabindex="-1">
    ${avatar(m.author)}
    <div class="msg-b">
      <header class="msg-h"><b>${esc(m.author.name)}</b>${label}<time datetime="${esc(m.created_at)}" title="${esc(new Date(m.created_at).toLocaleString())}">${fmtTime(m.created_at)}</time>${m.edited_at ? '<span class="ed">(edited)</span>' : ''}</header>
      ${m.deleted ? '<div class="msg-text msg-gone">This message was deleted.</div>' : `<div class="msg-text">${html}</div>`}
      ${files ? `<div class="msg-files">${files}</div>` : ''}
      ${rxs || (!m.deleted && m.reactions.length) ? `<div class="rxs">${rxs}<button type="button" class="rx rx-add" data-open="emoji" data-tool="none" data-why="opens the reaction picker" data-message="${esc(m.id)}" aria-label="Add a reaction">${ic('smile', 14)}</button></div>` : ''}
      ${!inThread && m.reply_count ? `<button type="button" class="msg-thread" data-tool="chat.read_messages" data-thread="${esc(m.id)}" data-channel="${esc(m.channel)}"><b>${m.reply_count} ${m.reply_count === 1 ? 'reply' : 'replies'}</b><span>Last reply ${ago(m.last_reply_at ?? m.created_at)}</span></button>` : ''}
    </div>
    ${m.deleted ? '' : `<div class="msg-acts" role="toolbar" aria-label="Message actions">
      <button type="button" class="ui-btn is-ghost is-sm" data-open="emoji" data-tool="none" data-why="opens the reaction picker" data-message="${esc(m.id)}" aria-label="Add a reaction" title="React">${ic('smile')}</button>
      ${inThread ? '' : `<button type="button" class="ui-btn is-ghost is-sm" data-tool="chat.read_messages" data-thread="${esc(m.id)}" data-channel="${esc(m.channel)}" aria-label="Reply in thread" title="Reply in thread">${ic('reply')}</button>`}
      <button type="button" class="ui-btn is-ghost is-sm" data-open="msg-menu" data-tool="none" data-why="opens the message menu" data-message="${esc(m.id)}" aria-label="More actions" title="More">${ic('more')}</button>
    </div>`}
  </article>`;
}

function renderStream(focus = null) {
  const el = $('#stream');
  const cv = S.convos.get(S.current);
  if (!el || !cv) return;
  const info = cv.info;
  const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  let out = '';
  if (cv.more_before) out += `<div class="older"><button type="button" class="ui-btn is-quiet is-sm" data-tool="chat.read_messages" data-before="${esc(cv.messages[0]?.id ?? '')}" data-channel="${esc(info.id)}">Show older messages</button></div>`;
  else out += `<div class="stream-start"><h2>${isDm(info) ? esc(info.name) : `${info.kind === 'private' ? '' : '#'}${esc(info.name)}`}</h2><p>${isDm(info) ? 'This is the start of your direct message.' : `This is the very beginning of ${info.kind === 'private' ? 'the private channel' : ''} #${esc(info.name)}.${info.topic ? ` ${esc(info.topic)}.` : ''}`}</p></div>`;
  let prev = null, lastDay = '', newDone = false;
  for (const m of cv.messages) {
    const day = new Date(m.created_at).toDateString();
    if (day !== lastDay) { out += `<div class="day" role="separator">${esc(dayLabel(m.created_at))}</div>`; lastDay = day; prev = null; }
    if (!newDone && cv.newFrom !== null && cv.newFrom !== undefined && m.id > cv.newFrom && !m.mine) { out += '<div class="new-line" role="separator" id="new-line">New</div>'; newDone = true; prev = null; }
    out += messageHtml(m, { prev, focus });
    prev = m;
  }
  if (!cv.at_latest) out += `<div class="older"><button type="button" class="ui-btn is-quiet is-sm" data-tool="chat.read_messages" data-latest data-channel="${esc(info.id)}">Jump to the latest</button></div>`;
  el.innerHTML = out;
  if (focus) $(`#m-${CSS.escape(focus)}`)?.scrollIntoView({ block: 'center' });
  else if (newDone && !renderStream.done?.has(S.current)) { $('#new-line').scrollIntoView({ block: 'center' }); (renderStream.done ??= new Set()).add(S.current); }
  else if (nearBottom || !renderStream.done?.has(S.current)) { el.scrollTop = el.scrollHeight; (renderStream.done ??= new Set()).add(S.current); }
}

async function showThread(channel, rootId) {
  const n = routeSeq;
  const r = await call('chat.read_messages', { thread: rootId });
  if (stale(n) || !$('#thread')) return;
  // The thread's own channel decides the header, whatever the address said.
  channel = r.channel.id;
  S.thread = { channel, root: r.thread, messages: r.messages };
  const cv = S.convos.get(channel);
  const pane = $('#thread');
  pane.innerHTML = `<header class="convo-h"><a data-tool="none" data-why="moves to another screen" class="ui-btn is-ghost is-icon is-sm home-only" href="#/c/${esc(channel)}" aria-label="Back to the channel">${ic('back', 18)}</a><div class="t"><h1>Thread</h1><p class="topic">${esc(chanLabel(cv?.info ?? r.channel))}</p></div><a data-tool="none" data-why="moves to another screen" class="ui-btn is-ghost is-icon is-sm desk-only" href="#/c/${esc(channel)}" aria-label="Close the thread">${ic('x', 17)}</a></header>
    <div class="stream" id="thread-stream"></div><div class="typing" id="thread-typing" aria-live="polite"></div>${composerHtml(cv?.info ?? { id: channel, member: true }, r.thread)}`;
  renderThread();
  if (!coarse()) $('#thread-composer textarea')?.focus({ preventScroll: true });
}

function renderThread() {
  const el = $('#thread-stream');
  if (!el || !S.thread) return;
  const [root, ...replies] = S.thread.messages;
  el.innerHTML = messageHtml(root, { inThread: true }) + (replies.length ? `<div class="thread-count">${replies.length} ${replies.length === 1 ? 'reply' : 'replies'}</div>` : '') + replies.map((m, i) => messageHtml(m, { prev: replies[i - 1], inThread: true })).join('');
  el.scrollTop = el.scrollHeight;
}

function renderTyping() {
  const now = Date.now();
  for (const [k, v] of S.typing) if (v.until < now) S.typing.delete(k);
  const line = (thread) => {
    const who = [...S.typing.values()].filter((t) => t.channel === S.current && (t.thread ?? null) === thread && t.id !== S.me.id);
    if (!who.length) return '';
    const names = who.map((t) => first(t.name));
    const verb = who.every((t) => t.agent) ? 'thinking' : 'typing';
    return `${esc(names.join(', '))} ${names.length > 1 ? 'are' : 'is'} ${verb}<span class="dots"></span>`;
  };
  const a = $('#typing'); if (a) a.innerHTML = line(null);
  const b = $('#thread-typing'); if (b) b.innerHTML = S.thread ? line(S.thread.root) : '';
}

let readTimer = null;
function maybeMarkRead() {
  clearTimeout(readTimer);
  readTimer = setTimeout(async () => {
    const id = S.current;
    const c = S.channels.find((x) => x.id === id);
    if (!id || !c || document.hidden || S.holdRead.has(id) || CTX.viewer) return;
    const cv = S.convos.get(id);
    if (!cv?.at_latest) return;
    const lastOther = [...cv.messages].reverse().find((m) => !m.mine)?.id;
    if (!c.unread && !(lastOther && (!c.last_read_id || lastOther > c.last_read_id))) return;
    try { applyRead(await call('chat.mark_read', { channel: id })); } catch {}
  }, 600);
}

function applyRead(d) {
  const c = S.channels.find((x) => x.id === d.channel);
  if (c) { c.unread = d.unread; c.mentions = d.mentions; c.last_read_id = d.last_read_id; }
  renderSide();
}

// ---------- other screens ----------

async function showHome() {
  topbar({ title: esc(S.settings.team.name) });
  $('#view').innerHTML = `<div class="panel-page"><nav class="home-list" aria-label="Channels and direct messages"><a data-tool="none" data-why="moves to another screen" class="side-search" href="#/search">${ic('search', 15)}<span>Search</span></a><div id="home-list"></div>
    <div class="side-foot ui-side-nav"><a data-tool="none" data-why="moves to another screen" href="#/browse">${ic('hash')}<span>All channels</span></a></div></nav></div>`;
  renderSide();
}

async function showSearch(r) {
  topbar({ title: 'Search' });
  const q = r.q?.q ?? '';
  $('#view').innerHTML = `<div class="panel-page"><div class="ui-page"><div class="ui-ph"><div><h1>Search</h1><p>Every channel you can see. Try in:#marketing or from:@jordan.</p></div></div>
    <form class="search-form" data-tool="chat.search_messages" role="search"><label class="ui-search">${ic('search', 15)}<input name="q" value="${esc(q)}" placeholder="Search messages" aria-label="Search messages" enterkeyhint="search"></label><button data-tool="chat.search_messages" class="ui-btn is-accent" type="submit">Search</button></form>
    <div id="results"></div></div></div>`;
  if (!coarse()) $('.search-form input').focus();
  if (q) await runSearch(q);
}

async function runSearch(q) {
  const box = $('#results');
  box.innerHTML = '<p class="mute">Searching</p>';
  try {
    const r = await call('chat.search_messages', { q });
    box.innerHTML = r.results.length ? `<ul class="list">${r.results.map((m) => `<li><a data-tool="none" data-why="moves to another screen" class="hit" href="#/c/${esc(m.channel)}${m.thread_root ? `/t/${esc(m.thread_root)}` : `/m/${esc(m.id)}`}"><div class="msg"><span class="where">${esc(m.channel_name && !m.channel.startsWith('d_') ? `#${m.channel_name}` : m.channel_name)}${m.thread_root ? ' · in a thread' : ''} · ${esc(dayLabel(m.created_at))}</span>${messageInner(m)}</div></a></li>`).join('')}</ul>` : `<p class="empty-note">Nothing matches "${esc(q)}".</p>`;
  } catch (e) { box.innerHTML = `<p class="empty-note">${esc(e.message)}</p>`; }
}

function messageInner(m) {
  return `<div class="msg-h"><b>${esc(m.author.name)}</b><time>${fmtTime(m.created_at)}</time></div><div class="msg-text">${m.html}</div>`;
}

async function showActivity() {
  topbar({ title: 'Activity' });
  const n = routeSeq;
  const [mentions, approvals] = await Promise.all([call('chat.list_mentions', { limit: 40 }), call('chat.list_approvals')]);
  if (stale(n)) return;
  S.approvals = approvals.approvals;
  renderSide();
  $('#view').innerHTML = `<div class="panel-page"><div class="ui-page"><div class="ui-ph"><div><h1>Activity</h1><p>Messages that mention you, and anything an agent is waiting on you for.</p></div></div>
    ${S.approvals.length ? `<section class="sect"><h2>Waiting for your yes</h2><p>An app connected to your account asked to do these. Nothing happens until you say yes.</p><ul class="list">${S.approvals.map((a) => `<li class="row"><div class="grow"><b>${esc(a.title)}</b><small>Asked by ${esc(a.requested_by)} · ${esc(JSON.stringify(a.input))}</small></div><button type="button" class="ui-btn is-quiet is-sm" data-tool="chat.decide_approval" data-approval="${esc(a.id)}" data-approve="false">Decline</button><button type="button" class="ui-btn is-accent is-sm" data-tool="chat.decide_approval" data-approval="${esc(a.id)}" data-approve="true">Approve</button></li>`).join('')}</ul></section>` : ''}
    <section class="sect"><h2>Mentions</h2>${mentions.results.length ? `<ul class="list">${mentions.results.map((m) => `<li><a data-tool="none" data-why="moves to another screen" class="hit" href="#/c/${esc(m.channel)}${m.thread_root ? `/t/${esc(m.thread_root)}` : `/m/${esc(m.id)}`}"><div class="msg"><span class="where">${esc(m.channel_name && !m.channel.startsWith('d_') ? `#${m.channel_name}` : m.channel_name)} · ${esc(ago(m.created_at))}</span>${messageInner(m)}</div></a></li>`).join('')}</ul>` : '<p class="empty-note">No mentions yet.</p>'}</section>
  </div></div>`;
}

async function showBrowse() {
  topbar({ title: 'All channels' });
  const n = routeSeq;
  S.browse = (await call('chat.list_channels', { browse: true, include_archived: true })).channels.filter((c) => !isDm(c));
  if (stale(n)) return;
  $('#view').innerHTML = `<div class="panel-page"><div class="ui-page"><div class="ui-ph"><div><h1>All channels</h1><p>Public channels anyone on the team can join, and private ones you are in.</p></div><button type="button" class="ui-btn is-accent" data-open="new-channel" data-tool="none" data-why="opens the new channel form">${ic('plus', 15)} Create a channel</button></div>
    <ul class="list">${S.browse.map((c) => `<li class="row"><span class="hash">${c.kind === 'private' ? ic('lock', 14) : '#'}</span><div class="grow"><a data-tool="none" data-why="moves to another screen" href="#/c/${esc(c.id)}"><b>${esc(c.name)}</b></a>${c.archived ? ' <span class="ui-chip is-outline">Archived</span>' : ''}<small>${c.member_count} ${c.member_count === 1 ? 'member' : 'members'}${c.topic ? ` · ${esc(c.topic)}` : ''}</small></div>${c.member ? '<span class="ui-chip is-soft">Joined</span>' : c.archived ? '' : `<button type="button" class="ui-btn is-quiet is-sm" data-tool="chat.join_channel" data-channel="${esc(c.id)}">Join</button>`}</li>`).join('')}</ul></div></div>`;
}

async function showSettings() {
  topbar({ title: 'Settings' });
  const n = routeSeq;
  const s = S.settings = await call('chat.get_settings');
  if (stale(n)) return;
  const admin = ['owner', 'admin'].includes(s.me.role);
  const me = person(S.me.id) ?? S.me;
  const seg = (tool, field, value, options) => `<div class="ui-seg" role="group">${options.map(([v, l]) => `<button type="button" data-tool="${tool}" data-${field}="${v}" aria-pressed="${v === value}">${l}</button>`).join('')}</div>`;
  const pushSupported = 'serviceWorker' in navigator && 'PushManager' in window;
  const host = location.origin;
  $('#view').innerHTML = `<div class="panel-page"><div class="ui-page"><div class="ui-ph"><div><h1>Settings</h1><p>${esc(me.name)} · @${esc(me.handle)}</p></div>${CTX.viewer ? '<a class="ui-btn is-accent" data-tool="none" data-why="starts sign-in" href="/auth/waronsaas?next=%2F%23%2Fsettings">Sign in</a>' : s.team.demo ? '' : '<a class="ui-btn is-quiet" href="/logout">Sign out</a>'}</div>
    <section class="sect"><h2>Status</h2><p>What people see next to your name.</p>
      <form class="inline-form" data-tool="chat.set_status"><label class="ui-field" style="max-width:110px;min-width:80px"><span>Emoji</span><input class="ui-input" name="emoji" value="${esc(me.status?.emoji ?? '')}" maxlength="16" placeholder="📅"></label><label class="ui-field"><span>Status</span><input class="ui-input" name="text" value="${esc(me.status?.text ?? '')}" maxlength="100" placeholder="In meetings till 3"></label><button data-tool="chat.set_status" class="ui-btn is-accent" type="submit">Save</button></form></section>
    <section class="sect"><h2>Notifications</h2><p>Your usual rule for every channel. Each channel can have its own from its bell. Direct messages and replies to your threads always count.</p>
      ${seg('chat.set_notify', 'level', s.prefs.notify, [['all', 'Every message'], ['mentions', 'Mentions'], ['none', 'Nothing']])}
      <p style="margin-top:14px">${pushSupported ? (s.push.devices ? `Notifications are on for ${s.push.devices} ${s.push.devices === 1 ? 'device' : 'devices'}. ` : 'Get mentions and direct messages on this device, even with the tab closed. ') : 'This browser cannot show notifications. On an iPhone, add this page to your home screen first.'}</p>
      ${pushSupported ? `<button type="button" class="ui-btn is-quiet" data-tool="chat.subscribe_push">Turn on for this device</button> ${s.push.devices ? '<button type="button" class="ui-btn is-ghost" data-tool="chat.unsubscribe_push">Turn off everywhere</button>' : ''}` : ''}
      <form class="inline-form" data-tool="chat.set_preferences" style="margin-top:16px"><label class="ui-field"><span>Keywords <small>words that notify you in any channel you are in, comma separated</small></span><input class="ui-input" name="keywords" value="${esc((s.prefs.keywords ?? []).join(', '))}" placeholder="invoice, x-ray"></label><button data-tool="chat.set_preferences" class="ui-btn is-quiet" type="submit">Save keywords</button></form></section>
    <section class="sect"><h2>Look</h2>${seg('chat.set_preferences', 'theme', s.prefs.theme, [['auto', 'Match my device'], ['light', 'Light'], ['dark', 'Dark']])}</section>
    ${admin ? await teamSection() : ''}
    <section class="sect"><h2>Connect an assistant</h2><p>Claude, ChatGPT, Claude Code, Codex or any MCP app can read and post here as you, with the same tools as this screen. Add this address as a connector and sign in.</p>
      <div class="codebox"><code>${esc(host)}/mcp</code><button type="button" class="ui-btn is-ghost is-sm" data-tool="none" data-why="copies the address" data-copy="${esc(host)}/mcp">Copy</button></div>
      <p class="mute" style="margin-top:8px;font-size:12.5px">Apps that do not allow dots in tool names can use ${esc(host)}/mcp?names=underscore. The full tool list is at <a href="/tools.json">/tools.json</a>.</p></section>
    <section class="sect"><h2>Your data</h2><p>Download everything: every channel, message, reaction, file and person, in the same layout as a Slack export, so you can move again any time.</p>
      ${admin ? '<button type="button" class="ui-btn is-quiet" data-tool="chat.export_data">Export everything</button> <span id="export-out"></span>' : '<p class="mute">Team owners and admins can export.</p>'}
      ${admin ? `<form class="inline-form" data-tool="chat.import_slack" style="margin-top:16px"><label class="ui-field"><span>Coming from Slack? <small>Check what your Slack export holds. Bringing it in arrives in the next version.</small></span><input class="ui-input" type="file" name="file" accept=".zip,application/zip" required></label><button data-tool="chat.import_slack" class="ui-btn is-quiet" type="submit">Check the export</button></form><div id="import-out"></div>` : ''}</section>
    <section class="sect"><h2>Where this runs</h2><div class="two">
      <div class="ui-card"><h3>Host it yourself, free</h3><p>One Docker command and any Postgres, or SQLite on one computer. No licence key, no limits. Files on disk or any S3 store. Your data never leaves you.</p></div>
      <div class="ui-card"><h3>Host it with us</h3><p>We run it for you and charge what it costs us, times two, shown openly. Move to your own server any time with one export.</p></div>
    </div><p class="mute" style="margin-top:10px;font-size:12.5px">This server: ${esc(s.team.storage === 'postgres' ? 'Postgres' : 'SQLite')}, files in ${esc(s.team.files === 's3' ? 'an S3 store' : s.team.files === 'db' ? 'the database' : 'a folder')}. Agents: ${s.model_ready ? 'a model is connected' : 'no model connected, so agents give example answers'}.</p></section>
  </div></div>`;
}

async function teamSection() {
  const people = S.people;
  return `<section class="sect"><h2>Team</h2><p>Who can sign in, and the agents that work here.</p>
    <ul class="list">${people.map((p) => `<li class="row">${avatar(p)}<div class="grow"><b>${esc(p.name)}</b> <span class="mute">@${esc(p.handle)}</span>${p.kind === 'agent' ? ` <span class="ui-chip is-outline">${p.agent?.example ? 'Example agent' : 'Agent'}</span>` : ''}<small>${esc(p.kind === 'agent' ? (p.agent?.description || 'AI agent') : [p.role, p.email, p.github && `GitHub ${p.github}`].filter(Boolean).join(' · '))}</small></div>
      ${p.id !== S.me.id ? `<button type="button" class="ui-btn is-ghost is-sm" data-tool="chat.open_dm" data-people="${esc(p.handle)}">Message</button>` : ''}
      ${p.id !== S.me.id && p.role !== 'owner' ? `<button type="button" class="ui-btn is-danger is-sm" data-tool="chat.remove_person" data-person="${esc(p.handle)}">Remove</button>` : ''}</li>`).join('')}</ul>
    <form class="inline-form" data-tool="chat.add_person" style="margin-top:14px"><label class="ui-field"><span>Name</span><input class="ui-input" name="name" required placeholder="Casey Morgan"></label><label class="ui-field"><span>Email</span><input class="ui-input" type="email" name="email" placeholder="casey@company.example"></label><label class="ui-field"><span>GitHub <small>optional</small></span><input class="ui-input" name="github" placeholder="username"></label><button data-tool="chat.add_person" class="ui-btn is-quiet" type="submit">Add person</button></form>
    <form class="inline-form" data-tool="chat.add_agent" style="margin-top:14px"><label class="ui-field"><span>Agent name</span><input class="ui-input" name="name" required placeholder="Helper"></label><label class="ui-field"><span>What it does</span><input class="ui-input" name="description" placeholder="Answers questions about our schedule"></label><button data-tool="chat.add_agent" class="ui-btn is-quiet" type="submit">Add agent</button></form></section>`;
}

// ---------- popovers and dialogs ----------

function closePops() { $$('.pop').forEach((p) => p.remove()); $$('.msg.is-active').forEach((m) => m.classList.remove('is-active')); }

function pop(anchor, html, { label = 'Menu' } = {}) {
  closePops();
  const el = document.createElement('div');
  el.className = 'pop';
  el.setAttribute('role', 'menu');
  el.setAttribute('aria-label', label);
  el.innerHTML = html;
  ROOT.append(el);
  const r = anchor.getBoundingClientRect();
  const w = el.offsetWidth, h = el.offsetHeight;
  let left = r.left + w <= innerWidth - 8 && r.left < innerWidth / 2 ? r.left : Math.min(Math.max(8, r.right - w), innerWidth - w - 8);
  let top = r.bottom + 6;
  if (top + h > innerHeight - 8) top = Math.max(8, r.top - h - 6);
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
  el.querySelector('button')?.focus({ preventScroll: true });
  return el;
}

function findMessage(id) {
  for (const cv of S.convos.values()) { const m = cv.messages.find((x) => x.id === id); if (m) return m; }
  return S.thread?.messages.find((x) => x.id === id);
}

const OPEN = {
  emoji(el) {
    pop(el, `<div class="emojis">${EMOJI.map((e) => `<button type="button" role="menuitem" data-tool="chat.add_reaction" data-message="${esc(el.dataset.message)}" data-emoji="${e}" aria-label="React ${e}">${e}</button>`).join('')}</div>`, { label: 'Reactions' });
  },
  'emoji-insert'(el) {
    const form = el.closest('form');
    pop(el, `<div class="emojis">${EMOJI.map((e) => `<button type="button" role="menuitem" data-tool="none" data-why="puts it in the message box" data-insert="${e}" data-form="${form.id}" aria-label="Insert ${e}">${e}</button>`).join('')}</div>`, { label: 'Emoji' });
  },
  'msg-menu'(el) {
    const m = findMessage(el.dataset.message);
    if (!m) return;
    el.closest('.msg')?.classList.add('is-active');
    const admin = ['owner', 'admin'].includes(S.settings.me.role);
    pop(el, `${m.mine ? `<button type="button" role="menuitem" data-tool="chat.edit_message" data-message="${esc(m.id)}">Edit message</button>` : ''}
      ${m.thread_root ? '' : `<button type="button" role="menuitem" data-tool="chat.mark_unread" data-message="${esc(m.id)}">Mark unread from here</button>`}
      <button type="button" role="menuitem" data-tool="none" data-why="copies the address" data-copy="${esc(`${location.origin}/#/c/${m.channel}${m.thread_root ? `/t/${m.thread_root}` : `/m/${m.id}`}`)}">Copy link</button>
      ${m.mine || admin ? `<hr><button type="button" role="menuitem" class="is-danger" data-tool="chat.delete_message" data-message="${esc(m.id)}">Delete message</button>` : ''}`);
  },
  'notify-menu'(el) {
    const info = S.convos.get(el.dataset.channel)?.info;
    if (!info?.member) return toast('Join the channel to choose notifications.');
    const cur = info.notify ?? 'default';
    pop(el, [['default', `Your usual rule (${notifyLabel(S.settings.prefs.notify)})`], ['all', 'Every message'], ['mentions', 'Mentions only'], ['none', 'Nothing']].map(([v, l]) => `<button type="button" role="menuitemradio" aria-checked="${v === cur}" data-tool="chat.set_notify" data-channel="${esc(info.id)}" data-level="${v}">${v === cur ? ic('check', 14) : '<span style="width:14px"></span>'}${esc(l)}</button>`).join(''), { label: 'Notifications' });
    $$('.pop [role=menuitemradio]').forEach((b) => b.setAttribute('role', 'menuitem'));
  },
  'channel-menu'(el) {
    const info = S.convos.get(el.dataset.channel)?.info;
    if (!info) return;
    const admin = ['owner', 'admin'].includes(S.settings.me.role);
    pop(el, `<button type="button" role="menuitem" data-open="members" data-tool="none" data-why="shows who is in the channel" data-channel="${esc(info.id)}">People (${info.members.length})</button>
      ${info.member ? `<button type="button" role="menuitem" data-open="notify-menu" data-tool="none" data-why="opens the notification menu" data-channel="${esc(info.id)}">Notifications: ${esc(notifyLabel(info.notify))}</button>` : ''}
      ${!isDm(info) && info.member && !info.archived ? `<button type="button" role="menuitem" data-open="topic" data-tool="none" data-why="opens the topic form" data-channel="${esc(info.id)}">Edit topic</button>` : ''}
      ${info.member ? `<button type="button" role="menuitem" data-tool="chat.mark_read" data-channel="${esc(info.id)}">Mark as read</button>` : ''}
      ${!isDm(info) && info.member ? `<hr><button type="button" role="menuitem" data-tool="chat.leave_channel" data-channel="${esc(info.id)}">Leave channel</button>` : ''}
      ${!isDm(info) && admin && info.name !== 'general' ? `<button type="button" role="menuitem" class="${info.archived ? '' : 'is-danger'}" data-tool="chat.archive_channel" data-channel="${esc(info.id)}" data-archived="${!info.archived}">${info.archived ? 'Bring back from archive' : 'Archive channel'}</button>` : ''}`);
  },
  'new-channel'() {
    dialog('new-channel', 'Create a channel', `<form data-tool="chat.create_channel" id="f-new-channel"><div class="ui-dialog-b">
      <label class="ui-field"><span>Name</span><input class="ui-input" name="name" required maxlength="80" placeholder="launch-plans" pattern="[a-zA-Z0-9][a-zA-Z0-9 _-]*" autofocus></label>
      <label class="ui-field"><span>Topic <small>optional</small></span><input class="ui-input" name="topic" maxlength="250" placeholder="What it is for"></label>
      <label class="ui-check"><input type="checkbox" name="private"> Private: only people you add can see it</label></div>
      <div class="ui-dialog-a"><button type="button" class="ui-btn is-ghost" data-close data-tool="none" data-why="closes this without changing anything">Cancel</button><button data-tool="chat.create_channel" class="ui-btn is-accent" type="submit">Create</button></div></form>`);
  },
  'new-dm'() {
    const others = S.people.filter((p) => p.id !== S.me.id);
    dialog('new-dm', 'New message', `<form data-tool="chat.open_dm" id="f-new-dm"><div class="ui-dialog-b"><p class="mute" style="margin:0 0 10px">Pick one person or agent, or several for a group message.</p><div class="checks">${others.map((p) => `<label><input type="checkbox" name="people" value="${esc(p.handle)}">${avatar(p, 'is-sm')}<span>${esc(p.name)} <span class="mute">@${esc(p.handle)}</span>${p.kind === 'agent' ? ' <span class="ui-chip is-outline">Agent</span>' : ''}</span></label>`).join('')}</div></div>
      <div class="ui-dialog-a"><button type="button" class="ui-btn is-ghost" data-close data-tool="none" data-why="closes this without changing anything">Cancel</button><button data-tool="chat.open_dm" class="ui-btn is-accent" type="submit">Open</button></div></form>`);
  },
  members(el) {
    const info = S.convos.get(el.dataset.channel)?.info;
    if (!info) return;
    const outside = S.people.filter((p) => !info.members.some((m) => m.id === p.id));
    dialog('members', `People in ${esc(chanLabel(info))}`, `<div class="ui-dialog-b"><ul class="list">${info.members.map((m) => `<li class="row">${avatar(m, 'is-sm')}<div class="grow"><b>${esc(m.name)}</b> <span class="mute">@${esc(m.handle)}</span>${m.kind === 'agent' ? ' <span class="ui-chip is-outline">Agent</span>' : ''}</div>${m.id !== S.me.id ? `<button type="button" class="ui-btn is-ghost is-sm" data-tool="chat.open_dm" data-people="${esc(m.handle)}">Message</button>` : '<span class="mute">You</span>'}</li>`).join('')}</ul>
      ${info.kind !== 'dm' && info.member && !info.archived && outside.length ? `<form data-tool="chat.invite_people" data-channel="${esc(info.id)}" class="inline-form" style="margin-top:14px"><label class="ui-field"><span>Add someone</span><select class="ui-select" name="people">${outside.map((p) => `<option value="${esc(p.handle)}">${esc(p.name)}${p.kind === 'agent' ? ' (agent)' : ''}</option>`).join('')}</select></label><button data-tool="chat.invite_people" class="ui-btn is-quiet" type="submit">Add</button></form>` : ''}</div>
      <div class="ui-dialog-a"><button type="button" class="ui-btn is-ghost" data-close data-tool="none" data-why="closes this without changing anything">Done</button></div>`);
  },
  topic(el) {
    const info = S.convos.get(el.dataset.channel)?.info;
    dialog('topic', 'Edit topic', `<form data-tool="chat.set_topic" data-channel="${esc(info.id)}"><div class="ui-dialog-b"><label class="ui-field"><span>Topic</span><input class="ui-input" name="topic" maxlength="250" value="${esc(info.topic ?? '')}" autofocus></label></div>
      <div class="ui-dialog-a"><button type="button" class="ui-btn is-ghost" data-close data-tool="none" data-why="closes this without changing anything">Cancel</button><button data-tool="chat.set_topic" class="ui-btn is-accent" type="submit">Save</button></div></form>`);
  },
};

function dialog(id, title, body) {
  closePops();
  $(`#dlg-${id}`)?.remove();
  const d = document.createElement('dialog');
  d.className = 'ui-dialog';
  d.id = `dlg-${id}`;
  d.innerHTML = `<div class="ui-dialog-h"><h3>${title}</h3><button type="button" class="ui-x" data-close data-tool="none" data-why="closes this without changing anything" aria-label="Close">×</button></div>${body}`;
  ROOT.append(d);
  d.addEventListener('close', () => d.remove());
  d.showModal();
  return d;
}

function confirmBox(title, text, yes = 'Delete') {
  return new Promise((resolve) => {
    const d = dialog('confirm', esc(title), `<div class="ui-dialog-b"><p style="margin:0">${esc(text)}</p></div><div class="ui-dialog-a"><button type="button" class="ui-btn is-ghost" data-close data-tool="none" data-why="closes this without changing anything">Cancel</button><button type="button" class="ui-btn is-danger" data-close data-tool="none" data-why="closes this without changing anything" data-yes>${esc(yes)}</button></div>`);
    d.addEventListener('click', (e) => { if (e.target.closest('[data-yes]')) resolve(true); });
    d.addEventListener('close', () => resolve(false));
  });
}

// ---------- actions: each one calls the tool it names ----------

const ACT = {
  // A call for this channel, from the Meetings app (only shown when the suite has Meetings on): open or find the
  // channel's live room, post its link here, and go to it.
  async 'meet.huddle'(el) {
    const info = chan(el.dataset.channel);
    const name = info?.name ?? 'channel';
    const r = await CTX.callTool('meet.huddle', { for: `chat:channel:${el.dataset.channel}`, title: isDm(info) ? `Call with ${name}` : `#${name} call` });
    const link = r?.meeting?.join_url;
    if (!link) throw new Error('Meetings did not return a link.');
    await call('chat.post_message', { channel: el.dataset.channel, body: `Started a call: ${link}` });
    const u = new URL(link, location.href);
    if (u.origin === location.origin) { history.pushState(null, '', u.pathname); dispatchEvent(new PopStateEvent('popstate')); } else window.open(link, '_blank', 'noopener');
  },
  async 'chat.add_reaction'(el) {
    const m = findMessage(el.dataset.message);
    const mine = m?.reactions.find((r) => r.emoji === el.dataset.emoji)?.mine;
    closePops();
    // Picking an emoji you already used takes it back, as in Slack.
    const r = await call(mine ? 'chat.remove_reaction' : 'chat.add_reaction', { message: el.dataset.message, emoji: el.dataset.emoji });
    updateMessage(r.message, (x) => { x.reactions = r.reactions; });
  },
  async 'chat.remove_reaction'(el) {
    closePops();
    const r = await call('chat.remove_reaction', { message: el.dataset.message, emoji: el.dataset.emoji });
    updateMessage(r.message, (x) => { x.reactions = r.reactions; });
  },
  async 'chat.read_messages'(el) {
    const id = el.dataset.channel;
    if (el.dataset.thread) return go(`#/c/${id}/t/${el.dataset.thread}`);
    const cv = S.convos.get(id);
    if (el.hasAttribute('data-latest')) { cv.at_latest = false; return go(`#/c/${id}`, true); }
    const r = await call('chat.read_messages', { channel: id, before: el.dataset.before, limit: 50 });
    const el2 = $('#stream'), h = el2.scrollHeight;
    cv.messages = [...r.messages, ...cv.messages];
    cv.more_before = r.more_before;
    renderStream();
    el2.scrollTop = el2.scrollHeight - h;
  },
  'chat.edit_message'(el) {
    closePops();
    const m = findMessage(el.dataset.message);
    const box = $$(`#m-${CSS.escape(m.id)} .msg-text`).pop();
    if (!box) return;
    box.outerHTML = `<form class="edit-form" data-tool="chat.edit_message" data-message="${esc(m.id)}"><textarea class="ui-textarea" name="body" rows="3" aria-label="Edit message">${esc(m.body)}</textarea><div class="row"><button type="button" class="ui-btn is-ghost is-sm" data-close data-tool="none" data-why="closes this without changing anything" data-rerender>Cancel</button><button data-tool="chat.edit_message" class="ui-btn is-accent is-sm" type="submit">Save</button></div></form>`;
    const ta = $(`#m-${CSS.escape(m.id)} .edit-form textarea`);
    ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length);
  },
  async 'chat.delete_message'(el) {
    closePops();
    if (!(await confirmBox('Delete this message?', 'The words are wiped for everyone. This cannot be undone.'))) return;
    await call('chat.delete_message', { message: el.dataset.message });
  },
  async 'chat.mark_unread'(el) {
    closePops();
    const d = await call('chat.mark_unread', { message: el.dataset.message });
    S.holdRead.add(d.channel);
    const cv = S.convos.get(d.channel);
    if (cv) { cv.newFrom = d.last_read_id ?? ''; renderStream(); }
    applyRead(d);
    toast('Marked unread. It stays unread until you come back to it.');
  },
  async 'chat.mark_read'(el) { closePops(); applyRead(await call('chat.mark_read', { channel: el.dataset.channel })); },
  async 'chat.join_channel'(el) {
    await call('chat.join_channel', { channel: el.dataset.channel });
    await refreshChannels(el.dataset.channel);
    go(`#/c/${el.dataset.channel}`);
    if (S.route.channel === el.dataset.channel) route();
  },
  async 'chat.leave_channel'(el) {
    closePops();
    await call('chat.leave_channel', { channel: el.dataset.channel });
    await refreshChannels(el.dataset.channel);
    go('#/', true);
  },
  async 'chat.archive_channel'(el) {
    closePops();
    const archived = el.dataset.archived === 'true';
    if (archived && !(await confirmBox('Archive this channel?', 'Nobody can post in it. It stays readable and searchable, and an admin can bring it back.', 'Archive'))) return;
    await call('chat.archive_channel', { channel: el.dataset.channel, archived });
    await refreshChannels(el.dataset.channel);
    route();
  },
  async 'chat.set_notify'(el) {
    closePops();
    const r = await call('chat.set_notify', el.dataset.channel ? { channel: el.dataset.channel, level: el.dataset.level } : { level: el.dataset.level });
    if (r.scope === 'channel') { const cv = S.convos.get(r.channel); if (cv) cv.info.notify = r.level; route(); toast(`Notifications: ${notifyLabel(r.level)}.`); }
    else { S.settings.prefs.notify = r.level; showSettings(); toast('Saved.'); }
  },
  async 'chat.set_preferences'(el) {
    const prefs = await call('chat.set_preferences', { theme: el.dataset.theme });
    applyTheme(prefs.theme);
    showSettings();
  },
  async 'chat.subscribe_push'() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return toast('This browser cannot show notifications.');
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') return toast('Notifications are blocked for this site. Allow them in the browser settings, then try again.');
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64(S.settings.push.public_key) });
    await call('chat.subscribe_push', { subscription: sub.toJSON() });
    toast('Notifications are on for this device.');
    showSettings();
  },
  async 'chat.unsubscribe_push'() {
    await call('chat.unsubscribe_push', {});
    try { (await (await navigator.serviceWorker.ready).pushManager.getSubscription())?.unsubscribe(); } catch {}
    toast('Notifications are off.');
    showSettings();
  },
  async 'chat.export_data'() {
    const out = $('#export-out');
    out.textContent = 'Packing it up';
    const r = await call('chat.export_data', {});
    out.innerHTML = `<a class="ui-btn is-accent is-sm" href="${esc(r.file.url)}" download>Download ${esc(size(r.file.size))}</a> <span class="mute">${r.counts.messages} messages, ${r.counts.channels} conversations, ${r.counts.files} files</span>`;
  },
  async 'chat.decide_approval'(el) {
    const r = await call('chat.decide_approval', { approval: el.dataset.approval, approve: el.dataset.approve === 'true' });
    toast(r.status === 'done' ? 'Approved and done.' : r.status === 'declined' ? 'Declined.' : `It did not work: ${r.result?.error ?? ''}`);
    showActivity();
  },
  async 'chat.remove_person'(el) {
    if (!(await confirmBox(`Remove @${el.dataset.person}?`, 'They are signed out and leave every channel. Their messages stay.', 'Remove'))) return;
    await call('chat.remove_person', { person: el.dataset.person });
    await refreshPeople();
    showSettings();
  },
  async 'chat.open_dm'(el) {
    $$('dialog').forEach((d) => d.close());
    const c = await call('chat.open_dm', { people: el.dataset.people.split(',') });
    await refreshChannels(c.id);
    go(`#/c/${c.id}`);
  },
};

const FORM = {
  async 'chat.post_message'(form, data) { await send(form, data, null); },
  async 'chat.post_reply'(form, data) { await send(form, data, form.dataset.message); },
  async 'chat.edit_message'(form, data) {
    const m = await call('chat.edit_message', { message: form.dataset.message, body: data.get('body') });
    updateMessage(m.id, (x) => Object.assign(x, m));
  },
  async 'chat.create_channel'(form, data) {
    const c = await call('chat.create_channel', { name: data.get('name'), topic: data.get('topic') || undefined, private: data.get('private') === 'on' });
    form.closest('dialog')?.close();
    await refreshChannels(c.id);
    go(`#/c/${c.id}`);
  },
  async 'chat.open_dm'(form, data) {
    const people = data.getAll('people');
    if (!people.length) return toast('Pick someone first.');
    form.closest('dialog')?.close();
    const c = await call('chat.open_dm', { people });
    await refreshChannels(c.id);
    go(`#/c/${c.id}`);
  },
  async 'chat.invite_people'(form, data) {
    const r = await call('chat.invite_people', { channel: form.dataset.channel, people: data.getAll('people') });
    form.closest('dialog')?.close();
    toast(r.added.length ? `Added ${r.added.map((h) => `@${h}`).join(', ')}.` : 'Already in the channel.');
  },
  async 'chat.set_topic'(form, data) {
    await call('chat.set_topic', { channel: form.dataset.channel, topic: data.get('topic') });
    form.closest('dialog')?.close();
  },
  async 'chat.search_messages'(form, data) {
    const q = String(data.get('q') ?? '').trim();
    CTX.path = `/search?q=${encodeURIComponent(q)}`;
    if (CTX.standalone) history.replaceState(null, '', `#${CTX.path}`);
    if (q) await runSearch(q);
  },
  async 'chat.set_status'(form, data) {
    await call('chat.set_status', { text: data.get('text'), emoji: data.get('emoji') });
    toast('Status saved.');
  },
  async 'chat.set_preferences'(form, data) {
    await call('chat.set_preferences', { keywords: String(data.get('keywords') ?? '').split(',').map((s) => s.trim()).filter(Boolean) });
    toast('Keywords saved.');
  },
  async 'chat.add_person'(form, data) {
    const p = await call('chat.add_person', { name: data.get('name'), email: data.get('email') || undefined, github: data.get('github') || undefined });
    toast(`Added ${p.name}. They can sign in now.`);
    await refreshPeople();
    showSettings();
  },
  async 'chat.add_agent'(form, data) {
    const p = await call('chat.add_agent', { name: data.get('name'), description: data.get('description') || undefined, channels: ['general'] });
    toast(`Added ${p.name} to #general. Mention @${p.handle} to ask it something.`);
    await refreshPeople();
    showSettings();
  },
  async 'chat.import_slack'(form, data) {
    const out = $('#import-out');
    out.textContent = 'Reading the export';
    try {
      const f = await upload(data.get('file'));
      const r = await call('chat.import_slack', { file: f.id });
      out.innerHTML = `<div class="ui-notice is-quiet" style="margin-top:10px"><div>That export holds <b>${r.people}</b> people, <b>${r.channels}</b> conversations and <b>${r.messages}</b> messages.${r.warnings.map((w) => `<br>${esc(w)}`).join('')}<br>Bringing it in arrives in the next version.</div></div>`;
    } catch (e) { out.textContent = e.message; }
  },
};

async function send(form, data, root) {
  const body = String(data.get('body') ?? '').trim();
  const pend = root ? S.threadPending : S.pending;
  if (!body && !pend.length) return;
  const ta = form.querySelector('textarea');
  const files = pend.map((f) => f.id);
  ta.value = '';
  autosize(ta);
  pend.length = 0;
  form.querySelector('.pending-files').innerHTML = '';
  try {
    const m = root ? await call('chat.post_reply', { message: root, body, ...(files.length ? { files } : {}) }) : await call('chat.post_message', { channel: form.dataset.channel, body, ...(files.length ? { files } : {}) });
    addMessage({ ...m, mine: true });
  } catch (e) {
    ta.value = body;
    autosize(ta);
    throw e;
  }
}

// ---------- applying changes ----------

function addMessage(m) {
  if (m.thread_root) {
    // The reply count on the first message comes from the thread.updated event.
    if (S.thread?.root === m.thread_root && !S.thread.messages.some((x) => x.id === m.id)) { S.thread.messages.push(m); renderThread(); }
    return;
  }
  const cv = S.convos.get(m.channel);
  if (cv && cv.at_latest && !cv.messages.some((x) => x.id === m.id)) {
    cv.messages.push(m);
    if (S.current === m.channel) { renderStream(); maybeMarkRead(); }
  }
}

// A message can be loaded twice (in its channel and as a thread's first message): change every copy.
function updateMessage(id, fn) {
  const copies = new Set();
  for (const cv of S.convos.values()) for (const m of cv.messages) if (m.id === id) copies.add(m);
  for (const m of S.thread?.messages ?? []) if (m.id === id) copies.add(m);
  copies.forEach(fn);
  if (S.current) renderStream();
  if (S.thread) renderThread();
}

async function refreshChannels(id) {
  S.channels = (await call('chat.list_channels')).channels;
  if (id) { const cv = S.convos.get(id); if (cv) cv.infoStale = true; }
  renderSide();
}
async function refreshPeople() { S.people = (await call('chat.list_people')).people; renderSide(); }

const refreshSoon = (() => { let t; return (id) => { clearTimeout(t); t = setTimeout(async () => { await refreshChannels(id); if (S.route.view === 'convo' && (!id || id === S.current)) { const cv = S.convos.get(S.current); if (cv) { cv.info = await call('chat.get_channel', { channel: S.current }).catch(() => cv.info); } } }, 250); }; })();

function onEvent(e) {
  if (e.id) { if (S.seen.has(e.id)) return; S.seen.add(e.id); S.cursor = Math.max(S.cursor, e.id); }
  const d = e.data ?? {};
  switch (e.type) {
    case 'chat.message.posted': {
      const m = { ...d.message, mine: d.message.author.id === S.me.id };
      addMessage(m);
      if (!m.thread_root && m.author.id !== S.me.id) {
        const c = S.channels.find((x) => x.id === m.channel);
        if (c && !(S.current === m.channel && !document.hidden && !S.holdRead.has(m.channel))) {
          c.unread++;
          if (isDm(c) || m.html.includes(`data-handle="${S.me.handle}"`)) c.mentions++;
          renderSide();
        }
        if (!c) refreshSoon();
      }
      for (const [k, t] of S.typing) if (t.id === m.author.id) S.typing.delete(k);
      renderTyping();
      break;
    }
    case 'chat.thread.updated': updateMessage(d.message, (x) => { x.reply_count = d.reply_count; x.last_reply_at = d.last_reply_at; }); break;
    case 'chat.message.edited': updateMessage(d.message.id, (x) => Object.assign(x, { ...d.message, mine: x.mine })); break;
    case 'chat.message.deleted':
      for (const cv of S.convos.values()) cv.messages = d.keep ? cv.messages.map((x) => (x.id === d.message ? { ...x, deleted: true, body: '', html: '', reactions: [], files: [] } : x)) : cv.messages.filter((x) => x.id !== d.message);
      if (S.thread) { if (S.thread.root === d.message && !d.keep) go(`#/c/${S.thread.channel}`, true); else S.thread.messages = S.thread.messages.filter((x) => x.id !== d.message || x.id === S.thread.root).map((x) => (x.id === d.message ? { ...x, deleted: true, body: '', html: '' } : x)); }
      if (d.thread_root) updateMessage(d.thread_root, (x) => { x.reply_count = Math.max(0, (x.reply_count ?? 1) - 1); });
      if (S.current) renderStream();
      if (S.thread) renderThread();
      break;
    case 'chat.reaction.changed': updateMessage(d.message, (x) => { x.reactions = d.reactions.map((r) => ({ ...r, mine: r.people.includes(S.me.handle) })); }); break;
    case 'chat.read.changed': applyRead(d); break;
    case 'chat.typing.started': case 'chat.agent.started': {
      const p = d.person ?? d.agent;
      S.typing.set(`${p.id}:${e.channel}`, { id: p.id, name: p.name, channel: e.channel, thread: d.thread ?? null, agent: e.type === 'chat.agent.started', until: Date.now() + (e.type === 'agent.thinking' ? 20000 : 5000) });
      if (e.type === 'chat.agent.started' && S.thread?.root !== d.thread) S.typing.get(`${p.id}:${e.channel}`).thread = null;
      renderTyping();
      break;
    }
    case 'chat.notification.sent':
      if (document.hidden && 'Notification' in window && Notification.permission === 'granted' && !S.settings.push.devices) navigator.serviceWorker?.ready.then((r) => r.showNotification(d.title, { body: d.body, tag: d.tag, data: { url: d.url } })).catch(() => {});
      break;
    case 'chat.approval.requested': S.approvals.push(d.approval); renderSide(); toast(`An app is asking you to approve: ${d.approval.title}. See Activity.`); break;
    case 'chat.channel.created': case 'chat.channel.updated': case 'chat.member.joined': case 'chat.member.left': {
      const cv = S.convos.get(e.channel);
      if (cv) cv.infoStale = true;
      if (e.type === 'chat.member.left' && d.person?.id === S.me.id && S.current === e.channel) { refreshChannels(); break; }
      refreshSoon(e.channel);
      if (S.current === e.channel && (e.type === 'chat.channel.updated' || e.type === 'chat.member.joined')) setTimeout(() => { if (S.current === e.channel && !document.activeElement?.closest('.composer')) route(); }, 400);
      break;
    }
    case 'chat.person.added': case 'chat.person.updated': case 'chat.person.removed': refreshPeople(); break;
    default:
  }
}

// ---------- live: events from ctx.on; anything missed is fetched with chat.list_events ----------

// The suite sends open events whole and private ones as a bare reference; the standalone page sends its own
// events whole and asks for a resync after a reconnect or while polling.
function onLive(e) {
  if (e.type === 'resync') return catchUp();
  if (e.type) return onEvent(e);
  const d = e.data ?? {};
  if (d.ref !== undefined) return catchUp();
  const { event_id, channel, ...rest } = d;
  onEvent({ id: event_id ?? null, type: e.name, channel: channel ?? null, data: rest });
}

async function catchUp() {
  try {
    const r = await call('chat.list_events', { since: S.cursor });
    for (const e of r.events) onEvent(e);
    S.cursor = Math.max(S.cursor, r.cursor);
  } catch {}
}

// ---------- the composer: autosize, mentions, typing, files ----------

function autosize(ta) { ta.style.height = 'auto'; ta.style.height = `${Math.min(ta.scrollHeight, innerHeight * 0.4)}px`; }

let typingSent = 0;
function onComposerInput(ta) {
  autosize(ta);
  const form = ta.closest('form');
  if (!CTX.viewer && Date.now() - typingSent > 3000 && ta.value.trim()) {
    typingSent = Date.now();
    call('chat.set_typing', { channel: form.dataset.channel, ...(form.dataset.message ? { thread: form.dataset.message } : {}) }).catch(() => {});
  }
  const before = ta.value.slice(0, ta.selectionStart);
  const m = /(^|\s)@([\w.-]*)$/.exec(before);
  form.querySelector('.picker')?.remove();
  if (!m) return;
  const q = m[2].toLowerCase();
  const options = [...S.people.filter((p) => p.id !== S.me.id && (p.handle.startsWith(q) || p.name.toLowerCase().includes(q))), ...(['channel', 'here'].filter((h) => h.startsWith(q)).map((h) => ({ handle: h, name: h === 'channel' ? 'Everyone in this channel' : 'Everyone here', special: true })))].slice(0, 8);
  if (!options.length) return;
  const box = document.createElement('div');
  box.className = 'picker';
  box.setAttribute('role', 'listbox');
  box.innerHTML = options.map((p, i) => `<button type="button" role="option" aria-selected="${i === 0}" data-tool="none" data-why="puts it in the message box" data-insert="@${esc(p.handle)} " data-replace="${m[2].length + 1}" data-form="${form.id}">${p.special ? `<span class="ui-avatar is-xs">@</span>` : avatar(p, 'is-xs')}<span>${esc(p.name)} <small>@${esc(p.handle)}${p.kind === 'agent' ? ' · agent' : ''}</small></span></button>`).join('');
  form.append(box);
}

function insertText(form, text, replace = 0) {
  const ta = form.querySelector('textarea');
  const at = ta.selectionStart ?? ta.value.length;
  ta.value = ta.value.slice(0, at - replace) + text + ta.value.slice(at);
  const pos = at - replace + text.length;
  ta.focus();
  ta.setSelectionRange(pos, pos);
  autosize(ta);
  form.querySelector('.picker')?.remove();
}

async function onFiles(input) {
  const form = input.closest('form');
  const pend = form.id === 'thread-composer' ? S.threadPending : S.pending;
  for (const file of input.files) {
    try { pend.push(await upload(file)); } catch (e) { fail(e); }
  }
  input.value = '';
  form.querySelector('.pending-files').innerHTML = pend.map((f) => `<span class="file-chip">${ic('file', 14)}${esc(f.name)} <small>${size(f.size)}</small><button type="button" class="ui-btn is-ghost is-icon is-sm" data-tool="none" data-why="takes the file off before sending" data-unpend="${esc(f.id)}" data-close data-tool="none" data-why="closes this without changing anything" aria-label="Remove file">${ic('x', 13)}</button></span>`).join('');
}

// ---------- wiring ----------

const onClick = async (e) => {
  const t = e.target;
  const link = !CTX.standalone && t.closest('a[href^="#/"]');
  if (link) { e.preventDefault(); go(link.getAttribute('href')); return; }
  const copy = t.closest('[data-copy]');
  if (copy) { navigator.clipboard?.writeText(copy.dataset.copy).then(() => toast('Copied.'), () => toast(copy.dataset.copy)); closePops(); return; }
  const ins = t.closest('[data-insert]');
  if (ins) { const f = document.getElementById(ins.dataset.form); if (f) insertText(f, ins.dataset.insert, Number(ins.dataset.replace || 0)); closePops(); return; }
  const unpend = t.closest('[data-unpend]');
  if (unpend) { for (const list of [S.pending, S.threadPending]) { const i = list.findIndex((f) => f.id === unpend.dataset.unpend); if (i >= 0) list.splice(i, 1); } unpend.closest('.file-chip').remove(); return; }
  const open = t.closest('[data-open]');
  if (open) { e.preventDefault(); OPEN[open.dataset.open]?.(open); return; }
  const close = t.closest('[data-close]');
  if (close) {
    if (close.hasAttribute('data-rerender')) { renderStream(); renderThread(); }
    close.closest('dialog')?.close();
    return;
  }
  const btn = t.closest('button[data-tool]:not([type=submit]), [role=menuitem][data-tool]');
  if (btn && ACT[btn.dataset.tool]) {
    e.preventDefault();
    btn.disabled = true;
    try { await ACT[btn.dataset.tool](btn); } catch (err) { fail(err); } finally { btn.disabled = false; }
    return;
  }
  if (!t.closest('.pop')) closePops();
  // Phones have no hover: a tap on a message shows its actions.
  const msg = t.closest('.msg');
  if (msg && coarse() && !t.closest('a,button')) { const on = msg.classList.contains('is-active'); closePops(); if (!on) msg.classList.add('is-active'); }
};

const onSubmit = async (e) => {
  const form = e.target.closest('form[data-tool]');
  if (!form || !FORM[form.dataset.tool]) return;
  e.preventDefault();
  const sub = form.querySelector('[type=submit]');
  if (sub) sub.disabled = true;
  try { await FORM[form.dataset.tool](form, new FormData(form)); } catch (err) { fail(err); } finally { if (sub) sub.disabled = false; }
};

const onInput = (e) => { if (e.target.matches('.composer textarea')) onComposerInput(e.target); };
const onChange = (e) => { if (e.target.matches('.composer input[type=file]')) onFiles(e.target); };
const onKey = (e) => {
  const ta = e.target.closest?.('.composer textarea');
  if (ta) {
    const picker = ta.closest('form').querySelector('.picker');
    if (picker && ['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(e.key)) {
      const items = $$('[role=option]', picker);
      const i = items.findIndex((x) => x.getAttribute('aria-selected') === 'true');
      if (e.key === 'Escape') { picker.remove(); return; }
      e.preventDefault();
      if (e.key === 'Enter' || e.key === 'Tab') { items[i]?.click(); return; }
      const n = (i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length;
      items.forEach((x, k) => x.setAttribute('aria-selected', String(k === n)));
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !coarse()) { e.preventDefault(); ta.closest('form').requestSubmit(); }
    if (e.key === 'ArrowUp' && !ta.value) {
      const cv = S.convos.get(S.current);
      const mine = [...(ta.closest('#thread') ? S.thread?.messages ?? [] : cv?.messages ?? [])].reverse().find((m) => m.mine && !m.deleted);
      if (mine) { e.preventDefault(); ACT['chat.edit_message']({ dataset: { message: mine.id } }); }
    }
    return;
  }
  if (e.target.closest?.('.edit-form textarea')) {
    if (e.key === 'Enter' && !e.shiftKey && !coarse()) { e.preventDefault(); e.target.closest('form').requestSubmit(); }
    if (e.key === 'Escape') { renderStream(); renderThread(); }
    return;
  }
  if (e.key === 'Escape') closePops();
  if (e.key === '/' && !e.target.closest('input,textarea,select,[contenteditable]')) { e.preventDefault(); go('#/search'); }
};
const onVisible = () => { if (!document.hidden) { maybeMarkRead(); catchUp(); } };
let wasMobile = false;
const onResize = () => { if (mobile() !== wasMobile) { wasMobile = mobile(); route(); } };

function b64(s) {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  const raw = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

async function start() {
  try {
    const [people, chans, settings, ev] = await Promise.all([call('chat.list_people'), call('chat.list_channels'), call('chat.get_settings'), call('chat.list_events', {})]);
    S.me = people.me;
    S.people = people.people;
    S.channels = chans.channels;
    S.settings = settings;
    S.cursor = ev.cursor;
    applyTheme(settings.prefs.theme);
    // Calls come from the Meetings app; inside the suite, a channel offers one only when Meetings is on.
    S.meet = !CTX.standalone && (await CTX.callTool('meet.whoami', {}).then(() => true, () => false));
    renderShell();
    call('chat.list_approvals').then((r) => { S.approvals = r.approvals; renderSide(); }).catch(() => {});
    await route();
    window.chatReady = true;
  } catch (e) {
    ROOT.innerHTML = `<div class="loading">${esc(e.message)}</div>`;
  }
}

// The screen part: draw Chat into el. Returns cleanup, and update(path) for in-app navigation.
export function mount(el, ctx) {
  CTX = ctx;
  ROOT = el;
  if (!CTX.path) CTX.path = '/';
  el.classList.add('ui-shell', 'chat-root');
  if (!ctx.standalone) { el.classList.add('is-embedded'); injectStyles(); }
  el.setAttribute('aria-busy', 'true');
  wasMobile = mobile();
  el.addEventListener('click', onClick);
  el.addEventListener('submit', onSubmit);
  el.addEventListener('input', onInput);
  el.addEventListener('change', onChange);
  el.addEventListener('keydown', onKey);
  const onSlash = (e) => { if (e.key === '/' && !e.target.closest?.('input,textarea,select,[contenteditable]') && !el.contains(e.target)) { e.preventDefault(); go('#/search'); } };
  document.addEventListener('keydown', onSlash);
  document.addEventListener('visibilitychange', onVisible);
  window.addEventListener('resize', onResize);
  const off = ctx.on('chat.*', onLive);
  const timer = setInterval(() => { if (S.typing.size) renderTyping(); }, 1500);
  start();
  window.chatState = S;
  const unmount = () => {
    el.removeEventListener('click', onClick);
    el.removeEventListener('submit', onSubmit);
    el.removeEventListener('input', onInput);
    el.removeEventListener('change', onChange);
    el.removeEventListener('keydown', onKey);
    document.removeEventListener('keydown', onSlash);
    document.removeEventListener('visibilitychange', onVisible);
    window.removeEventListener('resize', onResize);
    clearInterval(timer);
    off?.();
    el.innerHTML = '';
  };
  return { unmount, update(path) { if (path === lastRouted) return; CTX.path = path; route(); } };
}

// Inside the suite the page does not load chat.css; screens.mjs carries it (scripts/build-screens.mjs).
function injectStyles() {
  if (document.getElementById('chat-css') || typeof CHAT_CSS === 'undefined') return;
  const st = document.createElement('style');
  st.id = 'chat-css';
  st.textContent = CHAT_CSS;
  document.head.append(st);
}

export default { title: 'Chat', mount };
