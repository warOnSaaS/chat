import { openDb, migrate } from './db.mjs';
import { Bus } from './bus.mjs';
import { Chat } from './chat.mjs';
import { Files } from './files.mjs';
import { Push, whoToNotify } from './push.mjs';
import { Agents } from './agents.mjs';
import { listTools, runTool } from './tools.mjs';
import { nowIso } from './ids.mjs';
import { WosAccount, authProvider } from './account-client.mjs';

// Everything the server needs, wired once: the database (migrated on start), live events, the chat,
// files, push and agents. server.mjs serves it; tests make their own with an in-memory database.
export async function createApp(env = process.env) {
  const db = await openDb({ url: env.DATABASE_URL, file: env.SQLITE_FILE });
  const applied = await migrate(db);
  if (applied.length) console.log(`chat: database updated (${applied.join(', ')})`);
  const bus = new Bus(db);
  await bus.start();
  const chat = new Chat({ db, bus });
  const files = new Files(db, env);
  const push = await new Push(db, env).start();
  // How people sign in. AUTH_PROVIDER=waronsaas (the hosted copy: the warOnSaaS account, open sign-up, each
  // account in its own workspace or team), github (GitHub plus an email link) or local (the email link alone).
  const auth = authProvider(env);
  const account = auth === 'waronsaas' ? WosAccount.fromEnv(env, { redirectUri: `${(env.PUBLIC_URL || 'https://chat.waronsaas.com').replace(/\/$/, '')}/auth/waronsaas/callback`, secret: env.OAUTH_SECRET || env.SESSION_SECRET }) : null;
  if (auth === 'waronsaas' && !account) throw new Error('AUTH_PROVIDER=waronsaas needs WOS_ACCOUNT_CLIENT_ID and WOS_ACCOUNT_CLIENT_SECRET');
  const app = {
    env, db, bus, chat, files, push, auth, account,
    // The full demo (no sign-in, switch who you are) is for self-hosted tries. The hosted copy shows the same
    // example team to signed-out visitors, read-only, with sign-in a press away.
    demo: env.CHAT_DEMO === '1' && auth !== 'waronsaas',
    teamId: env.CHAT_TEAM_ID || 'default',
    teamName: env.CHAT_TEAM_NAME || 'Team chat',
  };
  app.agents = new Agents({ chat, env, tools: { list: listTools, run: (me, name, input, o) => runTool(app, me, name, input, o) } });
  app.run = (me, name, input, o) => runTool(app, me, name, input, o);

  // Notifications: an in-app event for open screens, and Web Push for devices, by each person's rules.
  chat.onPosted(async (ctx) => {
    const who = await whoToNotify(chat, ctx);
    const where = ctx.channel.kind === 'dm' || ctx.channel.kind === 'group_dm' ? ctx.message.author.name : `#${ctx.channel.name}`;
    const text = ctx.message.body.replace(/\s+/g, ' ').slice(0, 140) || (ctx.message.files.length ? 'Sent a file' : '');
    const url = `/#/c/${ctx.channel.id}${ctx.message.thread_root ? `/t/${ctx.message.thread_root}` : ''}`;
    for (const p of who) {
      const payload = { title: ctx.channel.kind === 'dm' ? ctx.message.author.name : `${ctx.message.author.name} in ${where}`, body: text, url, tag: ctx.channel.id, why: p.why };
      await bus.publish({ team: ctx.me.team_id, channel: ctx.channel.id, type: 'chat.notification.sent', audience: [p.id], data: payload, ephemeral: true });
      if (p.push && ['dm', 'mention', 'thread', 'keyword', 'all'].includes(p.why)) await push.send(p.id, payload);
    }
  });

  // The hosted copy makes a workspace per account or team as people sign in, so it has no one default team.
  if (!app.demo && auth !== 'waronsaas') await ensureTeamSetup(app);
  app.close = async () => { await bus.stop(); await db.close(); };
  return app;
}

// A new server has one team with #general and #random. The first person to sign in becomes its owner.
export async function ensureTeamSetup(app, teamId = app.teamId, name = app.teamName) {
  await app.chat.ensureTeam(teamId, name);
  for (const [n, topic] of [['general', 'Team-wide news'], ['random', 'Everything else']]) {
    await app.db.run(`insert into chat_channels (id, team_id, name, kind, topic, created_by, created_at) values ($1, $2, $3, 'public', $4, 'system', $5) on conflict do nothing`, [`c_${teamId}_${n}`, teamId, n, topic, nowIso()]);
  }
}
