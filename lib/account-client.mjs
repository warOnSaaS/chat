// COPIED from warOnSaaS/account client/account-client.mjs by scripts/sync-account.mjs. Do not edit here;
// change it in the account repo and run npm run sync-account.
// warOnSaaS Account client for our apps. No dependencies: copy this one file into an app (scripts/sync-account.mjs
// in each app does it) or import it from the account package.
//
//   const account = new WosAccount({ issuer, clientId, clientSecret, redirectUri, secret });
//   GET /auth/waronsaas           -> const { location, cookie } = account.start({ next: '/board' })
//   GET /auth/waronsaas/callback  -> const r = await account.finish(req)   // { profile, next, carry } or { error, next }
//   account.isLive(profile.sid)   -> false after "sign out everywhere" (cached a minute)
//   account.limit(sub, 'scanner.scan', 20, 3600) -> { ok, remaining, reset_at }
//   account.brand(teamSlug)       -> the team brand kit, or null
//
// The flow is OpenID Connect, authorization code with PKCE. State, verifier and nonce ride in a short-lived signed
// cookie scoped to the callback path, so nothing secret travels in the address bar.
import crypto from 'node:crypto';

const b64u = (b) => Buffer.from(b).toString('base64url');
const FLOW = 'wos_acct_flow';

export class WosAccount {
  constructor({ issuer = 'https://account.waronsaas.com', clientId, clientSecret, redirectUri, secret, fetch: f = globalThis.fetch, cookiePath = null } = {}) {
    if (!clientId || !clientSecret) throw new Error('WosAccount needs clientId and clientSecret (WOS_ACCOUNT_CLIENT_ID, WOS_ACCOUNT_CLIENT_SECRET)');
    Object.assign(this, { issuer: issuer.replace(/\/$/, ''), clientId, clientSecret, redirectUri, secret: secret || clientSecret, fetch: f });
    this.cookiePath = cookiePath ?? (redirectUri ? new URL(redirectUri).pathname : '/');
    this.live = new Map();
    this.brands = new Map();
    this.keys = null;
  }

  static fromEnv(env = process.env, { redirectUri, secret } = {}) {
    if (!env.WOS_ACCOUNT_CLIENT_ID || !env.WOS_ACCOUNT_CLIENT_SECRET) return null;
    return new WosAccount({ issuer: env.WOS_ACCOUNT_URL || 'https://account.waronsaas.com', clientId: env.WOS_ACCOUNT_CLIENT_ID, clientSecret: env.WOS_ACCOUNT_CLIENT_SECRET, redirectUri, secret });
  }

  // ---------- sign in ----------

  /**
   * Where to send the browser to sign in, and the cookie to set. Options:
   *   next: path to return to; carry: anything the app needs back (an MCP authorization request, say);
   *   prompt: 'none' for silent sign-in; provider: 'github' | 'google' to skip the choice;
   *   connection: a label like "Claude via CRM" when an AI app is connecting (makes a long-lived connection);
   *   loginHint: an email to prefill; redirectUri: per-request override (one deployment, many hosts).
   */
  start({ next = '/', carry = null, prompt = null, provider = null, connection = null, loginHint = null, redirectUri = null, secure = true } = {}) {
    const verifier = b64u(crypto.randomBytes(32));
    const state = b64u(crypto.randomBytes(16));
    const nonce = b64u(crypto.randomBytes(16));
    const ru = redirectUri ?? this.redirectUri;
    const u = new URL(`${this.issuer}/oauth/authorize`);
    u.searchParams.set('client_id', this.clientId);
    u.searchParams.set('redirect_uri', ru);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('scope', `openid profile email teams${connection ? ' offline_access' : ''}`);
    u.searchParams.set('state', state);
    u.searchParams.set('nonce', nonce);
    u.searchParams.set('code_challenge', b64u(crypto.createHash('sha256').update(verifier).digest()));
    u.searchParams.set('code_challenge_method', 'S256');
    if (prompt) u.searchParams.set('prompt', prompt);
    if (provider) u.searchParams.set('provider', provider);
    if (connection) u.searchParams.set('connection', String(connection).slice(0, 80));
    if (loginHint) u.searchParams.set('login_hint', loginHint);
    const flow = this.#seal({ state, verifier, nonce, next, carry, ru, exp: Math.floor(Date.now() / 1000) + 900 });
    const cookie = `${FLOW}=${flow}; Path=${this.cookiePath}; HttpOnly; SameSite=Lax; Max-Age=900${secure ? '; Secure' : ''}`;
    return { location: u.toString(), cookie };
  }

