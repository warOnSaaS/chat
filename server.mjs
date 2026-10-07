// wOS Chat server: pages, the tools (REST at /api/tools/<name> and MCP at /mcp, one set of handlers),
// files, sign-in and live updates over WebSockets at /ws. Runs as a long-lived Node server
// (npm start, Docker) and as one Vercel function (api/index.mjs exports the same server).
//   npm run dev                         the demo: example data, no sign-in, SQLite in ./data
//   DATABASE_URL=postgres://... npm start   your team, on any Postgres
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createApp } from './lib/app.mjs';
import { listTools, runTool, toText } from './lib/tools.mjs';
import { canSee } from './lib/bus.mjs';
import { seedDemo } from './lib/demo.mjs';
import { createMailer } from './lib/mail.mjs';
import { appShell, esc } from './lib/html.mjs';
import { ChatError } from './lib/chat.mjs';
import {
  identify, sign, verify, cookieOf, setCookie, DEMO_COOKIE, challenge, json, page, bodyObject, loginPage, githubRedirect,
  handleGithubCallback, handleEmailStart, handleEmailVerify, handleAuthorize, handleToken, handleRegister, resourceMetadata, serverMetadata, COOKIE,
} from './lib/auth.mjs';

const ROOT = path.dirname(new URL(import.meta.url).pathname);
const PUBLIC = path.join(ROOT, 'public');
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const TYPES = { '.css': 'text/css; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };
const DAY = 24 * 3600;

export const hostOf = (req) => {
  const h = req.headers['x-forwarded-host'] ?? req.headers.host;
  const proto = req.headers['x-forwarded-proto'] ?? (/^(localhost|127\.0\.0\.1|\[::1\])(:|$)/.test(h ?? '') ? 'http' : 'https');
  return `${proto}://${h}`;
};
// On Vercel every request is rewritten to the one function with the original path in ?__p.
const pathOf = (req) => { const u = new URL(req.url, 'http://x'); return { url: u, p: u.searchParams.get('__p') ?? u.pathname }; };

export function createServer(appOrPromise = createApp()) {
  const ready = Promise.resolve(appOrPromise).then(async (app) => {
    app.mailer ??= await createMailer(app.env);
    attachLive(app, wss);
    return app;
  });
  ready.catch((e) => console.error('chat: could not start:', e));
  const server = http.createServer(async (req, res) => {
    let app;
    try { app = await ready; } catch { return json(res, 503, { error: 'The chat server could not start. Check DATABASE_URL and the server log.' }); }
    try { await route(app, req, res); } catch (e) {
      if (!(e instanceof ChatError)) console.error(e);
      if (!res.headersSent) json(res, e.status ?? 500, { ok: false, error: e instanceof ChatError ? e.message : 'Something went wrong on our side. Try again.' });
    }
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  server.on('upgrade', async (req, socket, head) => {
    const { p } = pathOf(req);
    if (p !== '/ws') return socket.destroy();
    let app;
    try { app = await ready; } catch { return socket.destroy(); }
    const who = await identify(app, req).catch(() => null);
    if (!who) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); return socket.destroy(); }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req, who, app));
  });
  server.ready = ready;
  return server;
}

// ---------- live: WebSockets fed by the bus (which Postgres LISTEN/NOTIFY feeds from other copies) ----------

function attachLive(app, wss) {
  if (app.live) return;
  app.live = new Set();
  wss.on('connection', async (ws, req, who) => {
    const client = { ws, me: who.me };
    app.live.add(client);
    const last = await app.db.get('select max(id) as id from chat_events where team_id = $1', [who.me.team_id]);
    ws.send(JSON.stringify({ type: 'hello', cursor: Number(last?.id ?? 0), server: app.bus.id }));
    ws.on('message', (raw) => { if (String(raw) === 'ping') ws.send('{"type":"pong"}'); });
    ws.on('close', () => app.live.delete(client));
    ws.on('error', () => app.live.delete(client));
  });
  app.bus.on('event', (e) => {
    for (const c of app.live) {
      if (c.me.team_id !== e.team || !canSee(e, c.me.id) || c.ws.readyState !== 1) continue;
      // Someone who left or was removed stops hearing at once.
      if (e.type === 'person.removed' && e.data.person?.id === c.me.id) { c.ws.close(4001, 'removed'); continue; }
      const { audience, team, ...out } = e;
      c.ws.send(JSON.stringify(out));
    }
  });
  // Keep sockets alive through proxies that drop quiet connections.
  const timer = setInterval(() => { for (const c of app.live) if (c.ws.readyState === 1) c.ws.ping(); }, 25000);
  timer.unref?.();
}

// ---------- routes ----------

