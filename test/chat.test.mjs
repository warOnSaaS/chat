import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { unzipSync, strFromU8, zipSync, strToU8 } from 'fflate';
import { makeApp } from './helpers.mjs';

const rejects = (p, re) => assert.rejects(p, (e) => { assert.match(e.message, re); return true; });

test('channels: public, private, join, leave, invite, topic, archive', async () => {
  const { app, sam, jordan, casey, riley, run } = await makeApp();
  const pub = await run(sam, 'chat.create_channel', { name: 'Launch Plans', topic: 'The spring launch' });
  assert.equal(pub.name, 'launch-plans');
  assert.equal(pub.kind, 'public');
  const priv = await run(sam, 'chat.create_channel', { name: 'partners', private: true, members: ['jordan'] });
  // Casey cannot see the private channel at all; it does not exist for her.
  await rejects(run(casey, 'chat.read_messages', { channel: 'partners' }), /No channel/);
  assert.ok(!(await run(casey, 'chat.list_channels', { browse: true })).channels.some((c) => c.id === priv.id));
  assert.ok((await run(jordan, 'chat.list_channels')).channels.some((c) => c.id === priv.id));
  // Joining a private channel needs an invite; a public one does not.
  await rejects(run(casey, 'chat.join_channel', { channel: priv.id }), /No channel/);
  await run(casey, 'chat.join_channel', { channel: 'launch-plans' });
  assert.ok((await run(casey, 'chat.list_channels')).channels.some((c) => c.id === pub.id));
  await run(casey, 'chat.leave_channel', { channel: 'launch-plans' });
  assert.ok(!(await run(casey, 'chat.list_channels')).channels.some((c) => c.id === pub.id));
  await run(sam, 'chat.invite_people', { channel: priv.id, people: ['casey'] });
  assert.equal((await run(casey, 'chat.read_messages', { channel: 'partners' })).channel.id, priv.id);
  assert.equal((await run(sam, 'chat.set_topic', { channel: pub.id, topic: 'New topic' })).topic, 'New topic');
  // Guests cannot make channels; members cannot archive; admins can, and nobody posts after.
  await rejects(run(riley, 'chat.create_channel', { name: 'nope' }), /Guests/);
  await rejects(run(jordan, 'chat.archive_channel', { channel: pub.id }), /owners and admins/);
  await run(sam, 'chat.archive_channel', { channel: pub.id });
  await rejects(run(sam, 'chat.post_message', { channel: pub.id, body: 'hi' }), /archived/);
  await run(sam, 'chat.archive_channel', { channel: pub.id, archived: false });
  await run(sam, 'chat.post_message', { channel: pub.id, body: 'back' });
  await rejects(run(sam, 'chat.create_channel', { name: 'launch-plans' }), /already exists/);
  await rejects(run(sam, 'chat.archive_channel', { channel: 'general' }), /cannot be archived/);
});

