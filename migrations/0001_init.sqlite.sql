-- wOS Chat tables (SQLite). Every table starts with chat_ and has team_id, per the suite contract,
-- so the app can share a database with other wOS apps. Ids, times and JSON are text.
create table if not exists chat_teams (id text primary key, name text not null, demo integer not null default 0, created_at text not null);
create table if not exists chat_people (
  id text primary key, team_id text not null, kind text not null default 'person', handle text not null, name text not null,
  email text, github text, role text not null default 'member', status_text text, status_emoji text, about text,
  agent text, prefs text, created_at text not null, deactivated_at text);
create unique index if not exists chat_people_handle on chat_people (team_id, handle);
create table if not exists chat_channels (
  id text primary key, team_id text not null, name text, kind text not null, topic text, created_by text,
  created_at text not null, archived_at text, dm_key text);
create unique index if not exists chat_channels_name on chat_channels (team_id, name) where kind in ('public', 'private');
create unique index if not exists chat_channels_dm on chat_channels (team_id, dm_key) where dm_key is not null;
create table if not exists chat_members (
  team_id text not null, channel_id text not null, member_id text not null, member_kind text not null default 'person', role text not null default 'member',
  last_read_id text, notify text not null default 'default', joined_at text not null, primary key (channel_id, member_id));
create index if not exists chat_members_member on chat_members (member_id);
create table if not exists chat_messages (
  id text primary key, team_id text not null, channel_id text not null, thread_root_id text, author_id text not null,
  author_kind text not null default 'person', body text not null, edited_at text, deleted_at text, created_at text not null,
  reply_count integer not null default 0, last_reply_at text, meta text);
create index if not exists chat_messages_channel on chat_messages (channel_id, id);
create index if not exists chat_messages_thread on chat_messages (thread_root_id, id);
create table if not exists chat_reactions (team_id text not null, message_id text not null, emoji text not null, member_id text not null, created_at text not null, primary key (message_id, emoji, member_id));
create table if not exists chat_files (
  id text primary key, team_id text not null, uploader_id text not null, name text not null, type text not null, size integer not null,
  storage text not null, key text, data blob, created_at text not null);
create table if not exists chat_attachments (team_id text not null, message_id text not null, file_id text not null, primary key (message_id, file_id));
create table if not exists chat_mentions (team_id text not null, message_id text not null, member_id text not null, primary key (message_id, member_id));
create index if not exists chat_mentions_member on chat_mentions (member_id);
create table if not exists chat_events (id integer primary key autoincrement, team_id text not null, channel_id text, type text not null, audience text, data text not null, created_at text not null);
create index if not exists chat_events_team on chat_events (team_id, id);
create table if not exists chat_push_subs (endpoint text primary key, person_id text not null, team_id text not null, keys text not null, created_at text not null);
create table if not exists chat_settings (team_id text not null, key text not null, value text not null, primary key (team_id, key));
create table if not exists chat_approvals (
  id text primary key, team_id text not null, person_id text not null, requested_by text not null, tool text not null, input text not null,
  status text not null default 'waiting', result text, created_at text not null, decided_at text);
-- Search index. Kept up to date by the app (lib/chat.mjs), not by triggers, so the file is plain statements.
create virtual table if not exists chat_messages_fts using fts5(body, content='chat_messages', content_rowid='rowid', tokenize='unicode61');
