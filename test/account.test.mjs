import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { WebSocket } from 'ws';
import { createServer } from '../server.mjs';
import { createMailer } from '../lib/mail.mjs';
import { makeApp, ensureTeamSetup } from './helpers.mjs';
import { startAccountStub } from './account-stub.mjs';

// The hosted copy (AUTH_PROVIDER=waronsaas): look freely, sign in to use. Sign-in happens at the warOnSaaS account,
// stood in for here by test/account-stub.mjs.

let t, server, base, stub;
before(async () => {
  stub = await startAccountStub();
  t = await makeApp(stub.env);
  await ensureTeamSetup(t.app); // the helper's team, with #general, as a team that added people before the account existed
  t.app.mailer = await createMailer({});
  server = createServer(t.app);
  await new Promise((r) => server.listen(0, r));
  await server.ready;
  base = `http://localhost:${server.address().port}`;
});
after(() => { server.closeAllConnections?.(); server.close(); stub.close(); });

// A browser: keeps cookies, follows redirects by hand so each hop can be checked.
function browser() {
  const jar = new Map();
  const keep = (r) => { for (const c of r.headers.getSetCookie?.() ?? []) { const [kv, ...attrs] = c.split(';'); const [k, v] = kv.split('='); if (/max-age=0/i.test(attrs.join(';'))) jar.delete(k.trim()); else jar.set(k.trim(), v); } };
  const headers = () => ({ cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') });
  const get = async (url, extra = {}) => { const r = await fetch(url, { redirect: 'manual', headers: { ...headers(), ...extra.headers }, ...extra }); keep(r); return r; };
  // Follows redirects across the app and the stub until a page answers 200 (or the hop limit).
  const follow = async (url, { stopAt = null, max = 8 } = {}) => {
    const hops = [];
    for (let i = 0; i < max; i++) {
      const r = await get(url);
      hops.push(url);
      if (r.status !== 302 || (stopAt && stopAt(r.headers.get('location')))) return { r, url, hops };
      url = new URL(r.headers.get('location'), url).toString();
    }
    throw new Error(`too many redirects: ${hops.join(' -> ')}`);
  };
  const tool = (name, body = {}) => fetch(`${base}/api/tools/${name}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers() }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, ...(await r.json()) }));
  return { jar, get, follow, tool, headers };
}

test('signed out: the main page renders the example team (200, no redirect) with the account prompt', async () => {
  const b = browser();
  const r = await b.get(`${base}/`);
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.match(html, /\/app\/page\.mjs/);
  assert.match(html, /prompt\.js" defer data-signed-in="false" data-app="Chat" data-signin="\/auth\/waronsaas"/);
  assert.match(html, /"viewer":true/);
  assert.ok(b.jar.has('chat_demo'));
  // Reading works, as a viewer of a fictional team of their own.
  const people = await b.tool('chat.list_people');
  assert.equal(people.status, 200);
  assert.equal(people.result.me.handle, 'sam');
  const settings = await b.tool('chat.get_settings');
  assert.equal(settings.result.team.name, 'Acme Dental');
  assert.match(settings.result.team.id, /^demo_/);
  // The hash routes are the same page: deep links stay open too.
  assert.equal((await b.get(`${base}/some/where`)).status, 200);
  // The health check and catalogue stay open.
  assert.equal((await fetch(`${base}/health`)).status, 200);
});

test('signed out: any action over REST, MCP or upload answers 401 sign_in', async () => {
  const none = await fetch(`${base}/api/tools/chat.post_message`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ channel: 'general', body: 'x' }) });
  assert.equal(none.status, 401);
  assert.deepEqual((await none.json()).error, { code: 'sign_in', message: 'Sign in to your warOnSaaS account' });
  // A viewer (looking at the example team) may read but not write.
  const b = browser();
  await b.get(`${base}/`);
  const post = await b.tool('chat.post_message', { channel: 'general', body: 'hello' });
  assert.equal(post.status, 401);
  assert.equal(post.error.code, 'sign_in');
  const react = await b.tool('chat.add_reaction', { message: 'm_x', emoji: '👍' });
  assert.equal(react.status, 401);
  const ch = await b.tool('chat.create_channel', { name: 'nope' });
  assert.equal(ch.status, 401);
  const read = await b.tool('chat.read_messages', { channel: 'general' });
  assert.equal(read.status, 200);
  const up = await fetch(`${base}/files/chat?name=a.txt`, { method: 'POST', headers: { ...b.headers(), 'content-type': 'text/plain' }, body: 'hi' });
  assert.equal(up.status, 401);
  const mcp = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(mcp.status, 401);
  assert.equal((await mcp.json()).error.code, 'sign_in');
  // The viewer's socket hears its own example team, and nothing else.
  const ws = new WebSocket(`${base.replace('http', 'ws')}/ws`, { headers: b.headers() });
  const hello = await new Promise((r, j) => { ws.on('message', (m) => r(JSON.parse(m))); ws.on('error', j); });
  assert.equal(hello.type, 'hello');
  ws.close();
  const anon = new WebSocket(`${base.replace('http', 'ws')}/ws`);
  const code = await new Promise((r) => { anon.on('unexpected-response', (_, res) => r(res.statusCode)); anon.on('error', () => r('error')); });
  assert.equal(code, 401);
});

test('the app\'s own sign-in routes send people to the account; GitHub and email-link routes are off', async () => {
  const login = await fetch(`${base}/login?next=%2F%23%2Fsettings`, { redirect: 'manual' });
  assert.equal(login.status, 302);
  assert.equal(login.headers.get('location'), '/auth/waronsaas?next=%2F%23%2Fsettings');
  assert.equal((await fetch(`${base}/auth/email`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'email=a%40b.example' })).status, 404);
  assert.equal((await fetch(`${base}/auth/email/verify?t=x`, { redirect: 'manual' })).status, 404);
  assert.equal((await fetch(`${base}/oauth/github/callback?code=x`, { redirect: 'manual' })).status, 404);
  const start = await fetch(`${base}/auth/waronsaas?next=%2F&provider=github`, { redirect: 'manual' });
  assert.equal(start.status, 302);
  const to = new URL(start.headers.get('location'));
  assert.equal(to.origin, stub.issuer);
  assert.equal(to.pathname, '/oauth/authorize');
  assert.equal(to.searchParams.get('provider'), 'github');
  assert.equal(to.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(to.searchParams.get('redirect_uri'), `${base}/auth/waronsaas/callback`);
  assert.match(start.headers.get('set-cookie'), /wos_acct_flow=.*Path=\/auth\/waronsaas\/callback/);
});

test('callback: someone a team already added (verified email) signs in as that person, and gets the account id', async () => {
  stub.profile = { sub: 'acct_sam', email: 'sam@birch-law.example', email_verified: true, name: 'Sam R', github_login: null, teams: [] };
  const b = browser();
  const { r, hops } = await b.follow(`${base}/auth/waronsaas?next=%2F%23%2Fc%2Fgeneral`, { stopAt: (l) => l.startsWith('/') });
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), '/#/c/general');
  assert.ok(hops.some((h) => h.startsWith(`${stub.issuer}/oauth/authorize`)));
  assert.ok(b.jar.has('chat_session'));
  assert.ok(!b.jar.has('wos_acct_flow'), 'the flow cookie is cleared');
  const me = await b.tool('chat.list_people');
  assert.equal(me.result.me.id, t.sam.id);
  assert.equal((await t.app.chat.personRow(t.sam.id)).sub, 'acct_sam');
  const page = await b.get(`${base}/`);
  assert.match(await page.text(), /data-signed-in="true"/);
  // Posting works now.
  const post = await b.tool('chat.post_message', { channel: 'general', body: 'signed in through the account' });
  assert.equal(post.status, 200);
  // Signing in again finds the same person by account id, even with another email.
  stub.profile = { ...stub.profile, email: 'sam.new@birch-law.example' };
  const b2 = browser();
  await b2.follow(`${base}/auth/waronsaas?next=%2F`, { stopAt: (l) => l.startsWith('/') });
  assert.equal((await b2.tool('chat.list_people')).result.me.id, t.sam.id);
});

test('callback: a new account gets a workspace of its own, or joins the team its account names', async () => {
  stub.profile = { sub: 'acct_new', email: 'jamie@someplace.example', email_verified: true, name: 'Jamie Park', github_login: 'jamiep', teams: [] };
  const b = browser();
  await b.follow(`${base}/auth/waronsaas?next=%2F`, { stopAt: (l) => l.startsWith('/') });
  const s = await b.tool('chat.get_settings');
  assert.equal(s.status, 200);
  assert.equal(s.result.team.id, 'acct_acct_new');
  assert.equal(s.result.team.name, "Jamie's chat");
  assert.equal(s.result.me.role, 'owner');
  assert.equal(s.result.me.handle, 'jamiep');
  const chans = await b.tool('chat.list_channels');
  assert.deepEqual(chans.result.channels.map((c) => c.name).sort(), ['general', 'random']);
  assert.equal((await b.tool('chat.post_message', { channel: 'general', body: 'first' })).status, 200);
  // Someone whose account is on a team joins that team, with the team's role.
  stub.profile = { sub: 'acct_t1', email: 'lee@birch.example', email_verified: true, name: 'Lee Kim', github_login: null, teams: [{ id: 'tm_birch', slug: 'birch', name: 'Birch Law', role: 'admin' }] };
  const c = browser();
  await c.follow(`${base}/auth/waronsaas?next=%2F`, { stopAt: (l) => l.startsWith('/') });
  const s2 = await c.tool('chat.get_settings');
  assert.equal(s2.result.team.id, 'acct_team_tm_birch');
  assert.equal(s2.result.team.name, 'Birch Law');
  assert.equal(s2.result.me.role, 'admin');
  stub.profile = { sub: 'acct_t2', email: 'pat@birch.example', email_verified: true, name: 'Pat Doe', github_login: null, teams: [{ id: 'tm_birch', slug: 'birch', name: 'Birch Law', role: 'member' }] };
  const d = browser();
  await d.follow(`${base}/auth/waronsaas?next=%2F`, { stopAt: (l) => l.startsWith('/') });
  const s3 = await d.tool('chat.get_settings');
  assert.equal(s3.result.team.id, 'acct_team_tm_birch');
  assert.equal(s3.result.me.role, 'member');
  const people = await d.tool('chat.list_people');
  assert.ok(people.result.people.some((p) => p.handle === 'lee'));
  // Two people with the same wanted handle in one team get different handles.
  stub.profile = { sub: 'acct_t3', email: 'lee@other.example', email_verified: true, name: 'Lee Other', github_login: null, teams: [{ id: 'tm_birch', slug: 'birch', name: 'Birch Law', role: 'member' }] };
  const e = browser();
  await e.follow(`${base}/auth/waronsaas?next=%2F`, { stopAt: (l) => l.startsWith('/') });
  assert.equal((await e.tool('chat.list_people')).result.me.handle, 'lee2');
});

test('a silent try that is not signed in, or a cancel, goes back to the page still signed out and still open', async () => {
  stub.signedIn = false;
  const b = browser();
  const { r } = await b.follow(`${base}/auth/waronsaas?next=%2F%23%2Fbrowse&prompt=none`, { stopAt: (l) => l.startsWith('/') });
  stub.signedIn = true;
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), '/#/browse');
  assert.ok(!b.jar.has('chat_session'));
  const page = await b.get(`${base}/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /data-signed-in="false"/);
  // A stale or forged callback is also harmless.
  const stale = await fetch(`${base}/auth/waronsaas/callback?code=x&state=y`, { redirect: 'manual' });
  assert.equal(stale.status, 302);
  assert.equal(stale.headers.get('location'), '/');
});

test('a dead account session signs the person out of the app too; Sign out clears the app and ends the account session', async () => {
  stub.profile = { sub: 'acct_dead', email: 'dee@someplace.example', email_verified: true, name: 'Dee Vale', github_login: null, teams: [] };
  const b = browser();
  await b.follow(`${base}/auth/waronsaas?next=%2F`, { stopAt: (l) => l.startsWith('/') });
  assert.equal((await b.tool('chat.list_people')).status, 200);
  const sid = stub.tokens.at(-1).sid;
  assert.match(sid, /^ses_/);
  stub.end(sid);
  t.app.account.live.clear(); // the minute's cache
  const after1 = await b.tool('chat.post_message', { channel: 'general', body: 'still here?' });
  assert.equal(after1.status, 401);
  assert.equal(after1.error.code, 'sign_in');
  const page = await b.get(`${base}/`);
  assert.match(await page.text(), /data-signed-in="false"/);
  // Sign out.
  const c = browser();
  await c.follow(`${base}/auth/waronsaas?next=%2F`, { stopAt: (l) => l.startsWith('/') });
  const out = await c.get(`${base}/logout`);
  assert.equal(out.status, 302);
  const to = new URL(out.headers.get('location'));
  assert.equal(`${to.origin}${to.pathname}`, `${stub.issuer}/oauth/end-session`);
  assert.equal(to.searchParams.get('post_logout_redirect_uri'), `${base}/`);
  assert.ok(!c.jar.has('chat_session'));
});

test('MCP: an AI app connects through the account as a connection, and its tokens follow the account session', async () => {
  const meta = await fetch(`${base}/.well-known/oauth-authorization-server`).then((r) => r.json());
  const reg = await fetch(meta.registration_endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'Claude', redirect_uris: ['http://localhost:9999/cb'] }) }).then((r) => r.json());
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challengeStr = crypto.createHash('sha256').update(verifier).digest('base64url');
  const q = new URLSearchParams({ client_id: reg.client_id, redirect_uri: 'http://localhost:9999/cb', code_challenge: challengeStr, code_challenge_method: 'S256', state: 's1', scope: 'read write' });
  stub.profile = { sub: 'acct_sam', email: 'sam@birch-law.example', email_verified: true, name: 'Sam R', github_login: null, teams: [] };
  const b = browser();
  const { r } = await b.follow(`${meta.authorization_endpoint}?${q}`, { stopAt: (l) => l.startsWith('http://localhost:9999/') });
  assert.equal(r.status, 302);
  const auth = stub.authorizations.at(-1);
  assert.equal(auth.connection, 'Claude via Chat');
  assert.match(auth.scope, /offline_access/);
  const to = new URL(r.headers.get('location'));
  assert.equal(to.searchParams.get('state'), 's1');
  const tok = await fetch(meta.token_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code: to.searchParams.get('code'), client_id: reg.client_id, redirect_uri: 'http://localhost:9999/cb', code_verifier: verifier }) }).then((r) => r.json());
  assert.equal(tok.scope, 'read write');
  const who = await fetch(`${base}/api/tools/chat.list_people`, { method: 'POST', headers: { authorization: `Bearer ${tok.access_token}`, 'content-type': 'application/json' }, body: '{}' }).then((r) => r.json());
  assert.equal(who.result.me.id, t.sam.id);
  // The account ends the connection: the token stops working, and so does its refresh token.
  const sid = stub.tokens.at(-1).sid;
  stub.end(sid);
  t.app.account.live.clear();
  const gone = await fetch(`${base}/api/tools/chat.list_people`, { method: 'POST', headers: { authorization: `Bearer ${tok.access_token}`, 'content-type': 'application/json' }, body: '{}' });
  assert.equal(gone.status, 401);
  const refresh = await fetch(meta.token_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tok.refresh_token, client_id: reg.client_id }) });
  assert.equal(refresh.status, 400);
  // Cancelled at the account: the AI app hears access_denied.
  stub.signedIn = false;
  const c = browser();
  const q2 = new URLSearchParams({ ...Object.fromEntries(q), state: 's2' });
  // A cancel at the account comes back as an error; the stub only does that for a silent try, so ask for one.
  const start = await c.get(`${meta.authorization_endpoint}?${q2}`);
  const acct = new URL(start.headers.get('location'));
  acct.searchParams.set('prompt', 'none');
  const { r: denied } = await c.follow(acct.toString(), { stopAt: (l) => l.startsWith('http://localhost:9999/') });
  stub.signedIn = true;
  const back = new URL(denied.headers.get('location'));
  assert.equal(back.searchParams.get('error'), 'access_denied');
  assert.equal(back.searchParams.get('state'), 's2');
});