test('messages: post, thread replies, edit, delete, reactions, mentions', async () => {
  const { app, sam, jordan, casey, run } = await makeApp();
  const m = await run(sam, 'chat.post_message', { channel: 'general', body: 'Hello **team** @jordan and @nobody' });
  assert.match(m.html, /<strong>team<\/strong>/);
  assert.match(m.html, /class="mention" data-handle="jordan"/);
  assert.doesNotMatch(m.html, /data-handle="nobody"/);
  const r1 = await run(jordan, 'chat.post_reply', { message: m.id, body: 'Hi Sam' });
  const r2 = await run(casey, 'chat.post_reply', { message: r1.id, body: 'Replying to a reply lands in the same thread' });
  assert.equal(r2.thread_root, m.id);
  const th = await run(casey, 'chat.read_messages', { thread: m.id });
  assert.deepEqual(th.messages.map((x) => x.id), [m.id, r1.id, r2.id]);
  const ch = await run(casey, 'chat.read_messages', { channel: 'general' });
  assert.equal(ch.messages.find((x) => x.id === m.id).reply_count, 2);
  assert.ok(!ch.messages.some((x) => x.id === r1.id), 'replies stay in the thread');
  // Edit: only your own.
  await rejects(run(jordan, 'chat.edit_message', { message: m.id, body: 'hacked' }), /your own/);
  const e = await run(sam, 'chat.edit_message', { message: m.id, body: 'Hello team (edited)' });
  assert.ok(e.edited_at);
  // Reactions add and come off.
  await run(jordan, 'chat.add_reaction', { message: m.id, emoji: '👍' });
  let rx = await run(casey, 'chat.add_reaction', { message: m.id, emoji: '👍' });
  assert.equal(rx.reactions[0].count, 2);
  rx = await run(casey, 'chat.remove_reaction', { message: m.id, emoji: '👍' });
  assert.equal(rx.reactions[0].count, 1);
  // Mentions: Jordan sees the mention.
  const men = await run(jordan, 'chat.list_mentions', {});
  assert.equal(men.results[0].id, m.id);
  // Delete: a first message with replies stays as "deleted" so the thread keeps its place; the words are gone.
  await rejects(run(jordan, 'chat.delete_message', { message: m.id }), /your own/);
  await run(sam, 'chat.delete_message', { message: m.id });
  const after = await run(casey, 'chat.read_messages', { channel: 'general' });
  const gone = after.messages.find((x) => x.id === m.id);
  assert.equal(gone.deleted, true);
  assert.equal(gone.body, '');
  const row = await app.db.get('select body from chat_messages where id = $1', [m.id]);
  assert.equal(row.body, '');
  await run(casey, 'chat.delete_message', { message: r2.id });
  assert.equal((await run(casey, 'chat.read_messages', { thread: m.id })).messages.length, 2);
  // A plain message with no replies disappears from the channel.
  const lone = await run(casey, 'chat.post_message', { channel: 'general', body: 'oops' });
  await run(casey, 'chat.delete_message', { message: lone.id });
  assert.ok(!(await run(casey, 'chat.read_messages', { channel: 'general' })).messages.some((x) => x.id === lone.id));
  // Markdown never lets HTML through.
  const x = await run(casey, 'chat.post_message', { channel: 'general', body: '<img src=x onerror=alert(1)> [a](javascript:alert(1))' });
  assert.doesNotMatch(x.html, /<img|href="javascript/);
});

test('direct and group messages', async () => {
  const { sam, jordan, casey, run } = await makeApp();
  const dm = await run(sam, 'chat.open_dm', { people: ['jordan'] });
  assert.equal(dm.kind, 'dm');
  assert.equal((await run(jordan, 'chat.open_dm', { people: ['sam'] })).id, dm.id, 'the same DM both ways');
  await run(sam, 'chat.post_message', { channel: dm.id, body: 'private note' });
  await rejects(run(casey, 'chat.read_messages', { channel: dm.id }), /No channel/);
  const j = (await run(jordan, 'chat.list_channels')).channels.find((c) => c.id === dm.id);
  assert.equal(j.unread, 1);
  assert.equal(j.mentions, 1, 'a direct message counts as a mention');
  assert.equal(j.name, 'Sam');
  const g = await run(sam, 'chat.open_dm', { people: ['jordan', 'casey'] });
  assert.equal(g.kind, 'group_dm');
  await rejects(run(sam, 'chat.leave_channel', { channel: dm.id }), /cannot leave/);
  await rejects(run(sam, 'chat.invite_people', { channel: dm.id, people: ['casey'] }), /exactly two/);
});

test('unread counts, mark read and mark unread', async () => {
  const { sam, jordan, run } = await makeApp();
  const a = await run(sam, 'chat.post_message', { channel: 'general', body: 'one' });
  await run(sam, 'chat.post_message', { channel: 'general', body: 'two @jordan' });
  await run(sam, 'chat.post_message', { channel: 'general', body: 'three' });
  let g = (await run(jordan, 'chat.list_channels')).channels.find((c) => c.name === 'general');
  assert.equal(g.unread, 3);
  assert.equal(g.mentions, 1);
  assert.equal((await run(sam, 'chat.list_channels')).channels.find((c) => c.name === 'general').unread, 0, 'your own messages are never unread');
  const r = await run(jordan, 'chat.mark_read', { channel: 'general' });
  assert.equal(r.unread, 0);
  const u = await run(jordan, 'chat.mark_unread', { message: a.id });
  assert.equal(u.unread, 3);
  await run(jordan, 'chat.mark_read', { channel: 'general', message: a.id });
  g = (await run(jordan, 'chat.list_channels')).channels.find((c) => c.name === 'general');
  assert.equal(g.unread, 2);
});

test('search: words, in: and from:, and never a channel you cannot see', async () => {
  const { sam, jordan, casey, run } = await makeApp();
  await run(sam, 'chat.post_message', { channel: 'general', body: 'The card reader is broken again' });
  await run(jordan, 'chat.post_message', { channel: 'random', body: 'Card games at lunch?' });
  const priv = await run(sam, 'chat.create_channel', { name: 'secret', private: true });
  await run(sam, 'chat.post_message', { channel: priv.id, body: 'card budget is secret' });
  assert.equal((await run(sam, 'chat.search_messages', { q: 'card' })).results.length, 3);
  assert.equal((await run(casey, 'chat.search_messages', { q: 'card' })).results.length, 2, 'Casey does not see the private channel');
  assert.equal((await run(sam, 'chat.search_messages', { q: 'card in:#random' })).results.length, 1);
  assert.equal((await run(sam, 'chat.search_messages', { q: 'card from:@jordan' })).results[0].author.handle, 'jordan');
  assert.equal((await run(sam, 'chat.search_messages', { q: 'read' })).results.length, 1, 'prefix match: read finds reader');
  await rejects(run(sam, 'chat.search_messages', {}), /Give some words/);
});

test('notification rules decide who gets a push', async () => {
  const { app, sam, jordan, casey, run } = await makeApp();
  const sub = (p, n) => app.push.subscribe(p, { endpoint: `https://push.example/${n}`, keys: { p256dh: 'k', auth: 'a' } });
  await sub(jordan, 'j');
  await sub(casey, 'c');
  app.push.sent.length = 0;
  await run(sam, 'chat.post_message', { channel: 'general', body: 'hello all' });
  assert.equal(app.push.sent.length, 0, 'the usual rule is mentions only');
  await run(sam, 'chat.post_message', { channel: 'general', body: 'hey @jordan' });
  assert.deepEqual(app.push.sent.map((s) => s.endpoint), ['https://push.example/j']);
  await run(casey, 'chat.set_notify', { channel: 'general', level: 'all' });
  await run(jordan, 'chat.set_notify', { channel: 'general', level: 'none' });
  app.push.sent.length = 0;
  await run(sam, 'chat.post_message', { channel: 'general', body: 'hey @jordan again' });
  assert.deepEqual(app.push.sent.map((s) => s.endpoint), ['https://push.example/c'], 'Jordan muted it; Casey hears everything');
  await run(jordan, 'chat.set_preferences', { keywords: ['Invoice'] });
  await run(jordan, 'chat.set_notify', { channel: 'general', level: 'default' });
  app.push.sent.length = 0;
  await run(sam, 'chat.post_message', { channel: 'general', body: 'the invoice is late' });
  assert.ok(app.push.sent.some((s) => s.endpoint.endsWith('/j') && s.payload.why === 'keyword'));
  await run(jordan, 'chat.set_preferences', { push: false });
  app.push.sent.length = 0;
  const dm = await run(sam, 'chat.open_dm', { people: ['jordan'] });
  await run(sam, 'chat.post_message', { channel: dm.id, body: 'psst' });
  assert.ok(!app.push.sent.some((s) => s.endpoint.endsWith('/j')), 'push turned off');
  await run(jordan, 'chat.unsubscribe_push', {});
  assert.equal(await app.push.count(jordan), 0);
  // The VAPID key pair is made once and kept.
  const s = await run(jordan, 'chat.get_settings', {});
  assert.match(s.push.public_key, /^[A-Za-z0-9_-]{80,}$/);
});

test('the example agent answers in the thread when mentioned, and only there', async () => {
  const { app, sam, run } = await makeApp();
  await run(sam, 'chat.invite_people', { channel: 'general', people: ['helper'] });
  const root = await run(sam, 'chat.post_message', { channel: 'general', body: 'We need to order gloves by Friday' });
  const ask = await run(sam, 'chat.post_reply', { message: root.id, body: '@helper summarise please' });
  await app.agents.idle();
  const th = await run(sam, 'chat.read_messages', { thread: root.id });
  const answer = th.messages.at(-1);
  assert.equal(answer.author.handle, 'helper');
  assert.equal(answer.thread_root, root.id);
  assert.match(answer.body, /1 messages|messages\*\* from Sam/);
  assert.match(answer.body, /Example agent/);
  // An agent's own message never wakes an agent.
  const count = th.messages.length;
  await run(app.chat ? await app.chat.personRow((await app.chat.findPerson(app.teamId, 'helper')).id) : null, 'chat.post_reply', { message: ask.id, body: '@helper talking to myself' });
  await app.agents.idle();
  assert.equal((await run(sam, 'chat.read_messages', { thread: root.id })).messages.length, count + 1);
  // Mentioning a top-level message starts a thread on it.
  const top = await run(sam, 'chat.post_message', { channel: 'general', body: '@helper to-dos?' });
  await app.agents.idle();
  assert.equal((await run(sam, 'chat.read_messages', { thread: top.id })).messages.length, 2);
  // A DM with an agent needs no mention.
  const dm = await run(sam, 'chat.open_dm', { people: ['helper'] });
  await run(sam, 'chat.post_message', { channel: dm.id, body: 'hello' });
  await app.agents.idle();
  const d = await run(sam, 'chat.read_messages', { channel: dm.id });
  assert.equal(d.messages[0].reply_count, 1);
});

test('a real agent calls any OpenAI-compatible model, with read-only chat tools', async () => {
  const calls = [];
  const model = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    const j = JSON.parse(body);
    calls.push({ auth: req.headers.authorization, ...j });
    const tools = j.messages.filter((m) => m.role === 'tool');
    const msg = tools.length
      ? { role: 'assistant', content: `Found it: ${JSON.parse(tools[0].content).results?.find((r) => /\d{4}/.test(r.body))?.body ?? 'nothing'}` }
      : { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'chat_search_messages', arguments: JSON.stringify({ q: 'alarm' }) } }] };
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ choices: [{ message: msg }] }));
  });
  await new Promise((r) => model.listen(0, r));
  model.unref();
  const { app, sam, run } = await makeApp({ CHAT_MODEL_URL: `http://localhost:${model.address().port}/v1`, CHAT_MODEL_KEY: 'sk-test', CHAT_MODEL: 'tiny' });
  const bot = await run(sam, 'chat.add_agent', { name: 'Ops Bot', handle: 'ops', prompt: 'You help the office.', channels: ['general'] });
  assert.equal(bot.kind, 'agent');
  await run(sam, 'chat.post_message', { channel: 'general', body: 'The alarm code changed to 4412' });
  const q = await run(sam, 'chat.post_message', { channel: 'general', body: '@ops what is the alarm code?' });
  await app.agents.idle();
  const th = await run(sam, 'chat.read_messages', { thread: q.id });
  assert.equal(th.messages[1].author.handle, 'ops');
  assert.match(th.messages[1].body, /4412/);
  assert.equal(calls[0].model, 'tiny');
  assert.equal(calls[0].auth, 'Bearer sk-test');
  assert.ok(calls[0].tools.every((t) => ['chat_search_messages', 'chat_read_messages', 'chat_list_channels', 'chat_list_people'].includes(t.function.name)), 'agents only get read tools');
  model.closeAllConnections();
  model.close();
});

