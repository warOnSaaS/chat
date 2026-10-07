import crypto from 'node:crypto';
import { esc } from './html.mjs';

// Sign in with GitHub or with an email link. Agents (Claude, ChatGPT, Claude Code, Codex) connect to /mcp with
// standard MCP OAuth (discovery, dynamic client registration, PKCE) and the person signs in the same way.
// Tokens are signed and stateless; who is on the team comes from the database, so removing someone
// signs them out everywhere. Ported from agent-kanban's lib/auth.mjs and the CRM's.

const SECRET = () => process.env.OAUTH_SECRET || process.env.SESSION_SECRET || 'dev-secret-change-me';
const GH_WEB = () => process.env.GITHUB_WEB_BASE || 'https://github.com';
const GH_API = () => process.env.GITHUB_API_BASE || 'https://api.github.com';
const now = () => Math.floor(Date.now() / 1000);
const DAY = 24 * 3600;
export const COOKIE = 'chat_session';
export const DEMO_COOKIE = 'chat_demo';
export const ALL_SCOPES = ['read', 'write', 'delete', 'admin'];

export function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${crypto.createHmac('sha256', SECRET()).update(body).digest('base64url')}`;
}

export function verify(token, kind) {
  const [body, mac] = String(token ?? '').split('.');
  if (!body || !mac) return null;
  const want = crypto.createHmac('sha256', SECRET()).update(body).digest('base64url');
  if (want.length !== mac.length || !crypto.timingSafeEqual(Buffer.from(want), Buffer.from(mac))) return null;
  let p;
  try { p = JSON.parse(Buffer.from(body, 'base64url').toString()); } catch { return null; }
  if (p.k !== kind || (p.exp && p.exp < now())) return null;
  return p;
}

export const cookieOf = (req, name) => {
  const v = new RegExp(`(?:^|;\\s*)${name}=([^;]+)`).exec(req.headers.cookie ?? '')?.[1];
  return v ? decodeURIComponent(v) : null;
};

const secureFlag = (host) => (host.startsWith('https://') ? '; Secure' : '');
export const setCookie = (host, name, value, maxAge) => `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly${secureFlag(host)}; SameSite=Lax; Max-Age=${maxAge}`;

async function activePerson(app, id) {
  const p = id ? await app.chat.personRow(id) : null;
  return p && !p.deactivated_at ? p : null;
}

// Who is asking, and how: { me, via, scopes, client }.
export async function identify(app, req) {
  const bearer = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
  if (bearer) {
    const t = verify(bearer, 'access');
    const me = t && (await activePerson(app, t.id));
    return me ? { me, via: 'mcp', scopes: t.sc ?? ALL_SCOPES, client: t.a ?? null } : null;
  }
  if (app.demo) {
    const d = verify(cookieOf(req, DEMO_COOKIE), 'demo');
    const me = d && (await activePerson(app, d.id));
    return me && me.team_id === d.t ? { me, via: 'web', scopes: ALL_SCOPES, client: null } : null;
  }
  const s = verify(cookieOf(req, COOKIE), 'access');
  const me = s && (await activePerson(app, s.id));
  return me ? { me, via: 'web', scopes: ALL_SCOPES, client: null } : null;
}

export function issueTokens(person, { scopes = ALL_SCOPES, app: client } = {}) {
  const base = { id: person.id, sc: scopes, ...(client ? { a: String(client).slice(0, 60) } : {}) };
  return {
    access_token: sign({ k: 'access', ...base, exp: now() + 30 * DAY }),
    refresh_token: sign({ k: 'refresh', ...base, exp: now() + 365 * DAY }),
    token_type: 'bearer',
    expires_in: 30 * DAY,
    scope: scopes.join(' '),
  };
}

// ---------- discovery ----------

export const resourceMetadata = (host) => ({ resource: `${host}/mcp`, authorization_servers: [host], bearer_methods_supported: ['header'], resource_name: 'wOS Chat', scopes_supported: ALL_SCOPES });
export const serverMetadata = (host) => ({
  issuer: host,
  authorization_endpoint: `${host}/oauth/authorize`,
  token_endpoint: `${host}/oauth/token`,
  registration_endpoint: `${host}/oauth/register`,
  response_types_supported: ['code'],
  grant_types_supported: ['authorization_code', 'refresh_token'],
  code_challenge_methods_supported: ['S256'],
  token_endpoint_auth_methods_supported: ['none'],
  scopes_supported: ALL_SCOPES,
});
export const challenge = (host) => `Bearer resource_metadata="${host}/.well-known/oauth-protected-resource"`;

// ---------- MCP clients ----------

export async function handleRegister(req, res) {
  const b = await bodyObject(req);
  const uris = Array.isArray(b.redirect_uris) ? b.redirect_uris.filter(okRedirect) : [];
  if (!uris.length) return json(res, 400, { error: 'invalid_redirect_uri' });
  const client_id = sign({ k: 'client', r: uris, n: String(b.client_name ?? '').slice(0, 80) });
  json(res, 201, { client_id, client_name: b.client_name, redirect_uris: uris, grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none', client_id_issued_at: now() });
}

function okRedirect(uri) {
  try {
    const u = new URL(uri);
    return u.protocol === 'https:' || (u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname));
  } catch { return false; }
}

const scopesFrom = (s) => { const want = String(s ?? '').split(/[\s,]+/).filter((x) => ALL_SCOPES.includes(x)); return want.length ? want : ALL_SCOPES; };

// The app asks for access. A signed-in person gets a code straight away; anyone else signs in first.
export async function handleAuthorize(app, req, res, host) {
  const url = new URL(req.url, 'http://x');
  const q = Object.fromEntries(url.searchParams);
  const c = verify(q.client_id, 'client');
  if (!c || !c.r.includes(q.redirect_uri)) return page(res, 400, '<h1>This sign-in link is not valid</h1><p>Start again from your app.</p>');
  if (!q.code_challenge || (q.code_challenge_method ?? 'S256') !== 'S256') return page(res, 400, '<h1>This app must use PKCE</h1>');
  const who = await identify(app, { headers: { cookie: req.headers.cookie } });
  if (!who) {
    const next = `/oauth/authorize?${url.searchParams}`.replace(/[?&]__p=[^&]*/, '');
    res.writeHead(302, { location: `/login?next=${encodeURIComponent(next)}`, 'cache-control': 'no-store' }).end();
    return;
  }
  const code = sign({ k: 'code', id: who.me.id, c: q.client_id, r: q.redirect_uri, cc: q.code_challenge, sc: scopesFrom(q.scope), a: c.n, exp: now() + 300 });
  const to = new URL(q.redirect_uri);
  to.searchParams.set('code', code);
  if (q.state) to.searchParams.set('state', q.state);
  res.writeHead(302, { location: to.toString(), 'cache-control': 'no-store' }).end();
}

export async function handleToken(app, req, res) {
  const q = await bodyObject(req);
  const client = verify(q.client_id, 'client');
  if (!client) return json(res, 401, { error: 'invalid_client' });
  let grant = null;
  if (q.grant_type === 'authorization_code') {
    grant = verify(q.code, 'code');
    if (grant && (grant.c !== q.client_id || (q.redirect_uri && grant.r !== q.redirect_uri))) grant = null;
    if (grant && crypto.createHash('sha256').update(String(q.code_verifier ?? '')).digest('base64url') !== grant.cc) grant = null;
  } else if (q.grant_type === 'refresh_token') {
    grant = verify(q.refresh_token, 'refresh');
  }
  const me = grant && (await activePerson(app, grant.id));
  if (!me) return json(res, 400, { error: 'invalid_grant' });
  json(res, 200, issueTokens(me, { scopes: grant.sc ?? ALL_SCOPES, app: grant.a }));
}

// ---------- browser sign-in ----------

const safeNext = (n) => (n && n.startsWith('/') && !n.startsWith('//') ? n : '/');

export function loginPage(app, res, next = '/', note = '') {
  const gh = !!process.env.GITHUB_OAUTH_CLIENT_ID;
  const mail = true;
  page(res, 200, `<span class="gate-mark" aria-hidden="true"></span><h1>${esc(app.teamName)}</h1><p>Team chat. Sign in to join the conversation.</p>${note ? `<p class="gate-note">${note}</p>` : ''}
  ${gh ? `<a class="ui-btn is-accent is-block is-lg" data-auth href="/login/github?next=${encodeURIComponent(next)}">Sign in with GitHub</a>` : ''}
  ${mail ? `<form method="post" action="/auth/email" class="gate-form" data-auth><input type="hidden" name="next" value="${esc(next)}"><label class="ui-field"><span>Or get a sign-in link by email</span><input class="ui-input" type="email" name="email" required placeholder="you@company.example" autocomplete="email"></label><button class="ui-btn is-quiet is-block" type="submit">Email me a link</button></form>` : ''}`);
}

export function githubRedirect(res, host, next) {
  const state = sign({ k: 'gh', web: safeNext(next), exp: now() + 900 });
  const u = new URL(`${GH_WEB()}/login/oauth/authorize`);
  u.searchParams.set('client_id', process.env.GITHUB_OAUTH_CLIENT_ID ?? '');
  u.searchParams.set('redirect_uri', `${host}/oauth/github/callback`);
  u.searchParams.set('scope', 'read:user user:email');
  u.searchParams.set('state', state);
  res.writeHead(302, { location: u.toString(), 'cache-control': 'no-store' }).end();
}

export async function handleGithubCallback(app, req, res, host) {
  const q = Object.fromEntries(new URL(req.url, 'http://x').searchParams);
  const st = verify(q.state, 'gh');
  if (!st || !q.code) return page(res, 400, '<h1>Sign-in expired</h1><p><a href="/login">Try again</a>.</p>');
  const tok = await fetch(`${GH_WEB()}/login/oauth/access_token`, {
    method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ client_id: process.env.GITHUB_OAUTH_CLIENT_ID, client_secret: process.env.GITHUB_OAUTH_CLIENT_SECRET, code: q.code, redirect_uri: `${host}/oauth/github/callback` }),
  }).then((r) => r.json()).catch(() => ({}));
  if (!tok.access_token) return page(res, 400, '<h1>GitHub sign-in failed</h1><p><a href="/login">Try again</a>.</p>');
  const gh = (p) => fetch(`${GH_API()}${p}`, { headers: { authorization: `Bearer ${tok.access_token}`, accept: 'application/vnd.github+json', 'user-agent': 'wos-chat' } }).then((r) => (r.ok ? r.json() : null));
  const [user, emails] = await Promise.all([gh('/user'), gh('/user/emails')]);
  if (!user?.login) return page(res, 400, '<h1>GitHub sign-in failed</h1><p><a href="/login">Try again</a>.</p>');
  const verified = (emails ?? []).filter((e) => e.verified).map((e) => e.email.toLowerCase());
  const me = await personForSignIn(app, { github: user.login, emails: verified, name: user.name || user.login });
  if (!me) return page(res, 403, `<h1>Hi @${esc(user.login)}</h1><p>You're signed in to GitHub, but you're not on this team yet. Ask a team admin to add <b>${esc(user.login)}</b>, then sign in again.</p>`);
  signedIn(res, host, me, st.web);
}

// Email link: always the same answer, so the form never tells a stranger who is on the team.
export async function handleEmailStart(app, req, res, host, mailer) {
  const b = await bodyObject(req);
  const email = String(b.email ?? '').trim().toLowerCase();
  const next = safeNext(b.next);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return loginPage(app, res, next, 'That email address does not look right.');
  const known = await app.db.get('select id from chat_people where team_id = $1 and lower(email) = $2 and deactivated_at is null', [app.teamId, email]);
  const empty = !(await app.db.get(`select id from chat_people where team_id = $1 and kind = 'person'`, [app.teamId]));
  if (known || empty) {
    const t = sign({ k: 'email', e: email, web: next, exp: now() + 900 });
    const link = `${host}/auth/email/verify?t=${encodeURIComponent(t)}`;
    await mailer.send({ to: email, subject: `Sign in to ${app.teamName}`, text: `Here is your sign-in link for ${app.teamName}. It works once, for 15 minutes:\n\n${link}\n\nIf you did not ask for it, ignore this email.` });
  }
  page(res, 200, `<h1>Check your email</h1><p>If ${esc(email)} is on this team, a sign-in link is on its way. It works for 15 minutes.</p>${mailer.ready ? '' : '<p class="gate-note">This server has no email set up (SMTP_URL), so the link was written to the server log.</p>'}`);
}

export async function handleEmailVerify(app, req, res, host) {
  const t = verify(new URL(req.url, 'http://x').searchParams.get('t'), 'email');
  if (!t) return page(res, 400, '<h1>That link has expired</h1><p><a href="/login">Get a new one</a>.</p>');
  const me = await personForSignIn(app, { emails: [t.e], name: t.e.split('@')[0] });
  if (!me) return page(res, 403, '<h1>Not on this team</h1><p>Ask a team admin to add your email.</p>');
  signedIn(res, host, me, t.web);
}

function signedIn(res, host, me, next) {
  const t = issueTokens(me);
  res.writeHead(302, { location: safeNext(next), 'set-cookie': setCookie(host, COOKIE, t.access_token, 30 * DAY), 'cache-control': 'no-store' }).end();
}

// Someone already on the team, matched by GitHub login or a verified email. On a brand-new server the
// first person to sign in becomes the owner.
async function personForSignIn(app, { github, emails = [], name }) {
  const db = app.db;
  const team = app.teamId;
  if (github) {
    const p = await db.get('select * from chat_people where team_id = $1 and lower(github) = $2 and deactivated_at is null', [team, github.toLowerCase()]);
    if (p) return p;
  }
  for (const e of emails) {
    const p = await db.get('select * from chat_people where team_id = $1 and lower(email) = $2 and deactivated_at is null', [team, e]);
    if (p) {
      if (github && !p.github) await db.run('update chat_people set github = $2 where id = $1', [p.id, github]);
      return p;
    }
  }
  const anyone = await db.get(`select id from chat_people where team_id = $1 and kind = 'person'`, [team]);
  if (anyone) return null;
  const p = await app.chat.addPerson(team, { name, handle: github ?? name, email: emails[0] ?? null, github: github ?? null, role: 'owner' });
  return app.chat.personRow(p.id);
}

// ---------- bits ----------

export async function bodyObject(req) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
  let s = typeof req.body === 'string' ? req.body : '';
  if (!s) for await (const c of req) { s += c; if (s.length > 1e6) break; }
  if (!s) return {};
  try { return (req.headers['content-type'] ?? '').includes('json') ? JSON.parse(s) : Object.fromEntries(new URLSearchParams(s)); } catch { return {}; }
}

export const json = (res, status, obj, headers = {}) => res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers }).end(JSON.stringify(obj));

export function page(res, status, inner) {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex' }).end(`<!doctype html><html lang="en" data-scheme="ops" data-mode="auto"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sign in · Chat</title><meta name="robots" content="noindex">
<link rel="stylesheet" href="/ui/src/ui.css"><link rel="stylesheet" href="/ui/src/tokens.css"><link rel="stylesheet" href="/app/chat.css">
</head><body class="gate"><main class="gate-card">${inner}</main></body></html>`);
}
