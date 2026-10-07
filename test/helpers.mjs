import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp, ensureTeamSetup } from '../lib/app.mjs';

process.env.OAUTH_SECRET = 'test-secret';

// A fresh app on an in-memory SQLite database (or DATABASE_URL when given), with a team of four
// people and one agent. Files go to a temp folder.
export async function makeApp(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-test-'));
  const env = { SQLITE_FILE: ':memory:', FILES_DIR: path.join(dir, 'files'), CHAT_PUSH_DRY: '1', CHAT_TEAM_ID: `t${Math.random().toString(36).slice(2, 8)}`, CHAT_TEAM_NAME: 'Birch Law', ...extra };
  const app = await createApp(env);
  const add = (p) => app.chat.addPerson(app.teamId, p).then((x) => app.chat.personRow(x.id));
  const sam = await add({ name: 'Sam Rivera', handle: 'sam', email: 'sam@birch-law.example', role: 'owner' });
  const jordan = await add({ name: 'Jordan Lee', handle: 'jordan', email: 'jordan@birch-law.example', role: 'member' });
  const casey = await add({ name: 'Casey Morgan', handle: 'casey', email: 'casey@birch-law.example', role: 'member' });
  const riley = await add({ name: 'Riley Chen', handle: 'riley', github: 'riley-gh', role: 'guest' });
  const helper = await add({ name: 'Helper', handle: 'helper', kind: 'agent', agent: { example: true, description: 'a test agent' } });
  app.dir = dir;
  return { app, sam, jordan, casey, riley, helper, run: (me, name, input, o) => app.run(me, name, input, o) };
}

export { ensureTeamSetup };
