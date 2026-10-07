// Copies the warOnSaaS UI kit (ui-design) into public/ui. The app serves those files as they are.
// Usage: node scripts/sync-kit.mjs [path-to-ui-design] [git-ref]   (defaults: ../waronsaas-ui-design, main)
// Files are read from a git ref, not the kit's working folder, so work in progress there never leaks in.
// Until kit v2 lands on main (main has no src/tokens.css yet), it falls back to the kit-v2 branch and says so.
// Never edit public/ui by hand: what the kit lacks is built in public/app/chat.css in the kit's style.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const kit = path.resolve(process.argv[2] ?? path.join(process.env.HOME ?? '..', 'waronsaas-ui-design'));
let ref = process.argv[3] ?? 'main';
const git = (...a) => execFileSync('git', ['-C', kit, ...a]);
const has = (r, f) => { try { git('cat-file', '-e', `${r}:${f}`); return true; } catch { return false; } };
let note = '';
if (!has(ref, 'src/tokens.css') && has('kit-v2', 'src/tokens.css')) {
  note = ` (${ref} has no kit v2 yet, so this used the kit-v2 branch)`;
  ref = 'kit-v2';
}
const files = ['src/ui.css', 'src/tokens.css', 'fonts/geist.woff2', 'fonts/geist-mono.woff2', 'fonts/jetbrains-mono.woff2',
  'fonts/departure-mono.woff2', 'fonts/OFL-Geist.txt', 'fonts/OFL-JetBrainsMono.txt', 'fonts/OFL-DepartureMono.txt', 'NOTICE', 'LICENSE'];
const out = path.resolve('public', 'ui');
fs.rmSync(out, { recursive: true, force: true });
let bytes = 0;
for (const f of files) {
  const to = path.join(out, f);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  const buf = git('show', `${ref}:${f}`);
  // Only the fonts this app ships are kept; the other faces in tokens.css are never requested.
  fs.writeFileSync(to, buf);
  bytes += buf.length;
}
const rev = git('rev-parse', '--short', ref).toString().trim();
fs.writeFileSync(path.join(out, 'SYNCED.txt'), `Copied from warOnSaaS/ui-design ${ref} at ${rev} by scripts/sync-kit.mjs. Do not edit.\n`);
console.log(`synced ui-design ${ref} ${rev} (${files.length} files, ${bytes} bytes) into public/ui${note}`);
