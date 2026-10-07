// Writes tools.json (the catalogue in the ROADMAP 3.1 format) from lib/tools.mjs. --check fails if it is stale.
import fs from 'node:fs';
import { catalogue } from '../server.mjs';

// Format: warOnSaaS/suite packages/tools (tools.schema.json). Every tool is served at POST /api/tools/<name>
// and over MCP at /mcp; the screens call the same tools.
const doc = {
  $schema: 'https://raw.githubusercontent.com/warOnSaaS/suite/main/packages/tools/tools.schema.json',
  app: 'chat',
  version: 1,
  tools: catalogue().map((t) => ({ ...t, test: 'test/tools.test.mjs' })),
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