test('files: upload, attach, who may read them', async () => {
  const { app, sam, jordan, casey, run } = await makeApp();
  const f = await run(sam, 'chat.upload_file', { name: 'plan.txt', type: 'text/plain', content_base64: Buffer.from('the plan').toString('base64') });
  await rejects(run(jordan, 'chat.post_message', { channel: 'general', body: 'mine', files: [f.id] }), /uploaded yourself/);
  const priv = await run(sam, 'chat.create_channel', { name: 'inner', private: true, members: ['jordan'] });
  const m = await run(sam, 'chat.post_message', { channel: priv.id, body: 'see file', files: [f.id] });
  assert.equal(m.files[0].name, 'plan.txt');
  assert.ok(await app.files.readable(jordan, f.id));
  assert.equal(await app.files.readable(casey, f.id), null, 'not in the channel, cannot read the file');
  assert.equal((await app.files.read(await app.files.readable(jordan, f.id))).toString(), 'the plan');
});

test('files can live in the database (the demo and small teams)', async () => {
  const { app, sam, run } = await makeApp({ FILES_STORAGE: 'db' });
  const f = await run(sam, 'chat.upload_file', { name: 'a.png', type: 'image/png', content_base64: Buffer.from([1, 2, 3]).toString('base64') });
  assert.equal(app.files.mode, 'db');
  assert.deepEqual([...(await app.files.read(await app.files.readable(sam, f.id)))], [1, 2, 3]);
});

