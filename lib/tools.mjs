import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { ChatError } from './chat.mjs';
import { buildExport, readSlackExport } from './export.mjs';
import { newId, nowIso } from './ids.mjs';

// The tool catalogue: everything a person can do in Chat, as tools. The screens call these through
// /api/tools/<name>, agents call the same ones over MCP at /mcp, and tools.json is generated from this list
// (npm run tools:json). Names follow ROADMAP 3.1: app.verb_noun, a plain description, a scope
// (read, write, delete, admin), confirm (none or human) and the events a tool emits.

const ref = (d) => z.string().min(1).describe(d);
const CH = ref('A channel: its name (general, #general) or id');
const MSG = ref('A message id, like m_0mfx3k2a1000a1b2c');

const Person = z.object({ id: z.string(), kind: z.enum(['person', 'agent']), handle: z.string(), name: z.string(), role: z.string() }).passthrough();
const Channel = z.object({ id: z.string(), kind: z.enum(['public', 'private', 'dm', 'group_dm']), name: z.string().nullable(), unread: z.number().optional(), mentions: z.number().optional() }).passthrough();
const Message = z.object({ id: z.string(), channel: z.string(), thread_root: z.string().nullable(), author: z.object({ id: z.string(), handle: z.string(), name: z.string(), kind: z.string() }).passthrough(), body: z.string(), created_at: z.string() }).passthrough();
const FileRef = z.object({ id: z.string(), name: z.string(), type: z.string(), size: z.number(), url: z.string() });

const TOOLS = [];
const tool = (t) => TOOLS.push({ confirm: 'none', emits: [], ...t });

// ---------- reading ----------

tool({
  name: 'chat.list_channels', title: 'List channels', scope: 'read',
  description: 'The channels and direct messages you are in, with unread and mention counts. browse: true adds public channels you have not joined.',
  input: { browse: z.boolean().optional().describe('Also list public channels you are not in'), include_archived: z.boolean().optional() },
  output: z.object({ channels: z.array(Channel) }),
  run: async ({ app, me }, a) => ({ channels: await app.chat.listChannels(me, a) }),
  text: (r) => r.channels.map((c) => `${c.kind === 'dm' || c.kind === 'group_dm' ? '@' : '#'}${c.name} (${c.id})${c.member ? '' : ' not joined'}${c.unread ? `, ${c.unread} unread` : ''}${c.mentions ? `, ${c.mentions} mentions` : ''}${c.topic ? `: ${c.topic}` : ''}`).join('\n') || 'No channels.',
});

tool({
  name: 'chat.get_channel', title: 'Open a channel', scope: 'read',
  description: 'One channel: its topic, who is in it, your notification rule for it and its unread count.',
  input: { channel: CH },
  output: Channel.extend({ members: z.array(z.object({ id: z.string(), handle: z.string(), name: z.string(), kind: z.string() }).passthrough()) }),
  run: async ({ app, me }, a) => app.chat.channelView(me, await app.chat.readable(me, a.channel)),
});

tool({
  name: 'chat.read', title: 'Read messages', scope: 'read',
  description: 'Messages in a channel, oldest first (the latest 50 by default; before gives older ones). Give thread instead to read one thread: its first message and every reply.',
  input: { channel: CH.optional(), thread: MSG.optional().describe('Read this thread instead of the channel'), before: z.string().optional().describe('Only messages older than this id'), after: z.string().optional().describe('Only messages newer than this id'), limit: z.number().int().min(1).max(200).optional() },
  output: z.object({ channel: z.object({ id: z.string() }).passthrough(), messages: z.array(Message), thread: z.string().optional(), more_before: z.boolean().optional() }),
  run: async ({ app, me }, a) => {
    if (!a.channel && !a.thread) throw new ChatError('Give a channel, or a thread.');
    return app.chat.read(me, a);
  },
  text: (r) => r.messages.map(line).join('\n') || 'No messages yet.',
});

