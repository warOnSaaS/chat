// A stand-in for account.waronsaas.com for tests: the OpenID Connect bits the account client uses (authorize, token,
// JWKS, session check, end-session), signing real RS256 ID tokens. Set stub.profile before a sign-in; stub.signedIn
// false makes a silent try (prompt=none) answer login_required; stub.end(sid) ends a session.
import http from 'node:http';
import crypto from 'node:crypto';

const b64u = (b) => Buffer.from(b).toString('base64url');

export async function startAccountStub({ clientId = 'chat-test', clientSecret = 'chat-test-secret' } = {}) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = 'k1';
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' };
  const codes = new Map();
  const dead = new Set();
  const stub = {
    clientId, clientSecret, signedIn: true, authorizations: [], tokens: [],
    profile: { sub: 'acct_1', email: 'sam@acme-dental.example', email_verified: true, name: 'Sam Rivera', github_login: null, teams: [] },
    end(sid) { dead.add(sid); },
  };
  const sign = (body) => {
    const h = b64u(JSON.stringify({ alg: 'RS256', kid, typ: 'JWT' }));
    const b = b64u(JSON.stringify(body));
    return `${h}.${b}.${b64u(crypto.sign('RSA-SHA256', Buffer.from(`${h}.${b}`), privateKey))}`;
  };
  const okBasic = (req) => {
    const [, v] = /^Basic (.+)$/.exec(req.headers.authorization ?? '') ?? [];
    if (!v) return false;
    const [id, secret] = Buffer.from(v, 'base64').toString().split(':').map(decodeURIComponent);
    return id === clientId && secret === clientSecret;
  };
  const body = (req) => new Promise((r) => { let s = ''; req.on('data', (c) => { s += c; }); req.on('end', () => r(s)); });
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    const out = (status, obj) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(obj));
    if (u.pathname === '/jwks.json') return out(200, { keys: [jwk] });
    if (u.pathname === '/oauth/authorize') {
      const q = Object.fromEntries(u.searchParams);
      stub.authorizations.push(q);
      const to = new URL(q.redirect_uri);
      if (q.state) to.searchParams.set('state', q.state);
      if (q.client_id !== clientId || q.code_challenge_method !== 'S256' || !q.code_challenge) { to.searchParams.set('error', 'invalid_request'); }
      else if (q.prompt === 'none' && !stub.signedIn) { to.searchParams.set('error', 'login_required'); }
      else {
        const code = crypto.randomBytes(12).toString('hex');
        codes.set(code, { nonce: q.nonce, challenge: q.code_challenge, redirect: q.redirect_uri, profile: { ...stub.profile }, sid: `ses_${crypto.randomBytes(6).toString('hex')}`, connection: q.connection ?? null });
        to.searchParams.set('code', code);
        to.searchParams.set('iss', stub.issuer);
      }
      return res.writeHead(302, { location: to.toString() }).end();
    }
    if (u.pathname === '/oauth/token' && req.method === 'POST') {
      if (!okBasic(req)) return out(401, { error: 'invalid_client' });
      const q = Object.fromEntries(new URLSearchParams(await body(req)));
      const c = codes.get(q.code);
      codes.delete(q.code);
      if (!c || c.redirect !== q.redirect_uri || crypto.createHash('sha256').update(q.code_verifier ?? '').digest('base64url') !== c.challenge) return out(400, { error: 'invalid_grant' });
      const now = Math.floor(Date.now() / 1000);
      const claims = { iss: stub.issuer, aud: clientId, iat: now, exp: now + 300, nonce: c.nonce, sid: c.sid, auth_time: now, amr: ['email'], ...c.profile };
      stub.tokens.push({ ...claims, connection: c.connection });
      return out(200, { id_token: sign(claims), access_token: `at_${c.sid}`, token_type: 'Bearer', expires_in: 3600 });
    }
    if (u.pathname === '/api/sessions/check' && req.method === 'POST') {
      if (!okBasic(req)) return out(401, { error: 'invalid_client' });
      const b = JSON.parse(await body(req));
      const sids = Array.isArray(b.sid) ? b.sid : [b.sid];
      return out(200, { sessions: Object.fromEntries(sids.map((s) => [s, !dead.has(s)])) });
    }
    if (u.pathname === '/oauth/end-session') {
      return res.writeHead(302, { location: u.searchParams.get('post_logout_redirect_uri') || '/' }).end();
    }
    out(404, { error: 'not_found' });
  });
  await new Promise((r) => server.listen(0, r));
  stub.issuer = `http://localhost:${server.address().port}`;
  stub.env = { AUTH_PROVIDER: 'waronsaas', WOS_ACCOUNT_URL: stub.issuer, WOS_ACCOUNT_CLIENT_ID: clientId, WOS_ACCOUNT_CLIENT_SECRET: clientSecret, PUBLIC_URL: 'http://localhost' };
  stub.close = () => { server.closeAllConnections?.(); server.close(); };
  return stub;
}