  /** Finishes sign-in on the callback. Returns { profile, next, carry, tokens, clear } or { error, next, clear }. */
  async finish(req) {
    const url = new URL(req.url, 'http://x');
    const q = Object.fromEntries(url.searchParams);
    const raw = new RegExp(`(?:^|;\\s*)${FLOW}=([^;]+)`).exec(req.headers.cookie ?? '')?.[1];
    const flow = raw ? this.#open(raw) : null;
    const clear = `${FLOW}=; Path=${this.cookiePath}; HttpOnly; SameSite=Lax; Max-Age=0`;
    if (!flow || flow.state !== q.state) return { error: 'expired', next: flow?.next ?? '/', carry: flow?.carry ?? null, clear };
    if (q.error) return { error: q.error, next: flow.next, carry: flow.carry, clear };
    if (q.iss && q.iss !== this.issuer) return { error: 'wrong_issuer', next: flow.next, clear };
    const tokens = await this.#token({ grant_type: 'authorization_code', code: q.code, redirect_uri: flow.ru, code_verifier: flow.verifier });
    if (!tokens.id_token) return { error: tokens.error || 'token_failed', next: flow.next, carry: flow.carry, clear };
    const profile = await this.verifyIdToken(tokens.id_token, { nonce: flow.nonce });
    if (!profile) return { error: 'bad_id_token', next: flow.next, clear };
    return { profile, tokens, next: flow.next, carry: flow.carry, clear };
  }