tool({
  name: 'chat.search', title: 'Search messages', scope: 'read',
  description: 'Find messages by words, in every channel you can see. Narrow with channel and from, or write in:#channel and from:@person among the words.',
  input: { q: z.string().optional().describe('Words to look for'), channel: CH.optional(), from: z.string().optional().describe('Only messages from this person (handle or name)'), limit: z.number().int().min(1).max(100).optional() },
  output: z.object({ q: z.string(), results: z.array(Message) }),
  run: async ({ app, me }, a) => app.chat.search(me, a),
  text: (r) => r.results.length ? r.results.map((m) => `#${m.channel_name} ${line(m)}`).join('\n') : 'Nothing matches.',
});

tool({
  name: 'chat.list_mentions', title: 'Mentions', scope: 'read',
  description: 'Messages that mention you, newest first.',
  input: { limit: z.number().int().min(1).max(100).optional() },
  output: z.object({ results: z.array(Message) }),
  run: async ({ app, me }, a) => app.chat.mentions(me, a),
  text: (r) => r.results.map((m) => `#${m.channel_name} ${line(m)}`).join('\n') || 'No mentions.',
});

tool({
  name: 'chat.list_people', title: 'List people and agents', scope: 'read',
  description: 'Everyone on the team, people and agents, with handles to @mention and their status. me is you.',
  input: {},
  output: z.object({ me: Person, people: z.array(Person) }),
  run: async ({ app, me }) => ({ me: (await app.chat.people(me.team_id)).find((p) => p.id === me.id), people: await app.chat.people(me.team_id) }),
  text: (r) => r.people.map((p) => `@${p.handle}: ${p.name}${p.kind === 'agent' ? ' (agent)' : ''}${p.status ? `, ${p.status.emoji} ${p.status.text}`.trimEnd() : ''}${p.id === r.me?.id ? ' (you)' : ''}`).join('\n'),
});

tool({
  name: 'chat.list_events', title: 'What changed', scope: 'read',
  description: 'Everything that happened since a cursor: new, edited and deleted messages, reactions, channel changes. Returns a new cursor. Screens use it to catch up after being away, and as the live feed when WebSockets are not available.',
  input: { since: z.number().int().min(0).optional().describe('The cursor from the last call (0 or empty: start from now)'), limit: z.number().int().min(1).max(500).optional() },
  output: z.object({ events: z.array(z.object({ id: z.number(), type: z.string() }).passthrough()), cursor: z.number() }),
  run: async ({ app, me }, a) => app.chat.events(me, a),
});

tool({
  name: 'chat.get_settings', title: 'Your settings', scope: 'read',
  description: 'Your notification rule, keywords, theme, push devices, the server push key, and whether agents have a real model.',
  input: {},
  output: z.object({ prefs: z.object({}).passthrough(), push: z.object({ public_key: z.string().nullable(), devices: z.number() }), model_ready: z.boolean(), team: z.object({}).passthrough() }).passthrough(),
  run: async ({ app, me }) => ({
    prefs: await app.chat.prefs(me),
    push: { public_key: app.push.publicKey, devices: await app.push.count(me) },
    model_ready: app.agents.modelReady(),
    team: { id: me.team_id, name: (await app.chat.team(me.team_id))?.name, demo: !!app.demo, storage: app.chat.db.kind, files: app.files.mode },
    me: { id: me.id, handle: me.handle, name: me.name, role: me.role },
  }),
});

// ---------- writing ----------

tool({
  name: 'chat.post', title: 'Post a message', scope: 'write', emits: ['message.posted'],
  description: 'Post a message to a channel or direct message. Markdown works. @handle mentions someone (and wakes an agent); @channel tells everyone in it. files: ids from chat.upload_file.',
  input: { channel: CH, body: z.string().describe('The message, in markdown'), files: z.array(z.string()).max(10).optional() },
  output: Message,
  run: async ({ app, me, via }, a) => app.chat.post(me, { channel: a.channel, body: a.body, files: a.files ?? [], via: via === 'web' ? null : via }),
  text: (m) => `Posted ${m.id}.`,
});

