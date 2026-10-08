import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { zipSync, strToU8 } from 'fflate';
import { createServer, catalogue } from '../server.mjs';
import { issueTokens } from '../lib/auth.mjs';
import { createMailer } from '../lib/mail.mjs';
import { makeApp } from './helpers.mjs';

// The catalogue test (ROADMAP 3.2): every tool has a name in the app.verb_noun form, a plain description,
// an input and output schema, a scope and a confirm value; tools.json matches the code; and every tool
// is reachable over MCP and is run here by an agent, end to end, through MCP alone.

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

test('every tool is fully described, and tools.json is current', () => {
  const tools = catalogue();
  const names = new Set();
  for (const x of tools) {
    assert.match(x.name, /^chat\.[a-z]+(_[a-z]+)*$/, x.name);
    assert.ok(!names.has(x.name), `duplicate ${x.name}`);
    names.add(x.name);
    assert.ok(x.title && x.description.length > 20, `${x.name} needs a plain description`);
    assert.ok(['read', 'write', 'delete', 'admin'].includes(x.scope), `${x.name} scope`);
    assert.ok(['none', 'human'].includes(x.confirm), `${x.name} confirm`);
    assert.equal(x.input?.type, 'object', `${x.name} input schema`);
    assert.ok(x.output && (x.output.type === 'object' || x.output.anyOf || x.output.allOf), `${x.name} output schema`);
    assert.ok(Array.isArray(x.emits), `${x.name} emits`);
    assert.ok(!/\u2014/.test(x.description), `${x.name}: no em dashes`);
  }
  for (const n of ['chat.list_channels', 'chat.read_messages', 'chat.post_message', 'chat.post_reply', 'chat.add_reaction', 'chat.search_messages', 'chat.create_channel', 'chat.invite_people', 'chat.set_status', 'chat.edit_message', 'chat.delete_message', 'chat.mark_read', 'chat.set_notify']) assert.ok(names.has(n), `ROADMAP 5.3 names ${n}`);
  const file = JSON.parse(fs.readFileSync(new URL('../tools.json', import.meta.url)));
  assert.deepEqual(file.tools.map(({ test, ...x }) => x), JSON.parse(JSON.stringify(tools)), 'tools.json is stale: npm run tools:json');
  const manifest = JSON.parse(fs.readFileSync(new URL('../wos-app.json', import.meta.url)));
  for (const x of tools) for (const e of x.emits) assert.ok(manifest.events.emits.includes(e), `wos-app.json lists event ${e}`);
  // The suite's screen part is built from the standalone screens and must match them.
  execFileSync(process.execPath, ['scripts/build-screens.mjs', '--check'], { cwd: new URL('..', import.meta.url).pathname });
  const screens = fs.readFileSync(new URL('../screens.mjs', import.meta.url), 'utf8');
  assert.match(screens, /export default \{ title: 'Chat', mount \}/);
});

