// Copies the warOnSaaS Account client library into lib/account-client.mjs. The copy is never edited by hand:
// run this again to pick up a new version.
// Usage: node scripts/sync-account.mjs [path-to-account-repo]   (default: ../wos-account or ~/wos-account)
import fs from 'node:fs';
import path from 'node:path';

const candidates = [process.argv[2], path.resolve('..', 'wos-account'), path.join(process.env.HOME ?? '', 'wos-account')].filter(Boolean);
const repo = candidates.find((p) => fs.existsSync(path.join(p, 'client', 'account-client.mjs')));
if (!repo) {
  console.error('sync-account: cannot find the account repo (clone warOnSaaS/account next to this one, or pass its path)');
  process.exit(1);
}
const src = fs.readFileSync(path.join(repo, 'client', 'account-client.mjs'), 'utf8');
const header = `// COPIED from warOnSaaS/account client/account-client.mjs by scripts/sync-account.mjs. Do not edit here;\n// change it in the account repo and run npm run sync-account.\n`;
const to = path.resolve('lib', 'account-client.mjs');
fs.writeFileSync(to, header + src);
console.log(`wrote ${path.relative(process.cwd(), to)} (${Math.round((header.length + src.length) / 1024)} KB) from ${repo}`);