tool({
  name: 'chat.reply', title: 'Reply in a thread', scope: 'write', emits: ['message.posted', 'thread.updated'],
  description: 'Reply in the thread of a message (any message in the thread works). Mention an agent here and it answers in the same thread.',
  input: { message: MSG.describe('The message to reply to'), body: z.string(), files: z.array(z.string()).max(10).optional() },
  output: Message,
  run: async ({ app, me, via }, a) => app.chat.post(me, { thread: a.message, body: a.body, files: a.files ?? [], via: via === 'web' ? null : via }),
  text: (m) => `Replied ${m.id} in thread ${m.thread_root}.`,
});

tool({
  name: 'chat.edit', title: 'Edit a message', scope: 'write', emits: ['message.edited'],
  description: 'Change the words of one of your own messages.',
  input: { message: MSG, body: z.string() },
  output: Message,
  run: async ({ app, me }, a) => app.chat.edit(me, a),
  text: (m) => `Edited ${m.id}.`,
});

tool({
  name: 'chat.delete', title: 'Delete a message', scope: 'delete', emits: ['message.deleted'],
  description: 'Delete one of your messages (admins can delete anyone\'s). The words are wiped. Only when the person clearly asks.',
  input: { message: MSG },
  output: z.object({ message: z.string(), deleted: z.boolean() }),
  run: async ({ app, me }, a) => app.chat.remove(me, a),
});

tool({
  name: 'chat.react', title: 'React', scope: 'write', emits: ['reaction.changed'],
  description: 'Add an emoji reaction to a message, or take yours off with remove: true.',
  input: { message: MSG, emoji: z.string().describe('One emoji, like 👍'), remove: z.boolean().optional() },
  output: z.object({ message: z.string(), reactions: z.array(z.object({ emoji: z.string(), count: z.number() }).passthrough()) }),
  run: async ({ app, me }, a) => app.chat.react(me, a),
});

tool({
  name: 'chat.upload_file', title: 'Upload a file', scope: 'write',
  description: 'Upload a file (as base64) to attach to a message with chat.post or chat.reply. The screens stream files to /files instead; this is the same thing for agents.',
  input: { name: z.string(), type: z.string().optional().describe('Like image/png'), content_base64: z.string() },
  output: FileRef,
  run: async ({ app, me }, a) => app.files.put(me, { name: a.name, type: a.type, data: Buffer.from(a.content_base64, 'base64') }),
});

tool({
  name: 'chat.set_typing', title: 'Typing', scope: 'write', emits: ['typing'],
  description: 'Tell others in a channel (or thread) that you are typing. Lasts a few seconds; nothing is stored.',
  input: { channel: CH, thread: MSG.optional() },
  output: z.object({ ok: z.boolean() }),
  run: async ({ app, me }, a) => {
    const c = await app.chat.readable(me, a.channel);
    const audience = c.kind === 'public' ? 'team' : (await app.chat.db.all('select member_id from chat_members where channel_id = $1', [c.id])).map((r) => r.member_id);
    await app.bus.publish({ team: me.team_id, channel: c.id, type: 'typing', audience, data: { person: { id: me.id, handle: me.handle, name: me.name }, thread: a.thread ?? null }, ephemeral: true });
    return { ok: true };
  },
});

// ---------- channels and people ----------

tool({
  name: 'chat.create_channel', title: 'Create a channel', scope: 'write', emits: ['channel.created', 'member.joined'],
  description: 'Make a channel. Public channels anyone on the team can find and join; private ones only invited people see.',
  input: { name: z.string().describe('Lowercase, dashes for spaces, like launch-plans'), private: z.boolean().optional(), topic: z.string().optional(), members: z.array(z.string()).optional().describe('Handles to add straight away') },
  output: Channel,
  run: async ({ app, me }, a) => app.chat.createChannel(me, { name: a.name, kind: a.private ? 'private' : 'public', topic: a.topic, members: a.members ?? [] }),
  text: (c) => `Created #${c.name} (${c.id}).`,
});