test('export is a Slack-shaped zip with the files and a lossless wos/ copy', async () => {
  const { app, sam, jordan, run } = await makeApp();
  const f = await run(sam, 'chat.upload_file', { name: 'notes.txt', content_base64: Buffer.from('hi').toString('base64') });
  const m = await run(sam, 'chat.post_message', { channel: 'general', body: 'root', files: [f.id] });
  await run(jordan, 'chat.post_reply', { message: m.id, body: 'reply' });
  await run(jordan, 'chat.add_reaction', { message: m.id, emoji: '🎉' });
  const priv = await run(sam, 'chat.create_channel', { name: 'core', private: true });
  await run(sam, 'chat.post_message', { channel: priv.id, body: 'private' });
  const dm = await run(sam, 'chat.open_dm', { people: ['jordan'] });
  await run(sam, 'chat.post_message', { channel: dm.id, body: 'dm' });
  await rejects(run(jordan, 'chat.export_data', {}), /owners and admins/);
  const out = await run(sam, 'chat.export_data', {});
  assert.equal(out.counts.messages, 4);
  const zip = unzipSync(new Uint8Array(await app.files.read(await app.files.readable(sam, out.file.id))));
  const j = (p) => JSON.parse(strFromU8(zip[p]));
  for (const p of ['users.json', 'channels.json', 'groups.json', 'dms.json', 'mpims.json', 'integration_logs.json', 'wos/messages.json']) assert.ok(zip[p], p);
  assert.ok(j('channels.json').some((c) => c.name === 'general' && c.members.length >= 2));
  assert.equal(j('groups.json')[0].name, 'core');
  const day = Object.keys(zip).find((k) => k.startsWith('general/'));
  const msgs = j(day);
  const root = msgs.find((x) => x.text === 'root');
  const reply = msgs.find((x) => x.text === 'reply');
  assert.match(root.ts, /^\d{10}\.\d{6}$/);
  assert.equal(reply.thread_ts, root.ts);
  assert.equal(root.reply_count, 1);
  assert.equal(root.reactions[0].name, '🎉');
  assert.equal(root.files[0].name, 'notes.txt');
  assert.equal(strFromU8(zip[`files/${f.id}/notes.txt`]), 'hi');
  assert.ok(Object.keys(zip).some((k) => k.startsWith(`${dm.id}/`)), 'DMs export under their id, as Slack does');
});