async function route(app, req, res) {
  const { url, p } = pathOf(req);
  const host = hostOf(req);
  if (req.method === 'GET' && (p.startsWith('/ui/') || p.startsWith('/app/') || ['/sw.js', '/manifest.webmanifest', '/icon.svg', '/icon-192.png', '/icon-512.png'].includes(p))) return serveStatic(res, p);
  if (p === '/wos-app.json' || p === '/tools.json') return serveFile(res, path.join(ROOT, p.slice(1)), 'application/json');
  if (p === '/health') return json(res, 200, { ok: true, storage: app.db.kind, files: app.files.mode, demo: app.demo, live: app.db.kind === 'postgres' ? 'websockets + postgres notify' : 'websockets', version: VERSION });
  if (p === '/mcp') return handleMcp(app, req, res, host, url);
  if (p.startsWith('/.well-known/oauth-protected-resource')) return json(res, 200, resourceMetadata(host), { 'access-control-allow-origin': '*' });
  if (p.startsWith('/.well-known/oauth-authorization-server')) return json(res, 200, serverMetadata(host), { 'access-control-allow-origin': '*' });
  if (p === '/oauth/register') return handleRegister(req, res);
  if (p === '/oauth/token') return handleToken(app, req, res);
  if (p === '/oauth/authorize') return handleAuthorize(app, req, res, host);
  if (p === '/oauth/github/callback') return handleGithubCallback(app, req, res, host);
  if (p === '/login') return app.demo ? redirect(res, '/') : loginPage(app, res, url.searchParams.get('next') ?? '/');
  if (p === '/login/github') return process.env.GITHUB_OAUTH_CLIENT_ID ? githubRedirect(res, host, url.searchParams.get('next')) : loginPage(app, res, '/', 'GitHub sign-in is not set up on this server (GITHUB_OAUTH_CLIENT_ID). Use the email link.');
  if (p === '/auth/email' && req.method === 'POST') return handleEmailStart(app, req, res, host, app.mailer);
  if (p === '/auth/email/verify') return handleEmailVerify(app, req, res, host);
  if (p === '/logout') return res.writeHead(302, { location: app.demo ? '/' : '/login', 'set-cookie': [setCookie(host, COOKIE, '', 0), setCookie(host, DEMO_COOKIE, '', 0)], 'cache-control': 'no-store' }).end();
  if (p === '/api/tools' && req.method === 'GET') return json(res, 200, { tools: catalogue() });
  if (p.startsWith('/api/tools/')) return handleTool(app, req, res, decodeURIComponent(p.slice('/api/tools/'.length)));
  if (p === '/files' && req.method === 'POST') return handleUpload(app, req, res, url);
  if (p.startsWith('/files/')) return handleDownload(app, req, res, p);
  if (app.demo && p.startsWith('/demo/as/')) return demoSwitch(app, req, res, host, p.slice('/demo/as/'.length));
  if (req.method !== 'GET') return json(res, 404, { error: 'Not found' });
  // Every other path is the app; the screen reads its place from the #hash.
  let who = await identify(app, req);
  const headers = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex' };
  if (!who && app.demo) {
    const seeded = await seedDemo(app);
    who = { me: await app.chat.personRow(seeded.people.sam) };
    headers['set-cookie'] = setCookie(host, DEMO_COOKIE, sign({ k: 'demo', t: seeded.teamId, id: seeded.people.sam }), 2 * DAY);
  }
  if (!who) return loginPage(app, res, p + url.search);
  const prefs = await app.chat.prefs(who.me);
  const team = await app.chat.team(who.me.team_id);
  res.writeHead(200, headers).end(appShell({ title: team?.name ? `${team.name} · Chat` : 'Chat', theme: prefs.theme, demo: app.demo, version: VERSION }));
}

const redirect = (res, to) => res.writeHead(302, { location: to, 'cache-control': 'no-store' }).end();

export function catalogue() {
  return listTools().map((t) => ({ name: t.name, title: t.title, description: t.description, scope: t.scope, confirm: t.confirm, emits: t.emits, input: t.inputJson, output: t.outputJson }));
}

async function handleTool(app, req, res, name) {
  if (req.method !== 'POST') return json(res, 405, { error: 'Use POST' }, { allow: 'POST' });
  const who = await identify(app, req);
  if (!who) return json(res, 401, { ok: false, error: 'Sign in first.' }, { 'www-authenticate': challenge(hostOf(req)) });
  // A browser call must come from this site (the cookie is SameSite=Lax; this closes the rest).
  if (who.via === 'web' && req.headers.origin && req.headers.origin !== hostOf(req)) return json(res, 403, { ok: false, error: 'Wrong origin.' });
  const input = await bodyObject(req);
  const result = await runTool(app, who.me, name, input, { via: who.via === 'mcp' ? 'rest' : 'web', scopes: who.scopes, client: who.client });
  json(res, 200, { ok: true, result });
}