tool({
  name: 'chat.open_dm', title: 'Message someone directly', scope: 'write', emits: ['channel.created'],
  description: 'Open (or find) a direct message with one person or agent, or a group message with up to 8. Then post to it with chat.post.',
  input: { people: z.array(z.string()).min(1).max(8).describe('Handles or names') },
  output: Channel,
  run: async ({ app, me }, a) => app.chat.openDm(me, a),
  text: (c) => `Direct message ${c.id} with ${c.name}.`,
});

tool({
  name: 'chat.invite', title: 'Add people to a channel', scope: 'write', emits: ['member.joined'],
  description: 'Add people or agents to a channel you are in. Adding an agent lets it answer when mentioned there.',
  input: { channel: CH, people: z.array(z.string()).min(1).describe('Handles or names') },
  output: z.object({ channel: z.string(), added: z.array(z.string()) }),
  run: async ({ app, me }, a) => app.chat.invite(me, a),
});

tool({
  name: 'chat.join', title: 'Join a channel', scope: 'write', emits: ['member.joined'],
  description: 'Join a public channel.',
  input: { channel: CH },
  output: Channel,
  run: async ({ app, me }, a) => app.chat.join(me, a),
});

tool({
  name: 'chat.leave', title: 'Leave a channel', scope: 'write', emits: ['member.left'],
  description: 'Leave a channel. You can rejoin a public one any time; a private one needs an invite.',
  input: { channel: CH },
  output: z.object({ channel: z.string(), left: z.boolean() }),
  run: async ({ app, me }, a) => app.chat.leave(me, a),
});

tool({
  name: 'chat.set_topic', title: 'Set the topic', scope: 'write', emits: ['channel.updated'],
  description: 'Set or clear (empty) the one-line topic shown at the top of a channel.',
  input: { channel: CH, topic: z.string().max(250) },
  output: Channel,
  run: async ({ app, me }, a) => app.chat.setTopic(me, a),
});

tool({
  name: 'chat.archive_channel', title: 'Archive a channel', scope: 'admin', emits: ['channel.updated'],
  description: 'Archive a channel: it stays readable and searchable but nobody can post. archived: false brings it back.',
  input: { channel: CH, archived: z.boolean().optional() },
  output: Channel,
  run: async ({ app, me }, a) => app.chat.archive(me, { channel: a.channel, archived: a.archived ?? true }),
});

tool({
  name: 'chat.set_status', title: 'Set your status', scope: 'write', emits: ['person.updated'],
  description: 'Set your status line and emoji, like "In meetings" 📅. Empty clears it.',
  input: { text: z.string().max(100).optional(), emoji: z.string().max(16).optional() },
  output: Person,
  run: async ({ app, me }, a) => app.chat.setStatus(me, a),
});

tool({
  name: 'chat.add_person', title: 'Add someone to the team', scope: 'admin', emits: ['person.added'],
  description: 'Let someone sign in: by GitHub username, by email (for the email link), or both. They join #general.',
  input: { name: z.string(), email: z.string().email().optional(), github: z.string().optional(), handle: z.string().optional(), role: z.enum(['admin', 'member', 'guest']).optional() },
  output: Person,
  run: async ({ app, me }, a) => {
    if (!a.email && !a.github) throw new ChatError('Give an email or a GitHub username, so they can sign in.');
    return app.chat.addPerson(me.team_id, { ...a, role: a.role ?? 'member' });
  },
});

