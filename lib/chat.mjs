import { newId, nowIso } from './ids.mjs';
import { renderMarkdown, mentionedHandles, isEveryone } from './markdown.mjs';

// The chat itself: channels, members, messages, threads, reactions, mentions, unread counts, search and
// notification rules. Every method takes the person acting (me) and checks what they may see and do.
// Tools (lib/tools.mjs) are the only callers; screens and agents both go through them.

export class ChatError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
const fail = (m, s) => { throw new ChatError(m, s); };

export const HANDLE = /^[a-z0-9][a-z0-9._-]{0,39}$/;
export const CHANNEL_NAME = /^[a-z0-9][a-z0-9_-]{0,79}$/;
const MAX_BODY = 40000;
const inList = (n, from = 1) => Array.from({ length: n }, (_, i) => `$${i + from}`).join(', ');
const num = (v) => Number(v ?? 0);
const parse = (s, d = null) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };

export class Chat {
  constructor({ db, bus }) {
    this.db = db;
    this.bus = bus;
    this.hooks = { posted: [] };
  }

  onPosted(fn) { this.hooks.posted.push(fn); }

  // ---------- teams and people ----------

  async ensureTeam(id, name, { demo = false } = {}) {
    const t = await this.db.get('select * from chat_teams where id = $1', [id]);
    if (t) return t;
    await this.db.run('insert into chat_teams (id, name, demo, created_at) values ($1, $2, $3, $4) on conflict (id) do nothing', [id, name, demo ? 1 : 0, nowIso()]);
    return this.db.get('select * from chat_teams where id = $1', [id]);
  }

  async team(id) { return this.db.get('select * from chat_teams where id = $1', [id]); }

  async people(teamId, { all = false } = {}) {
    const rows = await this.db.all(`select * from chat_people where team_id = $1 ${all ? '' : 'and deactivated_at is null'} order by kind, name`, [teamId]);
    return rows.map(personView);
  }

  async personRow(id) { return this.db.get('select * from chat_people where id = $1', [id]); }

  async findPerson(teamId, ref) {
    const r = String(ref ?? '').trim().replace(/^@/, '').toLowerCase();
    if (!r) return null;
    return this.db.get(`select * from chat_people where team_id = $1 and deactivated_at is null and (id = $2 or lower(handle) = $2 or lower(email) = $2 or lower(github) = $2 or lower(name) = $2)`, [teamId, r]);
  }

  async mustFindPerson(teamId, ref) {
    return (await this.findPerson(teamId, ref)) ?? fail(`No one called ${ref} on this team. Use chat.list_people to see who is here.`, 404);
  }

