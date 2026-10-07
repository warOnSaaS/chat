// Loads this app into a real wOS suite core (a checkout of warOnSaaS/suite) and drives it there:
// turn Chat on, post, reply, mention the agent, read a private channel as someone else, export.
// Needs Node 22.6 or newer (the suite is TypeScript run directly) and the suite next to this repo.
//   node scripts/suite-check.mjs [path-to-suite]      (default ~/wos-suite)
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';

const suite = path.resolve(process.argv[2] ?? path.join(os.homedir(), 'wos-suite'));
const appDir = path.resolve(new URL('..', import.meta.url).pathname);
const { makeCore, person } = await import(path.join(suite, 'test/unit/helpers.ts'));

const core = await makeCore({ WOS_APPS: appDir });
const sam = await person(core, 'Sam');
const jordan = await person(core, 'Jordan', 'member', sam.team);
await sam.call('apps.enable', { app: 'chat' });
const general = (await sam.call('chat.list_channels')).channels.find((c) => c.name === 'general');
assert.ok(general, 'Chat made #general for the team');
const m = await sam.call('chat.post_message', { channel: 'general', body: 'Hello from inside the suite @jordan' });
const r = await jordan.call('chat.post_reply', { message: m.id, body: 'Hi Sam' });
assert.equal(r.thread_root, m.id);
const mentions = await jordan.call('chat.list_mentions');
assert.equal(mentions.results[0].id, m.id);
const priv = await sam.call('chat.create_channel', { name: 'owners', private: true });
await sam.call('chat.post_message', { channel: priv.id, body: 'private' });
await assert.rejects(jordan.call('chat.read_messages', { channel: priv.id }));
const agent = await sam.call('chat.add_agent', { name: 'Helper', channels: ['general'] });
await sam.call('chat.post_message', { channel: 'general', body: `@${agent.handle} summarise` });
const exp = await sam.call('chat.export_data');
assert.match(exp.file.url, /^\/files\/chat\//);
const tools = [...core.catalogue.tools.keys()].filter((n) => n.startsWith('chat.'));
console.log(`suite check: Chat loaded into the suite, ${tools.length} tools in the catalogue, post, reply, mention, private channel, agent and export all work.`);
await sam.call('apps.disable', { app: 'chat' });
await assert.rejects(sam.call('chat.list_channels'));
console.log('suite check: turned off, its tools are gone.');
await core.stop();
process.exit(0);