tool({
  name: 'chat.remove_person', title: 'Remove someone from the team', scope: 'admin', confirm: 'human', emits: ['person.removed'],
  description: 'Take someone off the team: they are signed out and leave every channel. Their messages stay. An agent calling this asks a person first.',
  input: { person: z.string().describe('Handle, name or email') },
  output: Person,
  run: async ({ app, me }, a) => app.chat.removePerson(me, a.person),
});

tool({
  name: 'chat.add_agent', title: 'Add an agent', scope: 'admin', emits: ['person.added', 'member.joined'],
  description: 'Add an AI agent as a team member. It answers in the thread when @mentioned in a channel it is in, or when messaged directly. It uses the server\'s model (CHAT_MODEL_URL, CHAT_MODEL_KEY, CHAT_MODEL) unless you give it its own.',
  input: { name: z.string(), handle: z.string().optional(), description: z.string().optional(), prompt: z.string().optional().describe('How it should behave'), model: z.string().optional(), base_url: z.string().url().optional().describe('Any OpenAI-compatible server'), channels: z.array(z.string()).optional() },
  output: Person,
  run: async ({ app, me }, a) => {
    const p = await app.chat.addPerson(me.team_id, { name: a.name, handle: a.handle ?? a.name, kind: 'agent', role: 'member', about: a.description, agent: { description: a.description, prompt: a.prompt, model: a.model, base_url: a.base_url } });
    for (const c of a.channels ?? []) await app.chat.invite(me, { channel: c, people: [p.handle] });
    return p;
  },
});

// ---------- reading state and notifications ----------

tool({
  name: 'chat.mark_read', title: 'Mark as read', scope: 'write', emits: ['read.changed'],
  description: 'Mark a channel read, up to the newest message or up to a given message.',
  input: { channel: CH, message: MSG.optional() },
  output: z.object({ channel: z.string(), last_read_id: z.string().nullable(), unread: z.number(), mentions: z.number() }),
  run: async ({ app, me }, a) => app.chat.markRead(me, a),
});

tool({
  name: 'chat.mark_unread', title: 'Mark unread', scope: 'write', emits: ['read.changed'],
  description: 'Mark a channel unread from a message on, to come back to it later.',
  input: { message: MSG },
  output: z.object({ channel: z.string(), last_read_id: z.string().nullable(), unread: z.number(), mentions: z.number() }),
  run: async ({ app, me }, a) => app.chat.markUnread(me, a),
});

tool({
  name: 'chat.set_notify', title: 'Notification rule', scope: 'write',
  description: 'When to be notified. For one channel: all, mentions, none, or default (follow your own rule). Without a channel: your own rule for every channel, all, mentions or none. Direct messages always notify unless set to none.',
  input: { channel: CH.optional(), level: z.enum(['all', 'mentions', 'none', 'default']) },
  output: z.object({ scope: z.string(), level: z.string() }).passthrough(),
  run: async ({ app, me }, a) => app.chat.setNotify(me, a),
});

tool({
  name: 'chat.set_preferences', title: 'Preferences', scope: 'write',
  description: 'Your preferences: theme (auto, light, dark), push (true or false: phone and desktop notifications), keywords (words that notify you anywhere).',
  input: { theme: z.enum(['auto', 'light', 'dark']).optional(), push: z.boolean().optional(), keywords: z.array(z.string()).max(30).optional() },
  output: z.object({ theme: z.string(), push: z.boolean(), keywords: z.array(z.string()), notify: z.string() }).passthrough(),
  run: async ({ app, me }, a) => app.chat.setPrefs(me, a),
});

tool({
  name: 'chat.subscribe_push', title: 'Turn on notifications on this device', scope: 'write',
  description: 'Save a browser push subscription so mentions and direct messages reach this device. The browser asks the person first; an agent cannot click that.',
  input: { subscription: z.object({ endpoint: z.string().url(), keys: z.object({ p256dh: z.string(), auth: z.string() }) }) },
  output: z.object({ subscribed: z.boolean(), devices: z.number() }),
  run: async ({ app, me }, a) => app.push.subscribe(me, a.subscription),
});

