import crypto from 'node:crypto';
import { idAt, newId, nowIso } from './ids.mjs';
import { mentionedHandles } from './markdown.mjs';

// The demo: a fictional dental practice, Acme Dental, with four people and one example agent.
// Every visitor gets their own copy (a team of their own), so nobody sees anyone else's messages.
// Copies older than a day are cleared out when a new one is made.

export const DEMO_PEOPLE = [
  { handle: 'sam', name: 'Sam Rivera', role: 'owner', email: 'sam@acme-dental.example', status: ['On the floor till 2', '🦷'] },
  { handle: 'jordan', name: 'Jordan Lee', role: 'admin', email: 'jordan@acme-dental.example', status: ['', ''] },
  { handle: 'casey', name: 'Casey Morgan', role: 'member', email: 'casey@acme-dental.example', status: ['Front desk', '📞'] },
  { handle: 'riley', name: 'Riley Chen', role: 'member', email: 'riley@acme-dental.example', status: ['', ''] },
];
export const DEMO_AGENT = { handle: 'scout', name: 'Scout', description: 'an example agent with fixed answers' };

// [channel, minutes ago, author, body, { thread: index of the thread's first message in this list, reactions }]
const SCRIPT = [
  ['general', 2900, 'sam', 'Welcome to the new chat, everyone. Same channels as before: #front-desk for the day, #marketing for the spring push. @scout is an example agent: mention it in a thread and it answers there.', { react: { '👋': ['jordan', 'casey', 'riley'] } }],
  ['general', 2880, 'jordan', 'Looks good. Is the old group text going away?', {}],
  ['general', 2875, 'sam', 'Yes, from Monday everything lives here.', { thread: 1 }],
  ['general', 2860, 'casey', 'Can I get it on my phone?', { thread: 1 }],
  ['general', 2855, 'sam', 'Open it in the browser and add it to your home screen. Mentions come through as notifications.', { thread: 1, react: { '🙌': ['casey'] } }],
  ['front-desk', 1500, 'casey', 'Mrs. Patel moved her cleaning to Thursday 10:30. Chair 2 is open at 9 now.', {}],
  ['front-desk', 1490, 'riley', 'I can put the Birch Law referral in the 9.', { thread: 5 }],
  ['front-desk', 1480, 'casey', 'Perfect, booked.', { thread: 5, react: { '✅': ['riley'] } }],
  ['front-desk', 300, 'riley', 'The card reader at desk 1 keeps dropping. Using desk 2 for payments today.', { react: { '👀': ['sam'] } }],
  ['front-desk', 240, 'casey', '@sam can you call the reader company? Their number is on the back of the unit.', {}],
  ['front-desk', 230, 'riley', 'We also need to order more appointment cards by Friday.', {}],
  ['marketing', 2000, 'jordan', 'Draft for the spring whitening offer:\n\n**20% off whitening with any cleaning, March to May.**\n\nThoughts?', { react: { '🔥': ['sam', 'riley'] } }],
  ['marketing', 1990, 'riley', 'Love it. Can we add the online booking link?', { thread: 11 }],
  ['marketing', 1985, 'jordan', 'Yes, adding it now.', { thread: 11 }],
  ['marketing', 1700, 'sam', 'Postcards go to print on the 14th. @jordan please send the final copy by Wednesday.', { thread: 11 }],
  ['marketing', 1690, 'jordan', 'Will do.', { thread: 11 }],
  ['marketing', 120, 'jordan', 'Final copy is in. Printer confirmed the 14th.', {}],
  ['marketing', 60, 'riley', 'Nice. I will post it on the practice page once they arrive.', {}],
  ['leadership', 3000, 'sam', 'Q2 hiring: one more hygienist. Budget is approved.', {}],
  ['leadership', 2990, 'jordan', 'I will post the role this week.', { thread: 18 }],
  ['dm:jordan', 200, 'jordan', 'Do you have five minutes after lunch for the schedule?', {}],
];