test('Slack import: the preview reads an export; the import itself waits for v1', async () => {
  const { sam, run } = await makeApp();
  const zip = zipSync({
    'users.json': strToU8(JSON.stringify([{ id: 'U1', name: 'dana', real_name: 'Dana Fox' }])),
    'channels.json': strToU8(JSON.stringify([{ id: 'C1', name: 'general', members: ['U1'] }])),
    'general/2026-01-02.json': strToU8(JSON.stringify([{ type: 'message', user: 'U1', text: 'hi', ts: '1767312000.000100' }])),
  });
  const f = await run(sam, 'chat.upload_file', { name: 'slack.zip', content_base64: Buffer.from(zip).toString('base64') });
  const p = await run(sam, 'chat.import_slack', { file: f.id });
  assert.deepEqual([p.people, p.channels, p.messages], [1, 1, 1]);
  assert.match(p.warnings[0], /private channels/);
  await rejects(run(sam, 'chat.import_slack', { file: f.id, commit: true }), /lands in v1/);
});

test('people: add, remove, status; scopes and human approval', async () => {
  const { app, sam, jordan, run } = await makeApp();
  const p = await run(sam, 'chat.add_person', { name: 'Avery Stone', email: 'avery@birch-law.example' });
  assert.equal(p.handle, 'avery');
  await rejects(run(jordan, 'chat.add_person', { name: 'X', email: 'x@birch-law.example' }), /owners and admins/);
  await rejects(run(sam, 'chat.add_person', { name: 'No way in' }), /email or a GitHub/);
  const st = await run(jordan, 'chat.set_status', { text: 'At court', emoji: '⚖️' });
  assert.deepEqual(st.status, { text: 'At court', emoji: '⚖️' });
  // A read-only connection cannot write.
  await rejects(run(jordan, 'chat.post_message', { channel: 'general', body: 'x' }, { via: 'mcp', scopes: ['read'] }), /may not write/);
  // An app acting for Sam asks before removing someone; nothing happens until Sam says yes in the app.
  const ask = await run(sam, 'chat.remove_person', { person: 'avery' }, { via: 'mcp', client: 'Claude' });
  assert.match(ask.pending.approval_id, /^ap_/);
  assert.equal((await app.chat.findPerson(app.teamId, 'avery'))?.handle, 'avery');
  const list = await run(sam, 'chat.list_approvals', {});
  assert.equal(list.approvals[0].requested_by, 'Claude');
  await rejects(run(sam, 'chat.decide_approval', { approval: ask.pending.approval_id, approve: true }, { via: 'mcp' }), /Only a person/);
  const done = await run(sam, 'chat.decide_approval', { approval: ask.pending.approval_id, approve: true });
  assert.equal(done.status, 'done');
  assert.equal(await app.chat.findPerson(app.teamId, 'avery'), null);
  // Unknown input is refused, not ignored.
  await rejects(run(sam, 'chat.post_message', { channel: 'general', body: 'x', sneaky: 1 }), /Unrecognized key/);
});

test('events: a cursor catches up on exactly what you may see', async () => {
  const { sam, jordan, casey, run } = await makeApp();
  const start = await run(casey, 'chat.list_events', {});
  assert.deepEqual(start.events, []);
  await run(sam, 'chat.post_message', { channel: 'general', body: 'public' });
  const priv = await run(sam, 'chat.create_channel', { name: 'p2', private: true, members: ['jordan'] });
  await run(sam, 'chat.post_message', { channel: priv.id, body: 'hidden' });
  const ev = await run(casey, 'chat.list_events', { since: start.cursor });
  assert.ok(ev.events.some((e) => e.type === 'chat.message.posted' && e.data.message.body === 'public'));
  assert.ok(!ev.events.some((e) => JSON.stringify(e).includes('hidden')), 'nothing from a private channel Casey is not in');
  const evj = await run(jordan, 'chat.list_events', { since: start.cursor });
  assert.ok(evj.events.some((e) => e.data?.message?.body === 'hidden'));
  assert.ok(ev.cursor > start.cursor);
});