tool({
  name: 'chat.unsubscribe_push', title: 'Turn off notifications on a device', scope: 'write',
  description: 'Stop push notifications to one device (its endpoint) or, without one, to all your devices.',
  input: { endpoint: z.string().optional() },
  output: z.object({ subscribed: z.boolean(), devices: z.number() }),
  run: async ({ app, me }, a) => app.push.unsubscribe(me, a.endpoint),
});

// ---------- approvals (confirm: human) ----------

tool({
  name: 'chat.list_approvals', title: 'Waiting for your yes', scope: 'read',
  description: 'Things an agent asked to do that need your yes first.',
  input: {},
  output: z.object({ approvals: z.array(z.object({ id: z.string(), tool: z.string(), status: z.string() }).passthrough()) }),
  run: async ({ app, me }) => ({ approvals: (await app.chat.db.all(`select * from chat_approvals where person_id = $1 and status = 'waiting' order by created_at desc`, [me.id])).map(approvalView) }),
});

tool({
  name: 'chat.decide_approval', title: 'Approve or decline', scope: 'write',
  description: 'Say yes or no to something an agent asked to do. Yes runs it as you.',
  input: { approval: z.string(), approve: z.boolean() },
  output: z.object({ id: z.string(), status: z.string() }).passthrough(),
  run: async ({ app, me, via }, a) => {
    if (via !== 'web') throw new ChatError('Only a person can approve, from the app.', 403);
    const row = await app.chat.db.get('select * from chat_approvals where id = $1 and person_id = $2', [a.approval, me.id]);
    if (!row || row.status !== 'waiting') throw new ChatError('Nothing waiting with that id.', 404);
    let status = 'declined', result = null;
    if (a.approve) {
      try { result = await runTool(app, me, row.tool, JSON.parse(row.input), { via: 'web', approved: true }); status = 'done'; } catch (e) { result = { error: e.message }; status = 'failed'; }
    }
    await app.chat.db.run('update chat_approvals set status = $2, result = $3, decided_at = $4 where id = $1', [row.id, status, JSON.stringify(result), nowIso()]);
    return { ...approvalView({ ...row, status }), result };
  },
});

// ---------- export and import ----------

tool({
  name: 'chat.export', title: 'Export everything', scope: 'admin',
  description: 'Export every channel, message, reaction, file and person as a zip in the Slack export layout (plus a lossless wos/ folder). Returns a download link.',
  input: {},
  output: z.object({ file: FileRef, counts: z.object({}).passthrough() }),
  run: async ({ app, me }) => {
    const { zip, counts } = await buildExport(app.chat, app.files, me.team_id);
    const file = await app.files.put(me, { name: `chat-export-${new Date().toISOString().slice(0, 10)}.zip`, type: 'application/zip', data: zip });
    return { file, counts };
  },
  text: (r) => `Export ready: ${r.file.url} (${r.counts.messages} messages, ${r.counts.channels} channels, ${r.counts.files} files).`,
});

tool({
  name: 'chat.import_slack', title: 'Import from Slack', scope: 'admin', confirm: 'human',
  description: 'Preview a Slack export zip (uploaded with chat.upload_file): who and what it holds, and what Slack left out. Bringing it in lands in v1; for now this previews only.',
  input: { file: z.string().describe('The uploaded zip\'s file id'), commit: z.boolean().optional() },
  output: z.object({ people: z.number(), channels: z.number(), messages: z.number(), warnings: z.array(z.string()), committed: z.boolean() }),
  run: async ({ app, me }, a) => {
    const f = await app.files.readable(me, a.file);
    if (!f) throw new ChatError('No uploaded file with that id.', 404);
    const s = readSlackExport(await app.files.read(f));
    const out = { people: s.people.length, channels: s.channels.length, messages: s.messages.length, warnings: s.warnings, committed: false };
    if (a.commit) throw new ChatError(`Importing lands in v1. The preview found ${out.people} people, ${out.channels} channels and ${out.messages} messages.`, 501);
    return out;
  },
});