async function handleMcp(app, req, res, host, url) {
  if (req.method !== 'POST') return json(res, 405, { error: 'Use POST (this is an MCP endpoint)' }, { allow: 'POST' });
  const who = await identify(app, { headers: { authorization: req.headers.authorization } });
  if (!who) return json(res, 401, { error: 'Sign in to use this chat.' }, { 'www-authenticate': challenge(host) });
  // Tool names have a dot (chat.post), as the suite catalogue does. Clients that only allow letters, digits,
  // _ and - can connect to /mcp?names=underscore and get chat_post instead.
  const underscore = url.searchParams.get('names') === 'underscore';
  const server = new McpServer({ name: 'wos-chat', version: VERSION }, { instructions: INSTRUCTIONS });
  for (const t of listTools()) {
    if (!who.scopes.includes(t.scope)) continue;
    server.registerTool(underscore ? t.name.replace('.', '_') : t.name, {
      title: t.title, description: t.description + (t.confirm === 'human' ? ' Needs a person\'s yes: it asks them in the app first.' : ''), inputSchema: t.input,
      annotations: { readOnlyHint: t.scope === 'read', destructiveHint: t.scope === 'delete' || t.confirm === 'human', openWorldHint: false },
    }, async (args) => {
      try {
        const out = await runTool(app, who.me, t.name, args ?? {}, { via: 'mcp', scopes: who.scopes, client: who.client });
        return { content: [{ type: 'text', text: toText(t.name, out) }] };
      } catch (e) {
        return { isError: true, content: [{ type: 'text', text: e.message }] };
      }
    });
  }
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => { transport.close(); server.close(); });
  await server.connect(transport);
  await transport.handleRequest(req, res, await bodyObject(req));
}

const INSTRUCTIONS = `This is wOS Chat, a team's chat: channels, direct messages and threads.
Be brief. Use chat.list_channels to see where things are, chat.read to read a channel or a thread, chat.search to find something.
Post with chat.post; answer inside a thread with chat.reply. Mention people with @handle (chat.list_people has the handles).
Never post on someone's behalf without being asked. Never invent messages.`;

async function handleUpload(app, req, res, url) {
  const who = await identify(app, req);
  if (!who) return json(res, 401, { ok: false, error: 'Sign in first.' });
  if (!who.scopes.includes('write')) return json(res, 403, { ok: false, error: 'This connection may not write.' });
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > app.files.maxBytes) return json(res, 413, { ok: false, error: `Files are at most ${Math.round(app.files.maxBytes / 1048576)} MB here.` });
    chunks.push(c);
  }
  const file = await app.files.put(who.me, { name: url.searchParams.get('name') ?? 'file', type: req.headers['content-type'], data: Buffer.concat(chunks) });
  json(res, 200, { ok: true, result: file });
}

async function handleDownload(app, req, res, p) {
  const who = await identify(app, req);
  if (!who) return json(res, 401, { error: 'Sign in first.' });
  const id = p.split('/')[2];
  const f = await app.files.readable(who.me, id);
  if (!f) return json(res, 404, { error: 'No such file.' });
  const data = await app.files.read(f);
  const inline = /^(image\/(png|jpeg|gif|webp)|application\/pdf|text\/plain)$/.test(f.type);
  res.writeHead(200, {
    'content-type': f.type, 'content-length': data.length, 'cache-control': 'private, max-age=3600',
    'content-disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(f.name)}`,
    'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
  }).end(data);
}

async function demoSwitch(app, req, res, host, handle) {
  const d = verify(cookieOf(req, DEMO_COOKIE), 'demo');
  if (!d) return redirect(res, '/');
  const p = await app.chat.findPerson(d.t, handle);
  if (!p || p.kind !== 'person') return redirect(res, '/');
  res.writeHead(302, { location: '/', 'set-cookie': setCookie(host, DEMO_COOKIE, sign({ k: 'demo', t: d.t, id: p.id }), 2 * DAY), 'cache-control': 'no-store' }).end();
}

function serveStatic(res, p) {
  const file = path.join(PUBLIC, path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(PUBLIC)) return res.writeHead(404).end();
  return serveFile(res, file);
}

function serveFile(res, file, type) {
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) return res.writeHead(404).end();
  res.writeHead(200, { 'content-type': type ?? TYPES[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache' }).end(fs.readFileSync(file));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const server = createServer();
  const port = Number(process.env.PORT || 3990);
  server.listen(port, async () => {
    const app = await server.ready;
    console.log(`wOS Chat on http://localhost:${port} (${app.demo ? 'demo, ' : ''}${app.db.kind}, files on ${app.files.mode}). Agents connect to /mcp.`);
  });
  const stop = async () => { server.close(); (await server.ready).close?.(); process.exit(0); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

export { esc, page };
