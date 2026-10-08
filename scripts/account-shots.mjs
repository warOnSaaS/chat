// Checks the hosted sign-in ("look freely, sign in to use") by rendering it, into .shots/account-*.png.
//   node scripts/account-shots.mjs                 local: starts the server in waronsaas mode against test/account-stub.mjs
//   node scripts/account-shots.mjs https://chat.waronsaas.com [--live]
// Signed out: the main page at 1440 and 390, then a press on Send shows the prompt. --live also signs in at the
// real account with a throwaway inbox (never a real person), opens the app in the same browser (it must sign in
// with no clicks), posts a message, and deletes the test account afterwards.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const args = process.argv.slice(2);
let base = args.find((a) => a.startsWith('http'));
const live = args.includes('--live');
let server, stub;
if (!base) {
  const { startAccountStub } = await import('../test/account-stub.mjs');
  stub = await startAccountStub();
  Object.assign(process.env, stub.env, { SQLITE_FILE: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'chat-acct-')), 'chat.db'), FILES_STORAGE: 'db', OAUTH_SECRET: 'shots-secret' });
  const { createServer } = await import('../server.mjs');
  server = createServer();
  await new Promise((r) => server.listen(0, r));
  await server.ready;
  base = `http://localhost:${server.address().port}`;
}
const out = path.resolve('.shots');
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ args: ['--mute-audio'] });
const problems = [];
const shot = async (page, name) => { await page.waitForTimeout(400); const f = path.join(out, `account-${name}.png`); await page.screenshot({ path: f }); console.log('shot', path.relative(process.cwd(), f)); };

// ---------- signed out ----------
for (const [w, h, tag] of [[1440, 900, 'desk'], [390, 844, 'phone']]) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, hasTouch: tag === 'phone', isMobile: tag === 'phone', deviceScaleFactor: tag === 'phone' ? 2 : 1 });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => problems.push(`${tag}: ${e.message}`));
  const r = await page.goto(`${base}/`);
  if (r.status() !== 200) problems.push(`${tag}: signed-out GET / is ${r.status()}`);
  if (new URL(page.url()).origin !== new URL(base).origin) problems.push(`${tag}: signed-out visit left the app for ${page.url()}`);
  await page.waitForFunction(() => window.chatReady === true, null, { timeout: 20000 });
  const ids = await page.evaluate(() => Object.fromEntries(window.chatState.channels.map((c) => [c.name, c.id])));
  await page.evaluate((h) => { location.hash = h; }, `#/c/${ids['front-desk']}`);
  await page.waitForSelector('.msg');
  await shot(page, `signed-out-${tag}`);
  const hasPrompt = await page.evaluate(() => !!window.wosAccount && window.wosAccount.signedIn === false);
  if (!hasPrompt) problems.push(`${tag}: prompt.js did not load or thinks we are signed in`);
  // A press on an action: type, then Send.
  await page.fill('#composer textarea', 'Hello from a visitor');
  await page.click('#composer [type=submit]');
  const opened = await page.waitForSelector('.wos-ap', { timeout: 5000 }).then(() => true).catch(() => false);
  if (!opened) problems.push(`${tag}: pressing Send did not open the sign-in prompt`);
  await shot(page, `prompt-${tag}`);
  const posted = await page.evaluate(() => [...document.querySelectorAll('.msg')].some((m) => m.textContent.includes('Hello from a visitor')));
  if (posted) problems.push(`${tag}: a signed-out visitor's message was posted`);
  await ctx.close();
}

