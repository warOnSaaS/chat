// Writes tools.json (the catalogue in the ROADMAP 3.1 format) from lib/tools.mjs. --check fails if it is stale.
import fs from 'node:fs';
import { catalogue } from '../server.mjs';

const doc = {
  app: 'chat',
  version: JSON.parse(fs.readFileSync('package.json', 'utf8')).version,
  format: 'wos-tools/1',
  note: 'Every tool is served at POST /api/tools/<name> and over MCP at /mcp. Screens call the same tools.',
  tools: catalogue(),
};
const text = `${JSON.stringify(doc, null, 2)}\n`;
if (process.argv.includes('--check')) {
  const cur = fs.existsSync('tools.json') ? fs.readFileSync('tools.json', 'utf8') : '';
  if (cur !== text) { console.error('tools.json is out of date: run npm run tools:json'); process.exit(1); }
  console.log(`tools.json is current (${doc.tools.length} tools)`);
  process.exit(0);
} else {
  fs.writeFileSync('tools.json', text);
  console.log(`wrote tools.json (${doc.tools.length} tools)`);
  process.exit(0);
}