// ---------- running tools ----------

export const CALLED = new Set(); // which tools ran, for the catalogue test

export function listTools() {
  return TOOLS.map((t) => ({ ...t, inputJson: jsonSchema(z.object(t.input)), outputJson: jsonSchema(t.output) }));
}

export function getTool(name) { return TOOLS.find((t) => t.name === name); }

function jsonSchema(s) {
  const j = zodToJsonSchema(s, { target: 'jsonSchema7', $refStrategy: 'none' });
  delete j.$schema;
  return j;
}

const SCOPES = ['read', 'write', 'delete', 'admin'];

// via: 'web' (a person clicked), 'mcp' or 'rest' (an app acting for a person), 'agent' (a chat agent).
export async function runTool(app, me, name, input = {}, { via = 'web', scopes = SCOPES, approved = false, client = null } = {}) {
  const t = getTool(name);
  if (!t) throw new ChatError(`No tool called ${name}.`, 404);
  const parsed = z.object(t.input).strict().safeParse(input ?? {});
  if (!parsed.success) throw new ChatError(parsed.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; '), 400);
  if (!scopes.includes(t.scope)) throw new ChatError(`This connection may not ${t.scope} (it has ${scopes.join(', ')}).`, 403);
  if (t.scope === 'admin' && !['owner', 'admin'].includes(me.role)) throw new ChatError('Only team owners and admins can do that.', 403);
  if (me.role === 'guest' && ['chat.create_channel', 'chat.invite', 'chat.add_agent'].includes(name)) throw new ChatError('Guests cannot do that.', 403);
  if (t.confirm === 'human' && via !== 'web' && !approved) {
    const id = newId('ap');
    await app.chat.db.run('insert into chat_approvals (id, team_id, person_id, requested_by, tool, input, created_at) values ($1, $2, $3, $4, $5, $6, $7)',
      [id, me.team_id, me.id, client || via, name, JSON.stringify(parsed.data), nowIso()]);
    await app.bus.publish({ team: me.team_id, type: 'approval.requested', audience: [me.id], data: { approval: approvalView({ id, tool: name, input: JSON.stringify(parsed.data), requested_by: client || via, status: 'waiting', created_at: nowIso() }) } });
    CALLED.add(name);
    return { needs_approval: true, approval: id, message: `${t.title} needs a person's yes. ${me.name} has been asked in the app; nothing happened yet.` };
  }
  const out = await t.run({ app, me, via }, parsed.data);
  CALLED.add(name);
  return out;
}

export function toText(name, result) {
  const t = getTool(name);
  if (result?.needs_approval) return result.message;
  try { if (t?.text) return t.text(result); } catch {}
  return JSON.stringify(result, null, 1);
}

function approvalView(r) {
  let input = {};
  try { input = JSON.parse(r.input); } catch {}
  return { id: r.id, tool: r.tool, title: getTool(r.tool)?.title ?? r.tool, input, requested_by: r.requested_by, status: r.status, created_at: r.created_at };
}

function line(m) {
  const when = String(m.created_at).slice(0, 16).replace('T', ' ');
  const who = m.author.kind === 'agent' ? `${m.author.name} (agent)` : m.author.name;
  const body = m.deleted ? '(deleted)' : m.body.replace(/\s+/g, ' ').slice(0, 400);
  const extra = [m.reply_count ? `${m.reply_count} replies` : '', m.reactions?.length ? m.reactions.map((r) => `${r.emoji}${r.count}`).join(' ') : '', m.files?.length ? `${m.files.length} file(s)` : '', m.edited_at ? 'edited' : ''].filter(Boolean).join(', ');
  return `- ${when} ${who}: ${body} (${m.id}${extra ? `; ${extra}` : ''})`;
}
