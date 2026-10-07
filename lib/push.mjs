import webpush from 'web-push';
import { nowIso } from './ids.mjs';

// Web Push for mentions and direct messages. The server makes its own key pair (VAPID) the first time it
// starts and keeps it in the database, so every copy of the server uses the same one. No push relay:
// the browser's own push service delivers it, and it works with no tab open once the app is installed.
export class Push {
  constructor(db, env = process.env) {
    this.db = db;
    this.env = env;
    this.subject = env.CHAT_PUSH_CONTACT || 'mailto:admin@chat.example';
    this.sent = [];
  }

  async start() {
    let row = await this.db.get(`select value from chat_settings where key = 'vapid'`);
    if (!row) {
      const keys = webpush.generateVAPIDKeys();
      await this.db.run(`insert into chat_settings (key, value) values ('vapid', $1) on conflict (key) do nothing`, [JSON.stringify(keys)]);
      row = await this.db.get(`select value from chat_settings where key = 'vapid'`);
    }
    this.keys = JSON.parse(row.value);
    return this;
  }

  get publicKey() { return this.keys?.publicKey ?? null; }

  async subscribe(me, sub) {
    if (!sub?.endpoint || !/^https:\/\//.test(sub.endpoint) || !sub.keys?.p256dh || !sub.keys?.auth) throw new Error('That is not a browser push subscription.');
    await this.db.run(`insert into chat_push_subs (endpoint, person_id, team_id, keys, created_at) values ($1, $2, $3, $4, $5)
      on conflict (endpoint) do update set person_id = $2, team_id = $3, keys = $4`, [sub.endpoint, me.id, me.team_id, JSON.stringify(sub.keys), nowIso()]);
    return { subscribed: true, devices: await this.count(me) };
  }

  async unsubscribe(me, endpoint) {
    if (endpoint) await this.db.run('delete from chat_push_subs where endpoint = $1 and person_id = $2', [endpoint, me.id]);
    else await this.db.run('delete from chat_push_subs where person_id = $1', [me.id]);
    return { subscribed: false, devices: await this.count(me) };
  }

  async count(me) { return Number((await this.db.get('select count(*) as n from chat_push_subs where person_id = $1', [me.id]))?.n ?? 0); }

  async send(personId, payload) {
    const subs = await this.db.all('select * from chat_push_subs where person_id = $1', [personId]);
    for (const s of subs) {
      const sub = { endpoint: s.endpoint, keys: JSON.parse(s.keys) };
      if (this.env.CHAT_PUSH_DRY === '1') { this.sent.push({ personId, endpoint: s.endpoint, payload }); continue; }
      try {
        await webpush.sendNotification(sub, JSON.stringify(payload), { vapidDetails: { subject: this.subject, publicKey: this.keys.publicKey, privateKey: this.keys.privateKey }, TTL: 3600, urgency: 'high' });
      } catch (e) {
        // Gone or not found: the browser threw the subscription away.
        if (e.statusCode === 404 || e.statusCode === 410) await this.db.run('delete from chat_push_subs where endpoint = $1', [s.endpoint]);
        else console.error('push:', e.statusCode ?? e.message);
      }
    }
  }
}

// Who hears about a new message, by the notification rules:
// - each channel: all, mentions, none, or default (follow the person's own rule, mentions unless changed)
// - direct and group messages count as mentions
// - replies tell the people already in that thread
// - keywords: words a person wants to hear about anywhere they are a member
export async function whoToNotify(chat, { me, channel, message, root, mentioned }) {
  const members = await chat.db.all(`select m.member_id, m.notify, p.prefs, p.kind from chat_members m join chat_people p on p.id = m.member_id
    where m.channel_id = $1 and p.deactivated_at is null and p.kind = 'person' and m.member_id <> $2`, [channel.id, me.id]);
  const mentionedIds = new Set(mentioned.map((p) => p.id));
  let inThread = new Set();
  if (root) {
    const rows = await chat.db.all('select distinct author_id from chat_messages where (id = $1 or thread_root_id = $1) and deleted_at is null', [root.id]);
    inThread = new Set(rows.map((r) => r.author_id));
  }
  const dm = channel.kind === 'dm' || channel.kind === 'group_dm';
  const words = String(message.body ?? '').toLowerCase();
  const out = [];
  for (const m of members) {
    let prefs = {};
    try { prefs = JSON.parse(m.prefs ?? '{}') ?? {}; } catch {}
    const level = m.notify && m.notify !== 'default' ? m.notify : prefs.notify ?? 'mentions';
    if (level === 'none') continue;
    const keyword = (prefs.keywords ?? []).find((k) => k && words.includes(String(k).toLowerCase()));
    const why = dm ? 'dm' : mentionedIds.has(m.member_id) ? 'mention' : inThread.has(m.member_id) ? 'thread' : keyword ? 'keyword' : level === 'all' ? 'all' : null;
    if (why) out.push({ id: m.member_id, why, push: prefs.push !== false });
  }
  return out;
}