export async function seedDemo(app, { teamId = `demo_${crypto.randomBytes(6).toString('hex')}` } = {}) {
  const { db, chat } = app;
  await purgeOldDemos(db);
  await chat.ensureTeam(teamId, 'Acme Dental', { demo: true });
  const now = Date.now();
  const at = (minAgo) => now - minAgo * 60000;
  const people = {};
  for (const p of DEMO_PEOPLE) {
    const id = newId('p');
    await db.run(`insert into chat_people (id, team_id, kind, handle, name, email, role, status_text, status_emoji, created_at) values ($1, $2, 'person', $3, $4, $5, $6, $7, $8, $9)`,
      [id, teamId, p.handle, p.name, p.email, p.role, p.status[0] || null, p.status[1] || null, new Date(at(4000)).toISOString()]);
    people[p.handle] = id;
  }
  const agentId = newId('a');
  await db.run(`insert into chat_people (id, team_id, kind, handle, name, role, about, agent, created_at) values ($1, $2, 'agent', $3, $4, 'member', $5, $6, $7)`,
    [agentId, teamId, DEMO_AGENT.handle, DEMO_AGENT.name, 'Example agent: fixed answers, no AI model.', JSON.stringify({ example: true, description: DEMO_AGENT.description }), new Date(at(4000)).toISOString()]);
  people.scout = agentId;

  const channels = {};
  const mk = async (name, kind, topic, members, dmKey = null) => {
    const id = idAt(kind === 'dm' ? 'd' : 'c', at(4000));
    await db.run('insert into chat_channels (id, team_id, name, kind, topic, created_by, created_at, dm_key) values ($1, $2, $3, $4, $5, $6, $7, $8)', [id, teamId, name, kind, topic, people.sam, new Date(at(4000)).toISOString(), dmKey]);
    for (const h of members) await db.run('insert into chat_members (channel_id, member_id, member_kind, role, last_read_id, joined_at) values ($1, $2, $3, $4, $5, $6)', [id, people[h], h === 'scout' ? 'agent' : 'person', h === 'sam' ? 'admin' : 'member', null, new Date(at(4000)).toISOString()]);
    return id;
  };
  const everyone = ['sam', 'jordan', 'casey', 'riley'];
  channels.general = await mk('general', 'public', 'Practice-wide news', [...everyone, 'scout']);
  channels.random = await mk('random', 'public', 'Lunch, pets, everything else', everyone);
  channels['front-desk'] = await mk('front-desk', 'public', 'Today at the desk: bookings, payments, walk-ins', ['sam', 'casey', 'riley', 'scout']);
  channels.marketing = await mk('marketing', 'public', 'Spring whitening offer', ['sam', 'jordan', 'riley', 'scout']);
  channels.leadership = await mk('leadership', 'private', 'Hiring and budget', ['sam', 'jordan']);
  channels['dm:jordan'] = await mk(null, 'dm', null, ['sam', 'jordan'], [people.sam, people.jordan].sort().join(','));
  channels['dm:scout'] = await mk(null, 'dm', null, ['sam', 'scout'], [people.sam, people.scout].sort().join(','));

  const ids = [];
  for (const [ch, ago, who, body, opts] of SCRIPT) {
    const id = idAt('m', at(ago));
    const root = opts.thread !== undefined ? ids[opts.thread] : null;
    const created = new Date(at(ago)).toISOString();
    await db.run('insert into chat_messages (id, team_id, channel_id, thread_root_id, author_id, author_kind, body, created_at) values ($1, $2, $3, $4, $5, $6, $7, $8)',
      [id, teamId, channels[ch], root, people[who], 'person', body, created]);
    if (root) await db.run('update chat_messages set reply_count = reply_count + 1, last_reply_at = $2 where id = $1', [root, created]);
    for (const h of mentionedHandles(body)) if (people[h] && h !== who) await db.run('insert into chat_mentions (message_id, member_id) values ($1, $2) on conflict do nothing', [id, people[h]]);
    for (const [emoji, hs] of Object.entries(opts.react ?? {})) for (const h of hs) await db.run('insert into chat_reactions (message_id, emoji, member_id, created_at) values ($1, $2, $3, $4)', [id, emoji, people[h], created]);
    ids.push(id);
  }
  // Sam has read most things: #front-desk has two new messages (one mentions Sam), #marketing two, Jordan's DM one.
  const lastBefore = async (ch, minutes) => (await db.get('select max(id) as id from chat_messages where channel_id = $1 and thread_root_id is null and created_at < $2', [channels[ch], new Date(at(minutes)).toISOString()]))?.id ?? null;
  for (const ch of Object.keys(channels)) {
    const upTo = ch === 'front-desk' ? await lastBefore(ch, 250) : ch === 'marketing' ? await lastBefore(ch, 130) : ch === 'dm:jordan' ? null : await lastBefore(ch, 0);
    for (const h of everyone) await db.run('update chat_members set last_read_id = $3 where channel_id = $1 and member_id = $2', [channels[ch], people[h], h === 'sam' ? upTo : await lastBefore(ch, 0)]);
  }
  return { teamId, people, channels };
}

async function purgeOldDemos(db) {
  const old = await db.all('select id from chat_teams where demo = 1 and created_at < $1', [new Date(Date.now() - 24 * 3600e3).toISOString()]);
  for (const { id } of old) {
    for (const t of ['chat_reactions', 'chat_attachments', 'chat_mentions']) await db.run(`delete from ${t} where message_id in (select id from chat_messages where team_id = $1)`, [id]);
    await db.run('delete from chat_members where channel_id in (select id from chat_channels where team_id = $1)', [id]);
    for (const t of ['chat_messages', 'chat_channels', 'chat_people', 'chat_files', 'chat_events', 'chat_push_subs', 'chat_approvals']) await db.run(`delete from ${t} where team_id = $1`, [id]);
    await db.run('delete from chat_teams where id = $1', [id]);
  }
}

export const demoNow = nowIso;
