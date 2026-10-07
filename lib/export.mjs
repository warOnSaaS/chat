import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';

// Export everything as a zip laid out like a Slack workspace export, so people can move again:
//   users.json, channels.json (public), groups.json (private), dms.json, mpims.json, integration_logs.json,
//   one folder per conversation with one JSON file per day, and files/ with the files themselves
//   (Slack exports only link to files). wos/ holds every table row as it is, for a lossless move
//   between wOS servers.

const ts = (iso, id) => {
  // Slack timestamps are seconds with six decimals and must be unique per channel; the id's counter fills the last digits.
  const ms = Date.parse(iso);
  const tail = parseInt(String(id).slice(-8, -5), 36) % 1000;
  return `${Math.floor(ms / 1000)}.${String((ms % 1000) * 1000 + tail).padStart(6, '0')}`;
};
const sec = (iso) => (iso ? Math.floor(Date.parse(iso) / 1000) : 0);

export async function buildExport(chat, files, teamId) {
  const db = chat.db;
  const team = await db.get('select * from chat_teams where id = $1', [teamId]);
  const people = await db.all('select * from chat_people where team_id = $1 order by created_at', [teamId]);
  const channels = await db.all('select * from chat_channels where team_id = $1 order by created_at', [teamId]);
  const members = await db.all('select m.* from chat_members m join chat_channels c on c.id = m.channel_id where c.team_id = $1', [teamId]);
  const messages = await db.all('select * from chat_messages where team_id = $1 order by id', [teamId]);
  const reactions = await db.all('select r.* from chat_reactions r join chat_messages m on m.id = r.message_id where m.team_id = $1', [teamId]);
  const fileRows = await db.all('select id, team_id, uploader_id, name, type, size, storage, key, created_at from chat_files where team_id = $1', [teamId]);
  const attachments = await db.all('select a.* from chat_attachments a join chat_messages m on m.id = a.message_id where m.team_id = $1', [teamId]);
  const mentions = await db.all('select x.* from chat_mentions x join chat_messages m on m.id = x.message_id where m.team_id = $1', [teamId]);

  const out = {};
  const put = (p, v) => { out[p] = strToU8(JSON.stringify(v, null, 2)); };
  const byPerson = new Map(people.map((p) => [p.id, p]));
  const memberIds = (cid) => members.filter((m) => m.channel_id === cid).map((m) => m.member_id);

  put('users.json', people.map((p) => ({
    id: p.id, team_id: teamId, name: p.handle, real_name: p.name, deleted: !!p.deactivated_at, is_bot: p.kind === 'agent',
    is_admin: p.role === 'admin' || p.role === 'owner', is_owner: p.role === 'owner',
    profile: { real_name: p.name, display_name: p.handle, email: p.email ?? undefined, status_text: p.status_text ?? '', status_emoji: p.status_emoji ?? '' },
  })));
  const chan = (c) => ({ id: c.id, name: c.name, created: sec(c.created_at), creator: c.created_by, is_archived: !!c.archived_at, is_general: c.name === 'general', members: memberIds(c.id), topic: { value: c.topic ?? '', creator: '', last_set: 0 }, purpose: { value: '', creator: '', last_set: 0 } });
  put('channels.json', channels.filter((c) => c.kind === 'public').map(chan));
  put('groups.json', channels.filter((c) => c.kind === 'private').map(chan));
  put('dms.json', channels.filter((c) => c.kind === 'dm').map((c) => ({ id: c.id, created: sec(c.created_at), members: memberIds(c.id) })));
  put('mpims.json', channels.filter((c) => c.kind === 'group_dm').map((c) => ({ id: c.id, name: `mpdm-${memberIds(c.id).map((id) => byPerson.get(id)?.handle).join('--')}-1`, created: sec(c.created_at), members: memberIds(c.id) })));
  put('integration_logs.json', { logs: [] });

  const tsOf = new Map(messages.map((m) => [m.id, ts(m.created_at, m.id)]));
  for (const c of channels) {
    const folder = c.kind === 'public' || c.kind === 'private' ? c.name : c.id;
    const days = new Map();
    for (const m of messages.filter((x) => x.channel_id === c.id && !x.deleted_at)) {
      const replies = messages.filter((x) => x.thread_root_id === m.id && !x.deleted_at);
      const rx = new Map();
      for (const r of reactions.filter((x) => x.message_id === m.id)) {
        const g = rx.get(r.emoji) ?? { name: r.emoji, users: [], count: 0 };
        g.users.push(r.member_id); g.count++; rx.set(r.emoji, g);
      }
      const att = attachments.filter((a) => a.message_id === m.id).map((a) => fileRows.find((f) => f.id === a.file_id)).filter(Boolean);
      const author = byPerson.get(m.author_id);
      const item = {
        type: 'message', user: m.author_id, text: m.body, ts: tsOf.get(m.id),
        ...(author?.kind === 'agent' ? { subtype: 'bot_message', bot_id: m.author_id, username: author.name } : {}),
        user_profile: author ? { real_name: author.name, display_name: author.handle, name: author.handle } : undefined,
        ...(m.thread_root_id ? { thread_ts: tsOf.get(m.thread_root_id), parent_user_id: messages.find((x) => x.id === m.thread_root_id)?.author_id } : {}),
        ...(replies.length ? { thread_ts: tsOf.get(m.id), reply_count: replies.length, reply_users: [...new Set(replies.map((r) => r.author_id))], latest_reply: tsOf.get(replies[replies.length - 1].id), replies: replies.map((r) => ({ user: r.author_id, ts: tsOf.get(r.id) })) } : {}),
        ...(m.edited_at ? { edited: { user: m.author_id, ts: String(sec(m.edited_at)) } } : {}),
        ...(rx.size ? { reactions: [...rx.values()] } : {}),
        ...(att.length ? { files: att.map((f) => ({ id: f.id, name: f.name, title: f.name, mimetype: f.type, size: Number(f.size), url_private: `files/${f.id}/${f.name}` })) } : {}),
      };
      const day = m.created_at.slice(0, 10);
      if (!days.has(day)) days.set(day, []);
      days.get(day).push(item);
    }
    for (const [day, list] of days) put(`${folder}/${day}.json`, list);
  }

  for (const f of fileRows) {
    try { out[`files/${f.id}/${f.name}`] = new Uint8Array(await files.read(f)); } catch { /* a missing file is listed but not copied */ }
  }
  put('wos/team.json', team);
  put('wos/people.json', people.map(({ prefs, ...p }) => p));
  put('wos/channels.json', channels);
  put('wos/members.json', members);
  put('wos/messages.json', messages);
  put('wos/reactions.json', reactions);
  put('wos/attachments.json', attachments);
  put('wos/mentions.json', mentions);
  put('wos/files.json', fileRows);
  put('wos/README.json', { format: 'wOS Chat export', version: 1, exported_at: new Date().toISOString(), note: 'The top level follows the Slack export layout. wos/ holds every row as stored.' });
  const zip = zipSync(out, { level: 6 });
  return { zip: Buffer.from(zip), counts: { people: people.length, channels: channels.length, messages: messages.length, files: fileRows.length } };
}