test('an agent can do everything over MCP alone: every tool, end to end', async () => {
  const c = new Client({ name: 'agent', version: '1' });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${issueTokens(t.sam, { app: 'Test agent' }).access_token}` } } }));
  // Listed by wire name (chat_post_message); the calls below use the catalogue names.
  const listed = (await c.listTools()).tools.map((x) => x.name.replace('_', '.'));
  const used = new Set();
  const call = async (name, args = {}) => {
    used.add(name);
    const r = await c.callTool({ name, arguments: args });
    assert.ok(!r.isError, `${name}: ${r.content?.[0]?.text}`);
    return r.content[0].text;
  };
  const idOf = (text, prefix) => new RegExp(`\\b(${prefix}_[0-9a-z]+)`).exec(text)?.[1];

  // The top journeys, as an agent would do them.
  await call('chat.list_people');
  await call('chat.list_channels', { browse: true });
  await call('chat.get_channel', { channel: 'general' });
  const ch = idOf(await call('chat.create_channel', { name: 'agent-room', topic: 'Made by an agent' }), 'c');
  await call('chat.invite_people', { channel: ch, people: ['jordan', 'helper'] });
  await call('chat.set_topic', { channel: ch, topic: 'Still made by an agent' });
  const file = JSON.parse(await call('chat.upload_file', { name: 'a.txt', content_base64: Buffer.from('x').toString('base64') }));
  const m = idOf(await call('chat.post_message', { channel: ch, body: 'Hello @jordan', files: [file.id] }), 'm');
  const r = idOf(await call('chat.post_reply', { message: m, body: 'In the thread' }), 'm');
  await call('chat.add_reaction', { message: m, emoji: '✅' });
  await call('chat.remove_reaction', { message: m, emoji: '✅' });
  await call('chat.add_reaction', { message: m, emoji: '✅' });
  await call('chat.edit_message', { message: r, body: 'In the thread (edited)' });
  assert.match(await call('chat.read_messages', { thread: m }), /edited/);
  await call('chat.search_messages', { q: 'thread' });
  await call('chat.list_mentions');
  await call('chat.set_typing', { channel: ch });
  await call('chat.mark_unread', { message: m });
  await call('chat.mark_read', { channel: ch });
  await call('chat.set_notify', { channel: ch, level: 'all' });
  await call('chat.set_notify', { level: 'mentions' });
  await call('chat.set_preferences', { theme: 'dark', keywords: ['urgent'] });
  await call('chat.set_status', { text: 'Working', emoji: '🛠️' });
  await call('chat.get_settings');
  const dm = idOf(await call('chat.open_dm', { people: ['casey'] }), 'd');
  await call('chat.post_message', { channel: dm, body: 'hi Casey' });
  await call('chat.delete_message', { message: r });
  await call('chat.leave_channel', { channel: 'random' });
  await call('chat.join_channel', { channel: 'random' });
  await call('chat.archive_channel', { channel: ch });
  await call('chat.archive_channel', { channel: ch, archived: false });
  await call('chat.add_person', { name: 'Morgan Pike', email: 'morgan@birch-law.example' });
  await call('chat.add_agent', { name: 'Minutes', description: 'Writes up meetings', channels: [ch] });
  // Removing someone needs a person's yes: the agent's call becomes a request for Sam.
  assert.match(JSON.parse(await call('chat.remove_person', { person: 'morgan' })).pending.message, /needs a person's yes/);
  const approvals = JSON.parse(await call('chat.list_approvals'));
  assert.equal(approvals.approvals[0].tool, 'chat.remove_person');
  // Deciding is the person's own click; over MCP it is refused.
  used.add('chat.decide_approval');
  const deny = await c.callTool({ name: 'chat.decide_approval', arguments: { approval: approvals.approvals[0].id, approve: true } });
  assert.ok(deny.isError);
  await call('chat.subscribe_push', { subscription: { endpoint: 'https://push.example/agent', keys: { p256dh: 'k', auth: 'a' } } });
  await call('chat.unsubscribe_push', {});
  const ev = JSON.parse(await call('chat.list_events', {}));
  await call('chat.list_events', { since: Math.max(0, ev.cursor - 5) });
  assert.match(JSON.parse(await call('chat.export_data')).file.url, /^\/files\/chat\//);
  const zip = zipSync({ 'users.json': strToU8('[]'), 'channels.json': strToU8('[{"id":"C1","name":"x","members":[]}]') });
  const z = JSON.parse(await call('chat.upload_file', { name: 'slack.zip', content_base64: Buffer.from(zip).toString('base64') }));
  assert.ok(JSON.parse(await call('chat.import_slack', { file: z.id })).pending.approval_id);

  const missing = listed.filter((n) => !used.has(n));
  assert.deepEqual(missing, [], `tools never run by the agent test: ${missing.join(', ')}`);
  await c.close();
});
