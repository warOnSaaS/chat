import path from 'node:path';
import { Bus } from './bus.mjs';
import { Chat } from './chat.mjs';
import { Files } from './files.mjs';
import { Push, whoToNotify } from './push.mjs';
import { Agents } from './agents.mjs';
import { listTools, runTool } from './tools.mjs';
import { ensureTeamSetup } from './app.mjs';
import { uploadStream, downloadStream } from './filestreams.mjs';
import { json } from './auth.mjs';

// Chat inside the wOS suite (warOnSaaS/suite CONTRACTS.md). The suite calls register(ctx) once, runs
// migrations/ itself, checks sign-in, team, scope and input before any handler, gates confirm: human tools,
// and serves /api/tools/<name> and /mcp from these handlers. The chat code is the same as standalone;
// this file only translates the suite's ctx and call into it.

// The suite's db speaks ? placeholders; the chat code writes $1, $2. Convert, repeating values used twice.
export function fromSuiteDb(sdb) {
  const conv = (sql, params = []) => {
    const out = [];
    const text = sql.replace(/\$(\d+)/g, (_, n) => { out.push(params[Number(n) - 1]); return '?'; });
    return [text, /\$\d/.test(sql) ? out : params];
  };
  const wrap = (q) => ({
    dialect: sdb.dialect === 'postgres' ? 'pg' : 'sqlite',
    async all(sql, params) { const [t, p] = conv(sql, params); return q.query(t, p); },
    async get(sql, params) { const [t, p] = conv(sql, params); return (await q.get(t, p)) ?? null; },
    async run(sql, params) {
      const [t, p] = conv(sql, params);
      if (/\breturning\b/i.test(t)) { const rows = await q.query(t, p); return { changes: rows.length, rows }; }
      const r = await q.run(t, p);
      return { changes: r?.changes ?? 0, rows: [] };
    },
  });
  return {
    ...wrap(sdb),
    kind: sdb.dialect === 'postgres' ? 'postgres' : 'sqlite',
    tx: (fn) => sdb.tx((t) => fn(wrap(t))),
    // The suite carries events between server copies; the chat's own NOTIFY is not needed.
    async notify() {}, async listen() { return async () => {}; }, async close() {},
  };
}

// The suite's live socket sends an event to everyone on the team. Events only some people may see
// (private channels, direct messages, read markers) go out as a bare reference; screens then fetch them
// with chat.list_events, which checks who may see what.
class SuiteBus extends Bus {
  constructor(db, events) { super(db); this.suiteEvents = events; }
  async start() {}
  async publish(e) {
    const out = await super.publish(e);
    const open = e.audience === 'team';
    this.suiteEvents?.publish(e.team, e.type, open ? { ...e.data, event_id: out.id, channel: e.channel } : { ref: out.id, channel: e.channel });
    return out;
  }
}