  /** Checks an ID token's signature (RS256, against /jwks.json), issuer, audience, expiry and nonce. */
  async verifyIdToken(jwt, { nonce = null } = {}) {
    const [h, b, s] = String(jwt).split('.');
    if (!h || !b || !s) return null;
    let head, body;
    try { head = JSON.parse(Buffer.from(h, 'base64url')); body = JSON.parse(Buffer.from(b, 'base64url')); } catch { return null; }
    if (head.alg !== 'RS256') return null;
    let jwk = (await this.#jwks()).find((k) => k.kid === head.kid);
    if (!jwk) { this.keys = null; jwk = (await this.#jwks()).find((k) => k.kid === head.kid); }
    if (!jwk) return null;
    const ok = crypto.verify('RSA-SHA256', Buffer.from(`${h}.${b}`), crypto.createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(s, 'base64url'));
    const now = Math.floor(Date.now() / 1000);
    if (!ok || body.iss !== this.issuer || body.aud !== this.clientId || body.exp < now - 60) return null;
    if (nonce && body.nonce !== nonce) return null;
    return body;
  }

  /** Is this account session still signed in? One call per minute per session at most. */
  async isLive(sid) {
    if (!sid) return true;
    const hit = this.live.get(sid);
    if (hit && hit.until > Date.now()) return hit.live;
    const r = await this.#post('/api/sessions/check', { sid }).catch(() => null);
    // If the account server cannot be reached, keep people signed in rather than locking everyone out.
    const live = r ? r.sessions?.[sid] !== false : (hit?.live ?? true);
    this.live.set(sid, { live, until: Date.now() + 60_000 });
    if (this.live.size > 5000) this.live.delete(this.live.keys().next().value);
    return live;
  }

  /** The shared per-account rate limit: counts one use and says whether it is allowed. */
  async limit(account, bucket, max, per, { cost = 1, peek = false } = {}) {
    const r = await this.#post('/api/limits/hit', { account, bucket, max, per, cost, peek }).catch(() => null);
    return r ?? { ok: true, unchecked: true };
  }

  /** A team's brand kit (cached a minute). Apps can also link `${issuer}/brand/<slug>.css`. */
  async brand(team) {
    const hit = this.brands.get(team);
    if (hit && hit.until > Date.now()) return hit.brand;
    const r = await this.fetch(`${this.issuer}/api/teams/${encodeURIComponent(team)}/brand`).then((x) => (x.ok ? x.json() : null)).catch(() => null);
    this.brands.set(team, { brand: r, until: Date.now() + 60_000 });
    return r;
  }

  /** Where the team's data lives, with the database address when it is their own Postgres. */
  async dataHome(team) {
    const r = await this.fetch(`${this.issuer}/api/teams/${encodeURIComponent(team)}/data-home`, { headers: { authorization: this.#basic() } });
    return r.ok ? r.json() : null;
  }

  /** Signs the person out of the account too, then comes back to returnTo (an address on this app). */
  endSessionUrl(returnTo) {
    const u = new URL(`${this.issuer}/oauth/end-session`);
    u.searchParams.set('client_id', this.clientId);
    if (returnTo) u.searchParams.set('post_logout_redirect_uri', returnTo);
    return u.toString();
  }

  /** True when the browser is signed in to the account somewhere on *.waronsaas.com (no secret, just a hint). */
  static hinted(req) {
    return /(?:^|;\s*)wos_signed_in=1(?:;|$)/.test(req.headers.cookie ?? '');
  }

  // ---------- bits ----------

  #basic() { return `Basic ${Buffer.from(`${encodeURIComponent(this.clientId)}:${encodeURIComponent(this.clientSecret)}`).toString('base64')}`; }

  async #token(params) {
    const r = await this.fetch(`${this.issuer}/oauth/token`, { method: 'POST', headers: { authorization: this.#basic(), 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: new URLSearchParams(params) });
    return r.json().catch(() => ({ error: 'token_failed' }));
  }

  async #post(path, body) {
    const r = await this.fetch(`${this.issuer}${path}`, { method: 'POST', headers: { authorization: this.#basic(), 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error(`account ${path}: ${r.status}`);
    return r.json();
  }

  async #jwks() {
    if (this.keys && this.keys.until > Date.now()) return this.keys.list;
    const r = await this.fetch(`${this.issuer}/jwks.json`).then((x) => x.json());
    this.keys = { list: r.keys ?? [], until: Date.now() + 3600_000 };
    return this.keys.list;
  }

  #key() { return crypto.createHash('sha256').update(`wos-account-flow:${this.secret}`).digest(); }
  #seal(obj) {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', this.#key(), iv);
    const out = Buffer.concat([c.update(JSON.stringify(obj)), c.final()]);
    return [iv, c.getAuthTag(), out].map(b64u).join('.');
  }
  #open(s) {
    try {
      const [iv, tag, out] = String(s).split('.').map((x) => Buffer.from(x, 'base64url'));
      const d = crypto.createDecipheriv('aes-256-gcm', this.#key(), iv);
      d.setAuthTag(tag);
      const o = JSON.parse(Buffer.concat([d.update(out), d.final()]).toString());
      return o.exp >= Math.floor(Date.now() / 1000) ? o : null;
    } catch {
      return null;
    }
  }
}

/**
 * Which sign-in an install uses. Hosted: waronsaas. Self-hosted: github or local (the app's own), or waronsaas
 * when they want to sign in with their warOnSaaS account. Default: waronsaas when the client id is set.
 */
export function authProvider(env = process.env) {
  const p = String(env.AUTH_PROVIDER ?? '').toLowerCase();
  if (['waronsaas', 'github', 'local'].includes(p)) return p;
  return env.WOS_ACCOUNT_CLIENT_ID ? 'waronsaas' : 'github';
}
