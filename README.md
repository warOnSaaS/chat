# wOS Chat

Team chat your team owns. Channels, direct messages, threads, reactions, search and files, with AI agents as team members you can @mention. Everything a person can do on screen, an agent can do too, through the same tools.

Try the demo at **[chat.waronsaas.com](https://chat.waronsaas.com)**. It is a made-up dental practice, Acme Dental. Each visitor gets their own copy, and it resets after a day.

## Two ways to run it

| Host it yourself, free | Host it with us |
|---|---|
| One `docker compose up` and you have it. Use any Postgres, or SQLite on one computer. Keep files on disk or in any S3 store. No licence key and no limits. | We run it for you and charge what it costs us, times two, with the price shown openly. You can move to your own server at any time with one export. |

### Self-hosting in five minutes

```sh
git clone https://github.com/warOnSaaS/chat && cd chat
echo "OAUTH_SECRET=$(openssl rand -hex 32)" > .env
docker compose up -d          # Postgres and the chat, on http://localhost:3995
```

Open it and sign in with an email link. **The first person to sign in becomes the owner.** Until you set up email (`SMTP_URL`), sign-in links are written to the server log (`docker compose logs chat`).

The database sets itself up when the app starts. There is nothing to run by hand.

Without Docker you need Node 20 or newer: run `npm ci && npm start` for SQLite in `./data`, or `DATABASE_URL=postgres://... npm start` for Postgres.

### What a self-hoster needs

| Piece | Needed? | Free options |
|---|---|---|
| A database | Yes | Postgres (any: your own, Neon, Supabase, RDS), or SQLite for one server |
| Somewhere for files | Yes | A folder on disk (default), the database itself (`FILES_STORAGE=db`, 4 MB per file), or any S3 store (MinIO is in the compose file) |
| Email for sign-in links | Recommended | Any SMTP service. Or use GitHub sign-in only |
| Push notifications | No extra service | The server makes its own Web Push keys (VAPID) on first start. There is no relay |
| A model for agents | Optional | Any OpenAI-compatible server, including Ollama, LM Studio and llama.cpp on your own machine |

### Settings

| Variable | What it does |
|---|---|
| `DATABASE_URL` | Postgres address. Without it, SQLite at `SQLITE_FILE` (default `./data/chat.db`) |
| `DATABASE_URL_UNPOOLED` | A direct (not pooled) Postgres address for live updates, if `DATABASE_URL` goes through a pooler such as PgBouncer or Neon's pooler |
| `OAUTH_SECRET` | A long random string that signs sign-in cookies and tokens. **Set it.** |
| `CHAT_TEAM_NAME` | The name shown at the top (default "Team chat") |
| `GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET` | Turn on "Sign in with GitHub". Make a GitHub OAuth app with the callback `https://your-host/oauth/github/callback` |
| `SMTP_URL`, `MAIL_FROM` | Send sign-in links, for example `smtp://user:pass@smtp.example.com:587` |
| `FILES_DIR` | Where files go on disk (default `./data/files`) |
| `FILES_STORAGE=db` | Keep files in the database instead |
| `S3_BUCKET`, `S3_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | Keep files in an S3-compatible store (AWS S3, Cloudflare R2, MinIO, Backblaze B2) |
| `FILES_MAX_MB` | Largest file (default 25) |
| `CHAT_MODEL_URL`, `CHAT_MODEL_KEY`, `CHAT_MODEL` | The model agents use: any OpenAI-compatible `/v1` address, its key and the model name. For Ollama: `CHAT_MODEL_URL=http://localhost:11434/v1 CHAT_MODEL=llama3.1` |
| `CHAT_PUSH_CONTACT` | A `mailto:` address that browser push services can reach you at |
| `CHAT_DEMO=1` | The demo: no sign-in, a fictional team per visitor |
| `PORT` | Default 3995 |

## What it does

- Public and private channels, direct messages and group messages (up to 9 people)
- Threads, reactions, @mentions (and @channel and @here), edit and delete, markdown
- File upload (images show inline)
- Unread counts and mention badges, mark as read, mark unread from a message
- Search across every channel you can see, with `in:#channel` and `from:@person`
- Notification rules: per channel (every message, mentions, nothing, or your usual rule), your usual rule, keywords, and push on or off per device
- Web Push for mentions and direct messages, which works with the tab closed once the app is installed to the home screen
- Live updates over WebSockets. Several copies of the server share them through Postgres `LISTEN/NOTIFY`. If a socket drops, the screen polls until it is back
- **Agents as members.** Add an agent, put it in a channel, and @mention it: it answers in the thread. Message it directly and it answers without a mention. It reads with the same read-only tools a person has and sees only the channels it is in. Agents never wake each other, so they cannot loop
- Light and dark, at phone and desk width, installable as an app
- Export everything as a zip shaped like a Slack export (`users.json`, `channels.json`, `groups.json`, `dms.json`, `mpims.json`, one folder per conversation with a file per day), plus the files themselves and a lossless `wos/` copy of every row
- Slack import: the preview reads a Slack export and says what it holds and what Slack left out. The import itself lands in v1 (ROADMAP 5.3)

## For agents: the tools

Every action is a tool, served two ways from the same handlers:

- **MCP** at `/mcp` (Streamable HTTP, with OAuth sign-in: discovery, dynamic client registration, PKCE). Add `https://your-host/mcp` as a connector in Claude, ChatGPT, Claude Code or Codex. Clients that reject dots in tool names can use `/mcp?names=underscore` (`chat_post` instead of `chat.post_message`).
- **REST** at `POST /api/tools/<name>` with a JSON body. The screens use exactly this, through `ctx.callTool`.

The full catalogue, with input and output schemas, is [`tools.json`](tools.json) (regenerate with `npm run tools:json`). Each tool has a scope (read, write, delete, admin) and a confirm value. A connection can be limited to some scopes (`scope=read write` when it signs in). Tools marked `confirm: human` (removing someone, importing) ask the person first when an app calls them: the request waits in Activity until the person says yes.

| Tool | Scope | |
|---|---|---|
| `chat.list_channels`, `chat.get_channel`, `chat.read_messages`, `chat.search_messages`, `chat.list_mentions`, `chat.list_people`, `chat.list_events`, `chat.get_settings`, `chat.list_approvals` | read | Reading |
| `chat.post_message`, `chat.post_reply`, `chat.edit_message`, `chat.add_reaction`, `chat.remove_reaction`, `chat.upload_file`, `chat.set_typing` | write | Messages |
| `chat.delete_message` | delete | Messages |
| `chat.create_channel`, `chat.open_dm`, `chat.invite_people`, `chat.join_channel`, `chat.leave_channel`, `chat.set_topic`, `chat.set_status` | write | Channels and people |
| `chat.mark_read`, `chat.mark_unread`, `chat.set_notify`, `chat.set_preferences`, `chat.subscribe_push`, `chat.unsubscribe_push`, `chat.decide_approval` | write | Reading state, notifications, approvals |
| `chat.archive_channel`, `chat.add_person`, `chat.add_agent`, `chat.export_data` | admin | Team |
| `chat.remove_person`, `chat.import_slack` | admin, confirm: human | Team |

REST answers as the suite does: `200 { result }`, `202 { pending: { approval_id, message } }` when an app calls a `confirm: human` tool, and `{ error: { code, message } }` otherwise. Events are named `chat.noun.past_verb` (`chat.message.posted`); the full list is in `wos-app.json`.

## Inside the wOS suite

Chat follows the suite's app contract ([warOnSaaS/suite CONTRACTS](https://github.com/warOnSaaS/suite)), so the suite can load this folder as it is:

| Part | File |
|---|---|
| Manifest | `wos-app.json` |
| Tool catalogue | `tools.json` (generated: `npm run tools:json`) |
| Tables | `migrations/0001_init.postgres.sql` and `0001_init.sqlite.sql`, every table `chat_*` with `team_id` |
| Server part | `server.mjs` default-exports `register(ctx)` (code in `lib/suite.mjs`): one handler per tool, file routes under `/files/chat/`, `exportTeam` |
| Screen part | `screens.mjs` exports `{ mount(el, ctx) }` (built from `public/app/chat.mjs` and `chat.css`: `npm run build:screens`) |

`node scripts/suite-check.mjs` (Node 22.6 or newer, with the suite checked out next to this repo) loads Chat into a real suite core, turns it on, posts, replies, mentions, reads a private channel as someone else, adds an agent, exports, and turns it off again.

## Parity with agents

The founder's rule: everything a person can do, an agent can do. It is enforced by tests, so the build fails if it slips:

- **Screen-to-tool** (`test/parity.test.mjs`, Playwright): opens every screen, menu and dialog at 1440 and 390 wide and checks that every button, menu item, form and file picker names a tool from the catalogue, or only opens, closes, copies or fills something on the page. It writes a parity report to `.shots/parity-report.json`.
- **No side doors**: screen code only calls `/api/tools/*`, `/files/chat/` (upload and download streams) and `/ws` (live events). Buttons that only open, close, copy or fill something carry `data-tool="none"` and a reason in `data-why`.
- **Catalogue and agent run** (`test/tools.test.mjs`): every tool is fully described, `tools.json` matches the code, and an agent runs every tool end to end over MCP alone.

## Development

```sh
npm ci
npm run dev                  # the demo on http://localhost:3995
npm test                     # all tests on SQLite
CHAT_TEST_DATABASE_URL=postgres://... npm test   # adds the two-server Postgres live test
CHAT_TEST_PG_ALL=postgres://... npm test         # runs every test on Postgres
npm run shots                # screenshots of every screen into .shots/
npm run sync-kit             # copy the ui-design kit into public/ui
npm run check                # tools.json current, tests, no private names
```

| Path | What |
|---|---|
| `server.mjs` | Routes, MCP, files, sign-in, WebSockets. Also the Vercel function (`api/index.mjs`), and `register(ctx)` for the suite |
| `lib/suite.mjs` | The suite's server part: its ctx and calls translated into the chat code |
| `lib/chat.mjs` | Channels, messages, threads, reactions, unread, search, notification rules |
| `lib/tools.mjs` | The tool catalogue and the one way tools run |
| `lib/bus.mjs` | Live events: stored for catch-up, sent to sockets, shared through `LISTEN/NOTIFY` |
| `lib/agents.mjs` | Agents: OpenAI-compatible model calls with read-only tools, and the example agent |
| `lib/push.mjs` | Web Push with self-made VAPID keys, and who gets notified |
| `lib/export.mjs` | Slack-shaped export, and the Slack import interface and preview |
| `lib/db.mjs`, `migrations/` | Postgres and SQLite, migrations on start |
| `public/app/` | The screens: `chat.mjs` (`mount(el, ctx)`), `page.mjs` (the standalone page: its ctx, WebSocket and polling), `chat.css` (pieces the kit lacks, in kit tokens) |
| `public/ui/` | The ui-design kit, synced, never edited |

### Kit gaps

ui-design does not have these yet, so `public/app/chat.css` builds them in the kit's tokens: the message list (day dividers, the "new" line, grouped messages), a message (avatar, header, body, files, reactions, thread link, hover actions), the thread pane, the chat composer with attachments, the mention picker, the emoji picker, the channel list with unread and mention badges, and a popover menu.

### Limits, plainly

- On Vercel a request body is at most 4.5 MB, so uploads there are capped at 4 MB. Self-hosted, the limit is `FILES_MAX_MB`.
- On Vercel a WebSocket lives at most as long as the function (5 minutes by default). The screen reconnects and catches up from its cursor, so nothing is missed.
- Slack's own export leaves out private channels and direct messages on Free and Pro plans, and carries file links rather than files.
- Huddles, link unfurls, slash commands, pinned items, guests and the Slack import itself are v1 (ROADMAP 5.3).

## Credits

Ideas from Zulip (Apache-2.0): a per-member read pointer for unread counts and threads hanging off a first message. Ideas only, no code, from Mattermost. Markdown by markdown-it (MIT). Web Push by web-push (MPL-2.0). The UI is ui-design (Apache-2.0); its fonts are under the SIL Open Font License.

## Licence

AGPL-3.0. See [LICENSE](LICENSE).
