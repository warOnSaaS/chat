// Renders public/icon.svg to the PNG sizes phones want (run once after changing the icon).
import { chromium } from 'playwright';
import fs from 'node:fs';
const svg = fs.readFileSync('public/icon.svg', 'utf8');
const b = await chromium.launch();
for (const n of [192, 512]) {
  const p = await b.newPage({ viewport: { width: n, height: n } });
  await p.setContent(`<html><body style="margin:0;background:#0b0b0b">${svg.replace('<svg ', `<svg width="${n}" height="${n}" `)}</body></html>`);
  await p.screenshot({ path: `public/icon-${n}.png` });
}
await b.close();
console.log('icons written');