// ---------- Slack import (v1): the interface, and a preview that reads an export ----------
// The import itself lands in v1 (ROADMAP 5.3). What is fixed now is the shape an importer returns,
// so the import wizard, the tool and tests can be built against it.
//
// SlackImport = {
//   people:   [{ slack_id, handle, name, email?, bot }],
//   channels: [{ slack_id, name?, kind: 'public'|'private'|'dm'|'group_dm', topic?, members: [slack_id], archived }],
//   messages: [{ slack_ts, channel_slack_id, user_slack_id, text, thread_ts?, reactions: [{ emoji, users }], files: [{ name, url }] }],
//   warnings: [string],
// }
export function readSlackExport(buffer) {
  let entries;
  try { entries = unzipSync(new Uint8Array(buffer)); } catch { throw new Error('That is not a zip file. Slack exports come as a .zip.'); }
  const json = (p) => { try { return entries[p] ? JSON.parse(strFromU8(entries[p])) : null; } catch { return null; } };
  const users = json('users.json') ?? [];
  const lists = { public: json('channels.json') ?? [], private: json('groups.json') ?? [], dm: json('dms.json') ?? [], group_dm: json('mpims.json') ?? [] };
  if (!users.length && !lists.public.length) throw new Error('No users.json or channels.json in that zip. Is it a Slack export?');
  const warnings = [];
  if (!lists.private.length && !lists.dm.length) warnings.push('No private channels or direct messages: Slack leaves those out of exports on Free and Pro plans.');
  const people = users.map((u) => ({ slack_id: u.id, handle: u.name, name: u.real_name || u.profile?.real_name || u.name, email: u.profile?.email, bot: !!u.is_bot }));
  const channels = Object.entries(lists).flatMap(([kind, xs]) => xs.map((c) => ({ slack_id: c.id, name: c.name, kind, topic: c.topic?.value, members: c.members ?? [], archived: !!c.is_archived })));
  const messages = [];
  for (const c of channels) {
    const folder = c.name ?? c.slack_id;
    for (const p of Object.keys(entries).filter((k) => k.startsWith(`${folder}/`) && k.endsWith('.json'))) {
      for (const m of json(p) ?? []) {
        if (m.type !== 'message') continue;
        messages.push({ slack_ts: m.ts, channel_slack_id: c.slack_id, user_slack_id: m.user ?? m.bot_id, text: m.text ?? '', thread_ts: m.thread_ts !== m.ts ? m.thread_ts : undefined, reactions: (m.reactions ?? []).map((r) => ({ emoji: r.name, users: r.users ?? [] })), files: (m.files ?? []).map((f) => ({ name: f.name, url: f.url_private })) });
      }
    }
  }
  if (messages.some((m) => m.files.length)) warnings.push('Files come as links in Slack exports, and Slack only keeps those links working for a while.');
  return { people, channels, messages, warnings };
}