export async function register(ctx) {
  const env = (name) => ctx.env?.(name) ?? undefined;
  const envObj = new Proxy({}, { get: (_, k) => (typeof k === 'string' ? env(k) : undefined) });
  const db = fromSuiteDb(ctx.db);
  const bus = new SuiteBus(db, ctx.events);
  const chat = new Chat({ db, bus });
  const files = new Files(db, { ...Object.fromEntries(['FILES_STORAGE', 'FILES_MAX_MB', 'S3_BUCKET', 'S3_ENDPOINT', 'S3_REGION', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'].map((k) => [k, env(k)]).filter(([, v]) => v)), FILES_DIR: env('FILES_DIR') ?? path.join(ctx.dataDir ?? 'data', 'files') });
  const push = await new Push(db, envObj).start();
  const app = { env: envObj, db, bus, chat, files, push, demo: false, suite: true };
  app.agents = new Agents({ chat, env: envObj, tools: { list: listTools, run: (me, name, input, o) => runTool(app, me, name, input, o) } });
  chat.onPosted(async (c) => {
    for (const p of await whoToNotify(chat, c)) {
      const payload = { title: `${c.message.author.name}${c.channel.kind === 'dm' ? '' : ` in #${c.channel.name ?? 'a group message'}`}`, body: c.message.body.slice(0, 140), url: `/chat/c/${c.channel.id}`, tag: c.channel.id, why: p.why };
      await bus.publish({ team: c.me.team_id, channel: c.channel.id, type: 'chat.notification.sent', audience: [p.id], data: payload, ephemeral: true });
      if (p.push) await push.send(p.id, payload);
    }
  });

  // Team members come from the suite (team.get), so @mentions work for people who have not opened Chat yet.
  const synced = new Map();
  async function addMember(teamId, { id, name, email, github, role }) {
    const base = String(github || String(name || email || 'someone').split(/[\s@]/)[0]).toLowerCase().replace(/[^a-z0-9._-]/g, '') || 'someone';
    let handle = base;
    for (let i = 2; await db.get('select id from chat_people where team_id = $1 and handle = $2', [teamId, handle]); i++) handle = `${base}${i}`;
    const at = new Date().toISOString();
    await db.run(`insert into chat_people (id, team_id, kind, handle, name, email, github, role, created_at) values ($1, $2, 'person', $3, $4, $5, $6, $7, $8) on conflict (id) do nothing`, [id, teamId, handle, name || handle, email ?? null, github ?? null, role, at]);
    const defaults = await db.all(`select id from chat_channels where team_id = $1 and kind = 'public' and name in ('general', 'random')`, [teamId]);
    for (const c of defaults) await db.run(`insert into chat_members (team_id, channel_id, member_id, member_kind, role, joined_at) values ($1, $2, $3, 'person', 'member', $4) on conflict (channel_id, member_id) do nothing`, [teamId, c.id, id, at]);
  }
  async function syncTeam(call) {
    const team = call.team;
    if (Date.now() - (synced.get(team.id) ?? 0) < 60000) return;
    synced.set(team.id, Date.now());
    await ensureTeamSetup(app, team.id, team.name);
    let members = [];
    try { members = (await call.callTool('team.get', {}))?.members ?? []; } catch { /* core tool missing: members join as they arrive */ }
    for (const m of members) {
      const role = ['owner', 'admin'].includes(m.role) ? (m.role === 'owner' ? 'owner' : 'admin') : m.role === 'guest' ? 'guest' : 'member';
      if (!(await chat.personRow(m.id))) await addMember(team.id, { id: m.id, name: m.name, email: m.email, github: m.github_login, role });
      else await db.run(`update chat_people set role = $2, deactivated_at = null where id = $1 and kind = 'person'`, [m.id, role]);
    }
  }
  // The suite's person (or the person an agent works for) as a chat member.
  async function personFor(call) {
    await syncTeam(call);
    const id = call.actor.kind === 'agent' && call.actor.personId ? call.actor.personId : call.actor.id;
    if (!(await chat.personRow(id))) await addMember(call.team.id, { id, name: call.actor.name, role: call.scopes.includes('admin') ? 'admin' : 'member' });
    return chat.personRow(id);
  }

  const VIA = { screen: 'web', rest: 'rest', mcp: 'mcp', agent: 'agent', email: 'rest', system: 'rest' };
  const handlers = {};
  for (const t of listTools()) {
    // The suite asked for the person's yes before calling a confirm: human tool, so it runs straight away.
    handlers[t.name] = async (input, call) => runTool(app, await personFor(call), t.name, input ?? {}, { via: VIA[call.via] ?? 'rest', scopes: call.scopes, approved: true, client: call.actor.kind === 'agent' ? call.actor.name : null });
  }

  return {
    handlers,
    async routes(req, res, url, call) {
      if (!url.pathname.startsWith('/files/chat')) return false;
      if (!call) { json(res, 401, { error: { code: 'sign_in', message: 'Sign in first.' } }); return true; }
      const me = await personFor(call);
      if (req.method === 'POST' && url.pathname === '/files/chat') await uploadStream(app, me, req, res, url);
      else await downloadStream(app, me, res, url.pathname);
      return true;
    },
    async exportTeam(team) {
      const rows = (sql) => db.all(sql, [team.id]);
      return {
        people: await rows('select * from chat_people where team_id = $1'),
        channels: await rows('select * from chat_channels where team_id = $1'),
        members: await rows('select * from chat_members where team_id = $1'),
        messages: await rows('select * from chat_messages where team_id = $1 order by id'),
        reactions: await rows('select * from chat_reactions where team_id = $1'),
        attachments: await rows('select * from chat_attachments where team_id = $1'),
        mentions: await rows('select * from chat_mentions where team_id = $1'),
        files: await rows('select id, team_id, uploader_id, name, type, size, storage, key, created_at from chat_files where team_id = $1'),
      };
    },
    stop: () => bus.stop(),
  };
}