  async addPerson(teamId, { name, handle, email, github, role = 'member', kind = 'person', agent = null, about = null }) {
    handle = String(handle || (email && email.split('@')[0]) || github || String(name ?? '').split(/\s+/)[0] || '').toLowerCase().replace(/[^a-z0-9._-]+/g, '').slice(0, 40) || 'someone';
    if (!HANDLE.test(handle)) fail('A handle is lowercase letters, numbers, dots, dashes or underscores.');
    if (await this.db.get('select id from chat_people where team_id = $1 and lower(handle) = $2', [teamId, handle])) fail(`The handle @${handle} is taken.`, 409);
    const id = newId(kind === 'agent' ? 'a' : 'p');
    await this.db.run(`insert into chat_people (id, team_id, kind, handle, name, email, github, role, about, agent, created_at) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [id, teamId, kind, handle, name || handle, email?.toLowerCase() ?? null, github ?? null, role, about, agent ? JSON.stringify(agent) : null, nowIso()]);
    // Everyone joins the team's default channels.
    const defaults = await this.db.all(`select id from chat_channels where team_id = $1 and kind = 'public' and archived_at is null and (name = 'general' or name = 'random')`, [teamId]);
    for (const c of defaults) await this.#addMember(c.id, id, kind);
    const p = personView(await this.personRow(id));
    await this.bus.publish({ team: teamId, type: 'person.added', data: { person: p } });
    return p;
  }

  async removePerson(me, ref) {
    const p = await this.mustFindPerson(me.team_id, ref);
    if (p.id === me.id) fail('You cannot remove yourself.');
    if (p.role === 'owner') fail('The owner cannot be removed.');
    await this.db.run('update chat_people set deactivated_at = $2 where id = $1', [p.id, nowIso()]);
    await this.db.run('delete from chat_members where member_id = $1', [p.id]);
    await this.db.run('delete from chat_push_subs where person_id = $1', [p.id]);
    await this.bus.publish({ team: me.team_id, type: 'person.removed', data: { person: personView(p) } });
    return personView({ ...p, deactivated_at: nowIso() });
  }

  async setStatus(me, { text, emoji }) {
    await this.db.run('update chat_people set status_text = $2, status_emoji = $3 where id = $1', [me.id, text?.slice(0, 100) || null, emoji?.slice(0, 16) || null]);
    const p = personView(await this.personRow(me.id));
    await this.bus.publish({ team: me.team_id, type: 'person.updated', data: { person: p } });
    return p;
  }

  async prefs(me) {
    const row = await this.personRow(me.id);
    return { notify: 'mentions', push: true, keywords: [], theme: 'auto', ...parse(row?.prefs, {}) };
  }

  async setPrefs(me, patch) {
    const next = { ...(await this.prefs(me)), ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) };
    if (next.keywords) next.keywords = [...new Set(next.keywords.map((k) => String(k).trim().toLowerCase()).filter(Boolean))].slice(0, 30);
    await this.db.run('update chat_people set prefs = $2 where id = $1', [me.id, JSON.stringify(next)]);
    return next;
  }

  // ---------- channels ----------

  async channelRow(teamId, ref) {
    const r = String(ref ?? '').trim().replace(/^#/, '');
    if (!r) return null;
    return this.db.get('select * from chat_channels where team_id = $1 and (id = $2 or lower(name) = $3)', [teamId, r, r.toLowerCase()]);
  }

  async member(channelId, personId) {
    return this.db.get('select * from chat_members where channel_id = $1 and member_id = $2', [channelId, personId]);
  }

  // A channel this person may read: public on their team, or one they belong to.
  async readable(me, ref) {
    const c = await this.channelRow(me.team_id, ref);
    if (!c) fail(`No channel ${ref}. Use chat.list_channels to see them.`, 404);
    if (c.kind !== 'public' && !(await this.member(c.id, me.id))) fail(`No channel ${ref}. Use chat.list_channels to see them.`, 404);
    return c;
  }

  async writable(me, ref) {
    const c = await this.readable(me, ref);
    if (c.archived_at) fail(`#${c.name} is archived.`);
    if (!(await this.member(c.id, me.id))) {
      if (c.kind === 'public') { await this.#addMember(c.id, me.id, me.kind); await this.#joined(c, me, me); } else fail('Join the channel first.', 403);
    }
    return c;
  }

  async listChannels(me, { include_archived = false, browse = false } = {}) {
    const rows = await this.db.all(`
      select c.*, m.member_id as is_member, m.last_read_id, m.notify,
        (select count(*) from chat_messages x where x.channel_id = c.id and x.thread_root_id is null and x.deleted_at is null and x.author_id <> $2 and (m.last_read_id is null or x.id > m.last_read_id)) as unread,
        (select count(*) from chat_mentions mm join chat_messages x on x.id = mm.message_id where mm.member_id = $2 and x.channel_id = c.id and x.deleted_at is null and x.author_id <> $2 and (m.last_read_id is null or x.id > m.last_read_id)) as mentions,
        (select max(x.id) from chat_messages x where x.channel_id = c.id and x.thread_root_id is null and x.deleted_at is null) as last_id,
        (select count(*) from chat_members y where y.channel_id = c.id) as member_count
      from chat_channels c left join chat_members m on m.channel_id = c.id and m.member_id = $2
      where c.team_id = $1 and (m.member_id is not null or c.kind = 'public') ${include_archived ? '' : 'and c.archived_at is null'}
      order by c.name`, [me.team_id, me.id]);
    const visible = browse ? rows : rows.filter((r) => r.is_member);
    const dmIds = visible.filter((r) => r.kind === 'dm' || r.kind === 'group_dm').map((r) => r.id);
    const others = dmIds.length ? await this.db.all(`select m.channel_id, p.id, p.handle, p.name, p.kind from chat_members m join chat_people p on p.id = m.member_id where m.channel_id in (${inList(dmIds.length)})`, dmIds) : [];
    return visible.map((r) => {
      const dmPeople = others.filter((o) => o.channel_id === r.id && o.id !== me.id);
      const dm = r.kind === 'dm' || r.kind === 'group_dm';
      return {
        id: r.id, kind: r.kind, name: dm ? (dmPeople.map((p) => p.name.split(' ')[0]).join(', ') || 'Just you') : r.name,
        topic: r.topic, member: !!r.is_member, member_count: num(r.member_count), archived: !!r.archived_at,
        unread: num(r.unread), mentions: dm ? num(r.unread) : num(r.mentions), last_id: r.last_id, last_read_id: r.last_read_id,
        notify: r.notify ?? null, with: dm ? dmPeople.map((p) => ({ id: p.id, handle: p.handle, name: p.name, kind: p.kind })) : undefined,
      };
    });
  }

  async channelView(me, c) {
    const members = await this.db.all('select p.id, p.handle, p.name, p.kind, m.role from chat_members m join chat_people p on p.id = m.member_id where m.channel_id = $1 order by p.kind, p.name', [c.id]);
    const mine = await this.member(c.id, me.id);
    const list = await this.listChannels(me, { browse: true, include_archived: true });
    const summary = list.find((x) => x.id === c.id) ?? {};
    return { ...summary, id: c.id, kind: c.kind, name: summary.name ?? c.name, topic: c.topic, archived: !!c.archived_at, created_at: c.created_at, member: !!mine, notify: mine?.notify ?? null, members };
  }

  async createChannel(me, { name, kind = 'public', topic = null, members = [] }) {
    name = String(name ?? '').trim().replace(/^#/, '').toLowerCase().replace(/\s+/g, '-');
    if (!CHANNEL_NAME.test(name)) fail('A channel name is lowercase letters, numbers, dashes or underscores, up to 80.');
    if (!['public', 'private'].includes(kind)) fail('kind is public or private. For a direct message use chat.open_dm.');
    if (await this.channelRow(me.team_id, name)) fail(`#${name} already exists.`, 409);
    const id = newId('c');
    await this.db.run('insert into chat_channels (id, team_id, name, kind, topic, created_by, created_at) values ($1, $2, $3, $4, $5, $6, $7)', [id, me.team_id, name, kind, topic, me.id, nowIso()]);
    await this.#addMember(id, me.id, me.kind, 'admin');
    const c = await this.channelRow(me.team_id, id);
    await this.bus.publish({ team: me.team_id, channel: id, type: 'channel.created', audience: kind === 'public' ? 'team' : [me.id], data: { channel: { id, name, kind, topic } } });
    if (members.length) await this.invite(me, { channel: id, people: members });
    return this.channelView(me, c);
  }

  async openDm(me, { people }) {
    const found = [];
    for (const ref of people) found.push(await this.mustFindPerson(me.team_id, ref));
    const ids = [...new Set([me.id, ...found.map((p) => p.id)])].sort();
    if (ids.length > 9) fail('A group message holds up to 9 people. Make a private channel instead.');
    const kind = ids.length <= 2 ? 'dm' : 'group_dm';
    const key = ids.join(',');
    let c = await this.db.get('select * from chat_channels where team_id = $1 and dm_key = $2', [me.team_id, key]);
    if (!c) {
      const id = newId('d');
      await this.db.run('insert into chat_channels (id, team_id, kind, created_by, created_at, dm_key) values ($1, $2, $3, $4, $5, $6) on conflict do nothing', [id, me.team_id, kind, me.id, nowIso(), key]);
      c = await this.db.get('select * from chat_channels where team_id = $1 and dm_key = $2', [me.team_id, key]);
      if (c.id === id) {
        const all = await this.db.all(`select id, kind from chat_people where id in (${inList(ids.length)})`, ids);
        for (const p of all) await this.#addMember(c.id, p.id, p.kind);
        await this.bus.publish({ team: me.team_id, channel: c.id, type: 'channel.created', audience: ids, data: { channel: { id: c.id, kind } } });
      }
    }
    return this.channelView(me, c);
  }

  async #addMember(channelId, personId, kind = 'person', role = 'member') {
    const last = await this.db.get('select max(id) as id from chat_messages where channel_id = $1', [channelId]);
    await this.db.run('insert into chat_members (channel_id, member_id, member_kind, role, last_read_id, joined_at) values ($1, $2, $3, $4, $5, $6) on conflict (channel_id, member_id) do nothing',
      [channelId, personId, kind, role, last?.id ?? null, nowIso()]);
  }

  async #audience(c) {
    if (c.kind === 'public') return 'team';
    return (await this.db.all('select member_id from chat_members where channel_id = $1', [c.id])).map((r) => r.member_id);
  }

  async #joined(c, who, by) {
    const audience = await this.#audience(c);
    await this.bus.publish({ team: c.team_id, channel: c.id, type: 'member.joined', audience, data: { channel: c.id, person: { id: who.id, handle: who.handle, name: who.name, kind: who.kind }, by: by.id } });
  }

