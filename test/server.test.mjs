import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { WebSocket } from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createServer } from '../server.mjs';
import { issueTokens, sign } from '../lib/auth.mjs';
import { createMailer } from '../lib/mail.mjs';
import { makeApp } from './helpers.mjs';

let t, server, base;
before(async () => {
  t = await makeApp();
  t.app.mailer = await createMailer({});
  server = createServer(t.app);
  await new Promise((r) => server.listen(0, r));
  await server.ready;
  base = `http://localhost:${server.address().port}`;
});
after(() => { server.closeAllConnections?.(); server.close(); });

const bearer = (p, o) => ({ authorization: `Bearer ${issueTokens(p, o).access_token}` });
const cookie = (p) => ({ cookie: `chat_session=${encodeURIComponent(issueTokens(p).access_token)}` });
const tool = (name, body, headers) => fetch(`${base}/api/tools/${name}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body ?? {}) }).then(async (r) => ({ status: r.status, ...(await r.json()) }));

async function mcp(p, { query = '', scopes } = {}) {
  const c = new Client({ name: 'test', version: '1' });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp${query}`), { requestInit: { headers: bearer(p, scopes ? { scopes } : {}) } }));
  return c;
}

test('health, manifest and catalogue are served', async () => {
  const h = await fetch(`${base}/health`).then((r) => r.json());
  assert.equal(h.ok, true);
  assert.ok(['sqlite', 'postgres'].includes(h.storage));
  const m = await fetch(`${base}/wos-app.json`).then((r) => r.json());
  assert.equal(m.id, 'chat');
  const c = await fetch(`${base}/tools.json`).then((r) => r.json());
  assert.ok(c.tools.length > 30);
});

test('pages need sign-in; the sign-in page offers GitHub and an email link', async () => {
  const r = await fetch(`${base}/`);
  const html = await r.text();
  assert.match(html, /Email me a link/);
  const ok = await fetch(`${base}/`, { headers: cookie(t.sam) }).then((x) => x.text());
  assert.match(ok, /\/app\/chat\.mjs/);
  assert.equal((await tool('chat.list_channels', {})).status, 401);
});

test('REST tools: the same handlers as MCP, with a browser origin check', async () => {
  const r = await tool('chat.post_message', { channel: 'general', body: 'from rest' }, cookie(t.sam));
  assert.equal(r.status, 200);
  assert.equal(r.result.body, 'from rest');
  const bad = await tool('chat.post_message', { channel: 'general', body: 'x' }, { ...cookie(t.sam), origin: 'https://evil.example' });
  assert.equal(bad.status, 403);
  const err = await tool('chat.read_messages', { channel: 'nope' }, cookie(t.sam));
  assert.equal(err.status, 404);
  assert.equal(err.error.code, 'not_found');
  assert.match(err.error.message, /No channel/);
  const none = await tool('chat.fly', {}, cookie(t.sam));
  assert.equal(none.status, 404);
  assert.equal(none.error.code, 'no_tool');
  const bad2 = await tool('chat.post_message', { channel: 'general' }, cookie(t.sam));
  assert.equal(bad2.error.code, 'invalid_input');
  // An app asking for a confirm: human tool gets 202 and an approval id.
  const pend = await tool('chat.remove_person', { person: 'riley' }, bearer(t.sam));
  assert.equal(pend.status, 202);
  assert.match(pend.pending.approval_id, /^ap_/);
});

test('MCP: every tool is listed, with dotted names or underscores for strict clients', async () => {
  const c = await mcp(t.sam);
  const names = (await c.listTools()).tools.map((x) => x.name);
  const catalogue = (await fetch(`${base}/tools.json`).then((r) => r.json())).tools.map((x) => x.name);
  assert.deepEqual(names.sort(), catalogue.sort());
  const out = await c.callTool({ name: 'chat.post_message', arguments: { channel: 'general', body: 'from claude' } });
  assert.equal(out.structuredContent.body, 'from claude');
  assert.equal(JSON.parse(out.content[0].text).id, out.structuredContent.id);
  const read = await c.callTool({ name: 'chat.read_messages', arguments: { channel: 'general' } });
  assert.ok(read.structuredContent.messages.some((m) => m.body === 'from claude'));
  await c.close();
  const u = await mcp(t.sam, { query: '?names=underscore' });
  assert.ok((await u.listTools()).tools.some((x) => x.name === 'chat_post_message'));
  await u.close();
  // A read-only connection only sees read tools.
  const ro = await mcp(t.jordan, { scopes: ['read'] });
  const roNames = (await ro.listTools()).tools.map((x) => x.name);
  assert.ok(roNames.includes('chat.read_messages') && !roNames.includes('chat.post_message'));
  await ro.close();
  const r = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(r.status, 401);
  assert.match(r.headers.get('www-authenticate'), /resource_metadata/);
});