// ---------- signed in (live only) ----------
if (live) {
  const { Mailbox } = await import(path.join(os.homedir(), 'wos-account', 'scripts', 'mailbox.mjs'));
  const account = 'https://account.waronsaas.com';
  const box = await Mailbox.create();
  console.log('inbox', box.address.replace(/^[^@]+/, 'wos-test-...'));
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => problems.push(`live: ${e.message}`));
  await page.goto(`${account}/`);
  const sent = await page.evaluate(async (email) => {
    const r = await fetch('/auth/email', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email }) });
    return { status: r.status, text: await r.text() };
  }, box.address);
  console.log('email sign-in asked:', sent.status);
  const mail = await box.waitFor(/Sign in/i);
  const links = [...(mail.text.match(/https?:\/\/[^\s"'<>)]+/g) ?? []), ...((mail.html ?? '').match(/https?:\/\/[^\s"'<>]+/g) ?? [])];
  const link = links.find((l) => l.startsWith(account) && /\/auth\/email/.test(l)) ?? links.find((l) => l.startsWith(account));
  if (!link) throw new Error(`no sign-in link in the email: ${mail.text.slice(0, 300)}`);
  await page.goto(link);
  const cont = page.getByRole('button', { name: /continue/i }).first();
  if (await cont.count()) await cont.click();
  await page.waitForTimeout(1500);
  await shot(page, 'live-account');
  // The app, in the same browser: it must sign in with no clicks.
  await page.goto(`${base}/`);
  await page.waitForFunction(() => window.chatReady === true && window.wosAccount?.signedIn === true, null, { timeout: 30000 }).catch(() => problems.push('live: the app did not sign in silently'));
  const me = await page.evaluate(() => ({ me: window.chatState.me, team: window.chatState.settings?.team }));
  console.log('signed in as', me.me?.handle, 'in', me.team?.name);
  const ids = await page.evaluate(() => Object.fromEntries(window.chatState.channels.map((c) => [c.name, c.id])));
  await page.evaluate((h) => { location.hash = h; }, `#/c/${ids.general}`);
  await page.waitForSelector('#composer textarea');
  await page.fill('#composer textarea', 'First message, posted through the warOnSaaS account.');
  await page.click('#composer [type=submit]');
  const ok = await page.waitForSelector('.msg:has-text("First message, posted through")', { timeout: 10000 }).then(() => true).catch(() => false);
  if (!ok) problems.push('live: posting while signed in did not work');
  await shot(page, 'signed-in-desk');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate((h) => { location.hash = h; }, `#/c/${ids.general}`);
  await page.waitForTimeout(500);
  await shot(page, 'signed-in-phone');
  // An AI app the way Claude Code connects: dynamic registration, PKCE, a loopback redirect, through the account.
  await mcpCheck(page, base).catch((e) => problems.push(`live mcp: ${e.message}`));
  // Clean up: delete the test account (which ends its sessions).
  const del = await page.evaluate(async () => {
    const r = await fetch('https://account.waronsaas.com/api/tools/account.delete', { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json', 'x-wos-call': '1' }, body: JSON.stringify({ confirm: 'delete' }) });
    return r.status;
  }).catch(() => 'failed');
  if (del !== 200) {
    await page.goto(`${account}/`);
    const del2 = await page.evaluate(async () => {
      const r = await fetch('/api/tools/account.delete', { method: 'POST', headers: { 'content-type': 'application/json', 'x-wos-call': '1' }, body: JSON.stringify({ confirm: 'delete' }) });
      return r.status;
    }).catch(() => 'failed');
    console.log('test account deleted:', del2);
    if (del2 !== 200) problems.push(`live: could not delete the test account (${del2})`);
  } else console.log('test account deleted:', del);
  await ctx.close();
}

async function mcpCheck(page, base) {
  const http = await import('node:http');
  const crypto = await import('node:crypto');
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  let gotCode;
  const code = new Promise((r) => { gotCode = r; });
  const loop = http.createServer((req, res) => { const u = new URL(req.url, 'http://x'); res.end('You can close this tab.'); if (u.pathname === '/cb') gotCode(Object.fromEntries(u.searchParams)); });
  await new Promise((r) => loop.listen(0, '127.0.0.1', r));
  const redirect = `http://127.0.0.1:${loop.address().port}/cb`;
  const meta = await fetch(`${base}/.well-known/oauth-authorization-server`).then((r) => r.json());
  const reg = await fetch(meta.registration_endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'Claude Code (check)', redirect_uris: [redirect] }) }).then((r) => r.json());
  const verifier = crypto.randomBytes(32).toString('base64url');
  const q = new URLSearchParams({ client_id: reg.client_id, redirect_uri: redirect, response_type: 'code', code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', state: 'live1', scope: 'read write' });
  await page.goto(`${meta.authorization_endpoint}?${q}`);
  const got = await Promise.race([code, new Promise((_, j) => setTimeout(() => j(new Error('no code came back to the loopback in 60s')), 60000))]);
  loop.close();
  if (got.state !== 'live1' || !got.code) throw new Error(`bad callback: ${JSON.stringify(got)}`);
  const tok = await fetch(meta.token_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code: got.code, client_id: reg.client_id, redirect_uri: redirect, code_verifier: verifier }) }).then((r) => r.json());
  if (!tok.access_token) throw new Error(`token exchange failed: ${JSON.stringify(tok)}`);
  const c = new Client({ name: 'check', version: '1' });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${tok.access_token}` } } }));
  const names = (await c.listTools()).tools.map((t) => t.name);
  const bad = names.filter((n) => !/^[a-z]+_[a-z_]+$/.test(n));
  if (bad.length) throw new Error(`tools/list has non-wire names: ${bad.join(', ')}`);
  const r = await c.callTool({ name: 'chat_list_channels', arguments: {} });
  if (r.isError) throw new Error(`tools/call chat_list_channels failed: ${r.content?.[0]?.text}`);
  const posted = await c.callTool({ name: 'chat_post_message', arguments: { channel: 'general', body: 'Posted over MCP by the live check.' } });
  if (posted.isError) throw new Error(`tools/call chat_post_message failed: ${posted.content?.[0]?.text}`);
  await c.close();
  console.log(`mcp: ${names.length} tools listed by wire name; tools/call by wire name works`);
}

await browser.close();
server?.close();
stub?.close();
if (problems.length) { console.error('problems:\n  ' + problems.join('\n  ')); process.exit(1); }
console.log('account check: all good');
process.exit(0);