  async invite(me, { channel, people }) {
    const c = await this.writable(me, channel);
    if (c.kind === 'dm') fail('A direct message has exactly two people. Use chat.open_dm with everyone to start a group message.');
    const added = [];
    for (const ref of people) {
      const p = await this.mustFindPerson(me.team_id, ref);
      if (await this.member(c.id, p.id)) continue;
      await this.#addMember(c.id, p.id, p.kind);
      await this.#joined(c, p, me);
      added.push(p.handle);
    }
    return { channel: c.id, added };
  }

  async join(me, { channel }) {
    const c = await this.readable(me, channel);
    if (c.kind !== 'public') fail('Private channels are joined by invitation.', 403);
    if (c.archived_at) fail(`#${c.name} is archived.`);
    if (!(await this.member(c.id, me.id))) { await this.#addMember(c.id, me.id, me.kind); await this.#joined(c, me, me); }
    return this.channelView(me, c);
  }

  async leave(me, { channel }) {
    const c = await this.readable(me, channel);
    if (c.kind === 'dm' || c.kind === 'group_dm') fail('You cannot leave a direct message.');
    const audience = await this.#audience(c);
    await this.db.run('delete from chat_members where channel_id = $1 and member_id = $2', [c.id, me.id]);
    await this.bus.publish({ team: me.team_id, channel: c.id, type: 'member.left', audience, data: { channel: c.id, person: { id: me.id, handle: me.handle } } });
    return { channel: c.id, left: true };
  }

  async setTopic(me, { channel, topic }) {
    const c = await this.writable(me, channel);
    await this.db.run('update chat_channels set topic = $2 where id = $1', [c.id, topic?.slice(0, 250) || null]);
    await this.bus.publish({ team: me.team_id, channel: c.id, type: 'channel.updated', audience: await this.#audience(c), data: { channel: { id: c.id, topic: topic || null } } });
    return this.channelView(me, await this.channelRow(me.team_id, c.id));
  }

  async archive(me, { channel, archived = true }) {
    const c = await this.readable(me, channel);
    if (c.kind !== 'public' && c.kind !== 'private') fail('Only channels can be archived.');
    if (c.name === 'general' && archived) fail('#general cannot be archived.');
    await this.db.run('update chat_channels set archived_at = $2 where id = $1', [c.id, archived ? nowIso() : null]);
    await this.bus.publish({ team: me.team_id, channel: c.id, type: 'channel.updated', audience: await this.#audience(c), data: { channel: { id: c.id, archived } } });
    return this.channelView(me, await this.channelRow(me.team_id, c.id));
  }

  // ---------- messages ----------

  async messageRow(id) { return this.db.get('select * from chat_messages where id = $1', [id]); }

  async readableMessage(me, id) {
    const m = await this.messageRow(id);
    if (!m || m.team_id !== me.team_id) fail(`No message ${id}.`, 404);
    await this.readable(me, m.channel_id);
    return m;
  }

  async read(me, { channel, thread, before, after, limit = 50 }) {
    let c, rows, root = null;
    limit = Math.min(Math.max(Number(limit) || 50, 1), 200);
    if (thread) {
      root = await this.readableMessage(me, thread);
      if (root.thread_root_id) root = await this.messageRow(root.thread_root_id);
      c = await this.channelRow(me.team_id, root.channel_id);
      rows = await this.db.all(`select * from chat_messages where thread_root_id = $1 ${after ? 'and id > $2' : ''} order by id limit ${limit}`, after ? [root.id, after] : [root.id]);
      rows = [root, ...rows];
    } else {
      c = await this.readable(me, channel);
      const where = ['channel_id = $1', 'thread_root_id is null'];
      const params = [c.id];
      if (before) { params.push(before); where.push(`id < $${params.length}`); }
      if (after) { params.push(after); where.push(`id > $${params.length}`); }
      rows = await this.db.all(`select * from chat_messages where ${where.join(' and ')} order by id ${after ? 'asc' : 'desc'} limit ${limit + 1}`, params);
      const more = rows.length > limit;
      rows = rows.slice(0, limit);
      if (!after) rows.reverse();
      const messages = await this.hydrate(me, rows.filter((r) => !r.deleted_at || r.reply_count > 0));
      const mine = await this.member(c.id, me.id);
      return { channel: { id: c.id, name: c.name, kind: c.kind }, messages, more_before: !after && more, last_read_id: mine?.last_read_id ?? null };
    }
    const messages = await this.hydrate(me, rows.filter((r) => r.id === root.id || !r.deleted_at));
    return { channel: { id: c.id, name: c.name, kind: c.kind }, thread: root.id, messages };
  }

  async hydrate(me, rows) {
    if (!rows.length) return [];
    const ids = rows.map((r) => r.id);
    const authorIds = [...new Set(rows.map((r) => r.author_id))];
    const [people, reactions, files, everyone] = await Promise.all([
      this.db.all(`select id, handle, name, kind, status_emoji, agent from chat_people where id in (${inList(authorIds.length)})`, authorIds),
      this.db.all(`select r.message_id, r.emoji, r.member_id, p.handle from chat_reactions r join chat_people p on p.id = r.member_id where r.message_id in (${inList(ids.length)}) order by r.created_at`, ids),
      this.db.all(`select a.message_id, f.id, f.name, f.type, f.size from chat_attachments a join chat_files f on f.id = a.file_id where a.message_id in (${inList(ids.length)})`, ids),
      this.db.all('select handle from chat_people where team_id = $1', [me.team_id]),
    ]);
    const handles = new Set(everyone.map((p) => p.handle.toLowerCase()));
    const byId = new Map(people.map((p) => [p.id, p]));
    return rows.map((r) => {
      const a = byId.get(r.author_id);
      const rx = new Map();
      for (const x of reactions.filter((x) => x.message_id === r.id)) {
        const g = rx.get(x.emoji) ?? { emoji: x.emoji, count: 0, mine: false, people: [] };
        g.count++; g.people.push(x.handle); if (x.member_id === me.id) g.mine = true;
        rx.set(x.emoji, g);
      }
      const deleted = !!r.deleted_at;
      return {
        id: r.id, channel: r.channel_id, thread_root: r.thread_root_id ?? null,
        author: a ? { id: a.id, handle: a.handle, name: a.name, kind: a.kind, example: a.kind === 'agent' ? !!parse(a.agent, {}).example : undefined } : { id: r.author_id, handle: 'unknown', name: 'Someone who left', kind: r.author_kind },
        body: deleted ? '' : r.body, html: deleted ? '' : renderMarkdown(r.body, handles),
        created_at: r.created_at, edited_at: r.edited_at ?? null, deleted,
        reply_count: num(r.reply_count), last_reply_at: r.last_reply_at ?? null,
        reactions: [...rx.values()],
        files: files.filter((f) => f.message_id === r.id).map((f) => ({ id: f.id, name: f.name, type: f.type, size: num(f.size), url: `/files/${f.id}/${encodeURIComponent(f.name)}` })),
        mine: r.author_id === me.id,
      };
    });
  }

  async post(me, { channel, body, thread = null, files = [], via = null }) {
    body = String(body ?? '').trim();
    if (!body && !files.length) fail('Write something, or attach a file.');
    if (body.length > MAX_BODY) fail(`A message is at most ${MAX_BODY} characters.`);
    let c, root = null;
    if (thread) {
      root = await this.readableMessage(me, thread);
      if (root.thread_root_id) root = await this.messageRow(root.thread_root_id);
      if (root.deleted_at && !root.reply_count) fail('That message was deleted.');
      c = await this.writable(me, root.channel_id);
    } else {
      c = await this.writable(me, channel);
    }
    if (files.length) {
      const own = await this.db.all(`select id from chat_files where team_id = $1 and uploader_id = $2 and id in (${inList(files.length, 3)})`, [me.team_id, me.id, ...files]);
      if (own.length !== files.length) fail('Attach files you uploaded yourself (chat.upload_file gives an id).');
    }
    const team = await this.db.all('select id, handle, kind from chat_people where team_id = $1 and deactivated_at is null', [me.team_id]);
    const said = mentionedHandles(body);
    const members = await this.db.all('select member_id from chat_members where channel_id = $1', [c.id]);
    const memberIds = new Set(members.map((m) => m.member_id));
    let mentioned = team.filter((p) => said.includes(p.handle.toLowerCase()) && p.id !== me.id);
    if (said.some(isEveryone)) mentioned = [...new Map([...mentioned, ...team.filter((p) => memberIds.has(p.id) && p.id !== me.id && p.kind === 'person')].map((p) => [p.id, p])).values()];
    // Someone mentioned in a private channel they are not in is not told: the message stays private.
    if (c.kind !== 'public') mentioned = mentioned.filter((p) => memberIds.has(p.id));
    const id = newId('m');
    const at = nowIso();
    await this.db.tx(async (t) => {
      await t.run('insert into chat_messages (id, team_id, channel_id, thread_root_id, author_id, author_kind, body, created_at, meta) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
        [id, me.team_id, c.id, root?.id ?? null, me.id, me.kind, body, at, via ? JSON.stringify({ via }) : null]);
      for (const p of mentioned) await t.run('insert into chat_mentions (message_id, member_id) values ($1, $2) on conflict do nothing', [id, p.id]);
      for (const f of files) await t.run('insert into chat_attachments (message_id, file_id) values ($1, $2) on conflict do nothing', [id, f]);
      if (root) await t.run('update chat_messages set reply_count = reply_count + 1, last_reply_at = $2 where id = $1', [root.id, at]);
      // Posting reads everything up to your own message.
      if (!root) await t.run('update chat_members set last_read_id = $3 where channel_id = $1 and member_id = $2 and (last_read_id is null or last_read_id < $3)', [c.id, me.id, id]);
      // A mentioned person on a public channel who is not a member is added, as Slack offers to do.
      for (const p of mentioned) if (!memberIds.has(p.id) && c.kind === 'public') {
        await t.run('insert into chat_members (channel_id, member_id, member_kind, role, last_read_id, joined_at) values ($1, $2, $3, $4, $5, $6) on conflict (channel_id, member_id) do nothing', [c.id, p.id, p.kind, 'member', null, at]);
      }
    });
    const [msg] = await this.hydrate(me, [await this.messageRow(id)]);
    const audience = await this.#audience(c);
    await this.bus.publish({ team: me.team_id, channel: c.id, type: 'message.posted', audience, data: { message: { ...msg, mine: undefined } } });
    if (root) {
      const r = await this.messageRow(root.id);
      await this.bus.publish({ team: me.team_id, channel: c.id, type: 'thread.updated', audience, data: { message: root.id, reply_count: num(r.reply_count), last_reply_at: r.last_reply_at } });
    }
    for (const fn of this.hooks.posted) {
      try { await fn({ me, channel: c, message: msg, root, mentioned, members: [...memberIds] }); } catch (e) { console.error('after post:', e.message); }
    }
    return msg;
  }

  async edit(me, { message, body }) {
    const m = await this.readableMessage(me, message);
    if (m.author_id !== me.id) fail('You can only edit your own messages.', 403);
    if (m.deleted_at) fail('That message was deleted.');
    body = String(body ?? '').trim();
    if (!body) fail('A message cannot be empty. To remove it, use chat.delete.');
    if (body.length > MAX_BODY) fail(`A message is at most ${MAX_BODY} characters.`);
    await this.db.run('update chat_messages set body = $2, edited_at = $3 where id = $1', [m.id, body, nowIso()]);
    const [msg] = await this.hydrate(me, [await this.messageRow(m.id)]);
    const c = await this.channelRow(me.team_id, m.channel_id);
    await this.bus.publish({ team: me.team_id, channel: c.id, type: 'message.edited', audience: await this.#audience(c), data: { message: { ...msg, mine: undefined } } });
    return msg;
  }

  async remove(me, { message }) {
    const m = await this.readableMessage(me, message);
    if (m.author_id !== me.id && !['owner', 'admin'].includes(me.role)) fail('You can only delete your own messages.', 403);
    if (m.deleted_at) return { message: m.id, deleted: true };
    await this.db.tx(async (t) => {
      // The words are wiped, not hidden. A thread's first message stays as "deleted" so its replies keep their place.
      await t.run(`update chat_messages set body = '', deleted_at = $2 where id = $1`, [m.id, nowIso()]);
      await t.run('delete from chat_reactions where message_id = $1', [m.id]);
      await t.run('delete from chat_mentions where message_id = $1', [m.id]);
      if (m.thread_root_id) await t.run('update chat_messages set reply_count = case when reply_count > 0 then reply_count - 1 else 0 end where id = $1', [m.thread_root_id]);
    });
    const c = await this.channelRow(me.team_id, m.channel_id);
    await this.bus.publish({ team: me.team_id, channel: c.id, type: 'message.deleted', audience: await this.#audience(c), data: { message: m.id, thread_root: m.thread_root_id ?? null, keep: num(m.reply_count) > 0 } });
    return { message: m.id, deleted: true };
  }

  async react(me, { message, emoji, remove = false }) {
    emoji = String(emoji ?? '').trim();
    if (!emoji || emoji.length > 32) fail('Give one emoji, like 👍 or :tada:.');
    const m = await this.readableMessage(me, message);
    if (m.deleted_at) fail('That message was deleted.');
    const c = await this.writable(me, m.channel_id);
    if (remove) await this.db.run('delete from chat_reactions where message_id = $1 and emoji = $2 and member_id = $3', [m.id, emoji, me.id]);
    else await this.db.run('insert into chat_reactions (message_id, emoji, member_id, created_at) values ($1, $2, $3, $4) on conflict do nothing', [m.id, emoji, me.id, nowIso()]);
    const [msg] = await this.hydrate(me, [m]);
    await this.bus.publish({ team: me.team_id, channel: c.id, type: 'reaction.changed', audience: await this.#audience(c), data: { message: m.id, reactions: msg.reactions.map((r) => ({ ...r, mine: undefined })) } });
    return { message: m.id, reactions: msg.reactions };
  }

  // ---------- reading state ----------

  async markRead(me, { channel, message = null }) {
    const c = await this.readable(me, channel);
    if (!(await this.member(c.id, me.id))) return { channel: c.id, last_read_id: null, unread: 0 };
    let upTo = message;
    if (!upTo) upTo = (await this.db.get('select max(id) as id from chat_messages where channel_id = $1 and thread_root_id is null', [c.id]))?.id ?? null;
    await this.db.run('update chat_members set last_read_id = $3 where channel_id = $1 and member_id = $2', [c.id, me.id, upTo]);
    return this.#readChanged(me, c, upTo);
  }

  // Mark unread from a message on: everything from it onwards counts as new again.
  async markUnread(me, { message }) {
    const m = await this.readableMessage(me, message);
    const c = await this.channelRow(me.team_id, m.channel_id);
    if (!(await this.member(c.id, me.id))) fail('Join the channel first.', 403);
    const rootId = m.thread_root_id ?? m.id;
    const prev = await this.db.get('select max(id) as id from chat_messages where channel_id = $1 and thread_root_id is null and id < $2', [c.id, rootId]);
    await this.db.run('update chat_members set last_read_id = $3 where channel_id = $1 and member_id = $2', [c.id, me.id, prev?.id ?? '']);
    return this.#readChanged(me, c, prev?.id ?? '');
  }

  async #readChanged(me, c, upTo) {
    const list = await this.listChannels(me);
    const s = list.find((x) => x.id === c.id);
    const data = { channel: c.id, last_read_id: upTo || null, unread: s?.unread ?? 0, mentions: s?.mentions ?? 0 };
    await this.bus.publish({ team: me.team_id, channel: c.id, type: 'read.changed', audience: [me.id], data });
    return data;
  }

  async setNotify(me, { channel = null, level }) {
    if (!['all', 'mentions', 'none', 'default'].includes(level)) fail('level is all, mentions, none or default.');
    if (!channel) {
      if (level === 'default') fail('The team-wide rule is all, mentions or none.');
      const prefs = await this.setPrefs(me, { notify: level });
      return { scope: 'default', level: prefs.notify };
    }
    const c = await this.readable(me, channel);
    if (!(await this.member(c.id, me.id))) fail('Join the channel first.', 403);
    await this.db.run('update chat_members set notify = $3 where channel_id = $1 and member_id = $2', [c.id, me.id, level]);
    return { scope: 'channel', channel: c.id, level };
  }

  // ---------- search and mentions ----------

  async search(me, { q, channel = null, from = null, limit = 20 }) {
    let text = String(q ?? '');
    // Slack-style filters inside the words: in:#channel from:@person
    text = text.replace(/\bin:#?([\w-]+)/i, (_, x) => { channel = channel ?? x; return ''; }).replace(/\bfrom:@?([\w.-]+)/i, (_, x) => { from = from ?? x; return ''; }).trim();
    limit = Math.min(Math.max(Number(limit) || 20, 1), 100);
    const params = [me.team_id, me.id];
    const where = [`m.team_id = $1`, `m.deleted_at is null`, `(c.kind = 'public' or exists (select 1 from chat_members y where y.channel_id = c.id and y.member_id = $2))`];
    if (channel) { const c = await this.readable(me, channel); params.push(c.id); where.push(`m.channel_id = $${params.length}`); }
    if (from) { const p = await this.mustFindPerson(me.team_id, from); params.push(p.id); where.push(`m.author_id = $${params.length}`); }
    let order = 'm.id desc';
    if (text) {
      if (this.db.dialect === 'pg') {
        params.push(text);
        where.push(`to_tsvector('simple', m.body) @@ websearch_to_tsquery('simple', $${params.length})`);
        order = `ts_rank(to_tsvector('simple', m.body), websearch_to_tsquery('simple', $${params.length})) desc, m.id desc`;
      } else {
        const terms = text.split(/\s+/).map((w) => w.replace(/["*^():]/g, '')).filter(Boolean);
        if (terms.length) {
          params.push(terms.map((w) => `"${w}"*`).join(' '));
          where.push(`m.rowid in (select rowid from chat_messages_fts where chat_messages_fts match $${params.length})`);
        }
      }
    }
    if (!text && !channel && !from) fail('Give some words to look for, or a channel or person.');
    const rows = await this.db.all(`select m.* from chat_messages m join chat_channels c on c.id = m.channel_id where ${where.join(' and ')} order by ${order} limit ${limit}`, params);
    const messages = await this.hydrate(me, rows);
    const names = new Map((await this.listChannels(me, { browse: true, include_archived: true })).map((c) => [c.id, c.name]));
    return { q: q ?? '', results: messages.map((m) => ({ ...m, channel_name: names.get(m.channel) ?? '' })) };
  }

  async mentions(me, { limit = 30 } = {}) {
    const rows = await this.db.all(`select m.* from chat_mentions mm join chat_messages m on m.id = mm.message_id where mm.member_id = $1 and m.deleted_at is null order by m.id desc limit ${Math.min(Number(limit) || 30, 100)}`, [me.id]);
    const messages = await this.hydrate(me, rows);
    const names = new Map((await this.listChannels(me, { browse: true, include_archived: true })).map((c) => [c.id, c.name]));
    return { results: messages.map((m) => ({ ...m, channel_name: names.get(m.channel) ?? '' })) };
  }

  // ---------- catch up ----------

  async events(me, { since = 0, limit = 200 }) {
    // No cursor yet: start from now.
    if (!Number(since)) return { events: [], cursor: Number((await this.db.get('select max(id) as id from chat_events where team_id = $1', [me.team_id]))?.id ?? 0) };
    const rows = await this.db.all('select * from chat_events where team_id = $1 and id > $2 order by id limit $3', [me.team_id, Number(since) || 0, Math.min(Number(limit) || 200, 500)]);
    const latest = rows.length ? Number(rows[rows.length - 1].id) : Number(since) || (await this.db.get('select max(id) as id from chat_events where team_id = $1', [me.team_id]))?.id || 0;
    const out = rows.map((r) => ({ id: Number(r.id), channel: r.channel_id, type: r.type, audience: JSON.parse(r.audience ?? '"team"'), data: JSON.parse(r.data), at: r.created_at }))
      .filter((e) => e.audience === 'team' || e.audience.includes(me.id))
      .map(({ audience, ...e }) => e);
    return { events: out, cursor: Number(latest) };
  }
}

export function personView(r) {
  if (!r) return null;
  const agent = r.kind === 'agent' ? parse(r.agent, {}) : null;
  return {
    id: r.id, kind: r.kind, handle: r.handle, name: r.name, role: r.role,
    email: r.email ?? null, github: r.github ?? null,
    status: r.status_text || r.status_emoji ? { text: r.status_text ?? '', emoji: r.status_emoji ?? '' } : null,
    about: r.about ?? null,
    agent: agent ? { model: agent.model ?? null, example: !!agent.example, description: agent.description ?? null } : undefined,
    active: !r.deactivated_at,
  };
}