test('MCP OAuth: register, authorize as the signed-in person, exchange with PKCE', async () => {
  const meta = await fetch(`${base}/.well-known/oauth-authorization-server`).then((r) => r.json());
  assert.equal(meta.token_endpoint, `${base}/oauth/token`);
  const reg = await fetch(meta.registration_endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'Claude', redirect_uris: ['http://localhost:9999/cb'] }) }).then((r) => r.json());
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challengeStr = crypto.createHash('sha256').update(verifier).digest('base64url');
  const q = new URLSearchParams({ client_id: reg.client_id, redirect_uri: 'http://localhost:9999/cb', code_challenge: challengeStr, code_challenge_method: 'S256', state: 's1', scope: 'read write' });
  const signedOut = await fetch(`${meta.authorization_endpoint}?${q}`, { redirect: 'manual' });
  assert.match(signedOut.headers.get('location'), /^\/login\?next=/);
  const a = await fetch(`${meta.authorization_endpoint}?${q}`, { redirect: 'manual', headers: cookie(t.casey) });
  const to = new URL(a.headers.get('location'));
  assert.equal(to.searchParams.get('state'), 's1');
  const tok = await fetch(meta.token_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code: to.searchParams.get('code'), client_id: reg.client_id, redirect_uri: 'http://localhost:9999/cb', code_verifier: verifier }) }).then((r) => r.json());
  assert.equal(tok.scope, 'read write');
  const r = await tool('chat.list_people', {}, { authorization: `Bearer ${tok.access_token}` });
  assert.equal(r.result.me.handle, 'casey');
  const del = await tool('chat.delete_message', { message: 'm_x' }, { authorization: `Bearer ${tok.access_token}` });
  assert.equal(del.status, 403);
  assert.equal(del.error.code, 'scope');
  const wrong = await fetch(meta.token_endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ grant_type: 'authorization_code', code: to.searchParams.get('code'), client_id: reg.client_id, code_verifier: 'nope' }) });
  assert.equal(wrong.status, 400);
});

test('live: a socket hears what it may see, and nothing from channels it is not in', async () => {
  const priv = await t.run(t.sam, 'chat.create_channel', { name: 'ws-private', private: true });
  const ws = new WebSocket(`${base.replace('http', 'ws')}/ws`, { headers: cookie(t.casey) });
  const got = [];
  await new Promise((r, j) => { ws.on('message', (m) => { const e = JSON.parse(m); got.push(e); if (e.type === 'hello') r(); }); ws.on('error', j); });
  await t.run(t.sam, 'chat.post_message', { channel: priv.id, body: 'secret' });
  await t.run(t.sam, 'chat.post_message', { channel: 'general', body: 'live hello' });
  await new Promise((r) => setTimeout(r, 150));
  ws.close();
  assert.ok(got.some((e) => e.type === 'chat.message.posted' && e.data.message.body === 'live hello' && e.id > 0));
  assert.ok(!got.some((e) => JSON.stringify(e).includes('secret')));
  assert.ok(!got.some((e) => 'audience' in e), 'audience lists never leave the server');
  const anon = new WebSocket(`${base.replace('http', 'ws')}/ws`);
  const code = await new Promise((r) => { anon.on('unexpected-response', (_, res) => r(res.statusCode)); anon.on('error', () => r('error')); });
  assert.equal(code, 401);
});

test('files: upload streams to /files, download checks who may read', async () => {
  const up = await fetch(`${base}/files/chat?name=${encodeURIComponent('hello world.txt')}`, { method: 'POST', headers: { ...cookie(t.sam), 'content-type': 'text/plain' }, body: 'hello' }).then((r) => r.json());
  assert.equal(up.result.name, 'hello world.txt');
  const priv = await t.run(t.sam, 'chat.create_channel', { name: 'files-private', private: true });
  await t.run(t.sam, 'chat.post_message', { channel: priv.id, body: 'file', files: [up.result.id] });
  const mine = await fetch(`${base}${up.result.url}`, { headers: cookie(t.sam) });
  assert.equal(await mine.text(), 'hello');
  assert.equal(mine.headers.get('x-content-type-options'), 'nosniff');
  assert.equal((await fetch(`${base}${up.result.url}`, { headers: cookie(t.casey) })).status, 404);
  assert.equal((await fetch(`${base}${up.result.url}`)).status, 401);
});

