import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { createServer } from '../server.mjs';
import { createApp } from '../lib/app.mjs';
import { issueTokens } from '../lib/auth.mjs';
import { createMailer } from '../lib/mail.mjs';
import { makeApp } from './helpers.mjs';

// Two copies of the server on one Postgres: a message posted through copy B reaches a socket open on
// copy A, through LISTEN/NOTIFY. Runs when CHAT_TEST_DATABASE_URL points at a Postgres you can write to:
//   docker run -d -e POSTGRES_PASSWORD=chat -p 55439:5432 postgres:16-alpine
//   CHAT_TEST_DATABASE_URL=postgres://postgres:chat@localhost:55439/postgres npm test
const url = process.env.CHAT_TEST_DATABASE_URL;

test('two server copies share live updates through Postgres LISTEN/NOTIFY', { skip: !url && 'set CHAT_TEST_DATABASE_URL to run' }, async () => {
  const team = `pg${Date.now().toString(36)}`;
  const a = await makeApp({ DATABASE_URL: url, SQLITE_FILE: undefined, CHAT_TEAM_ID: team });
  const appB = await createApp({ DATABASE_URL: url, CHAT_TEAM_ID: team, CHAT_PUSH_DRY: '1' });
  for (const x of [a.app, appB]) x.mailer = await createMailer({});
  const sa = createServer(a.app), sb = createServer(appB);
  await new Promise((r) => sa.listen(0, r));
  await new Promise((r) => sb.listen(0, r));
  const cookie = `chat_session=${encodeURIComponent(issueTokens(a.jordan).access_token)}`;
  const ws = new WebSocket(`ws://localhost:${sa.address().port}/ws`, { headers: { cookie } });
  const got = [];
  await new Promise((r) => ws.on('message', (m) => { const e = JSON.parse(m); got.push(e); if (e.type === 'hello') r(); }));
  // Post through copy B, as Sam.
  const r = await fetch(`http://localhost:${sb.address().port}/api/tools/chat.post`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: `chat_session=${encodeURIComponent(issueTokens(a.sam).access_token)}` }, body: JSON.stringify({ channel: 'general', body: 'across copies @jordan' }) }).then((x) => x.json());
  assert.equal(r.ok, true);
  for (let i = 0; i < 40 && !got.some((e) => e.type === 'message.posted'); i++) await new Promise((res) => setTimeout(res, 50));
  ws.close();
  const ev = got.find((e) => e.type === 'message.posted');
  assert.ok(ev, 'copy A heard the message posted on copy B');
  assert.equal(ev.data.message.body, 'across copies @jordan');
  // Search uses Postgres full text.
  const s = await a.run(a.jordan, 'chat.search', { q: 'copies' });
  assert.equal(s.results.length, 1);
  for (const s2 of [sa, sb]) { s2.closeAllConnections?.(); s2.close(); }
  await appB.close();
});