test('email link: a known person signs in; a stranger is told nothing', async () => {
  t.app.mailer.sent.length = 0;
  const start = await fetch(`${base}/auth/email`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'email=jordan%40birch-law.example&next=%2F' });
  assert.match(await start.text(), /Check your email/);
  const link = /http\S+verify\?t=\S+/.exec(t.app.mailer.sent[0].text)[0];
  const v = await fetch(link.replace(/^https?:\/\/[^/]+/, base), { redirect: 'manual' });
  assert.equal(v.status, 302);
  assert.match(v.headers.get('set-cookie'), /chat_session=/);
  t.app.mailer.sent.length = 0;
  const stranger = await fetch(`${base}/auth/email`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'email=nobody%40else.example' });
  assert.match(await stranger.text(), /Check your email/);
  assert.equal(t.app.mailer.sent.length, 0);
  const forged = await fetch(`${base}/auth/email/verify?t=${encodeURIComponent(sign({ k: 'email', e: 'jordan@birch-law.example', exp: 1 }))}`);
  assert.equal(forged.status, 400);
});

test('a brand-new server: the first person to sign in becomes the owner', async () => {
  const fresh = await makeApp();
  const empty = `empty-${Date.now().toString(36)}`;
  // makeApp already added people to "fresh"; use another team id for an empty one.
  fresh.app.teamId = empty;
  const { ensureTeamSetup } = await import('../lib/app.mjs');
  await ensureTeamSetup(fresh.app);
  fresh.app.mailer = await createMailer({});
  const s = createServer(fresh.app);
  await new Promise((r) => s.listen(0, r));
  const b = `http://localhost:${s.address().port}`;
  await fetch(`${b}/auth/email`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'email=first%40acme-dental.example' });
  const link = /http\S+verify\?t=\S+/.exec(fresh.app.mailer.sent[0].text)[0];
  await fetch(link.replace(/^https?:\/\/[^/]+/, b), { redirect: 'manual' });
  const owner = await fresh.app.chat.findPerson(empty, 'first');
  assert.equal(owner.role, 'owner');
  s.close();
});

test('demo: every visitor gets their own fictional team, and can switch who they are', async () => {
  const d = await makeApp({ CHAT_DEMO: '1' });
  d.app.mailer = await createMailer({});
  const s = createServer(d.app);
  await new Promise((r) => s.listen(0, r));
  const b = `http://localhost:${s.address().port}`;
  const one = await fetch(`${b}/`);
  const c1 = one.headers.get('set-cookie').split(';')[0];
  const two = await fetch(`${b}/`);
  const c2 = two.headers.get('set-cookie').split(';')[0];
  const t1 = await fetch(`${b}/api/tools/chat.get_settings`, { method: 'POST', headers: { cookie: c1, 'content-type': 'application/json' }, body: '{}' }).then((r) => r.json());
  const t2 = await fetch(`${b}/api/tools/chat.get_settings`, { method: 'POST', headers: { cookie: c2, 'content-type': 'application/json' }, body: '{}' }).then((r) => r.json());
  assert.notEqual(t1.result.team.id, t2.result.team.id);
  assert.equal(t1.result.team.name, 'Acme Dental');
  assert.equal(t1.result.me.handle, 'sam');
  const sw = await fetch(`${b}/demo/as/jordan`, { headers: { cookie: c1 }, redirect: 'manual' });
  const c3 = sw.headers.get('set-cookie').split(';')[0];
  const me = await fetch(`${b}/api/tools/chat.list_people`, { method: 'POST', headers: { cookie: c3, 'content-type': 'application/json' }, body: '{}' }).then((r) => r.json());
  assert.equal(me.result.me.handle, 'jordan');
  const chans = await fetch(`${b}/api/tools/chat.list_channels`, { method: 'POST', headers: { cookie: c1, 'content-type': 'application/json' }, body: '{}' }).then((r) => r.json());
  assert.ok(chans.result.channels.find((c) => c.name === 'front-desk').mentions >= 1);
  s.closeAllConnections?.();
  s.close();
});
