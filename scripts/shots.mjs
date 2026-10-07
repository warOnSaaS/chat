// Screenshots of every screen at 1440 and 390 wide, light and dark, into .shots/.
// Usage: node scripts/shots.mjs [base-url]   (default: starts the demo on a free port with a fresh database)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

let base = process.argv[2];
let server;
if (!base) {
  process.env.CHAT_DEMO = '1';
  process.env.SQLITE_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'chat-shots-')), 'chat.db');
  process.env.FILES_DIR = path.join(path.dirname(process.env.SQLITE_FILE), 'files');
  const { createServer } = await import('../server.mjs');
  server = createServer();
  await new Promise((r) => server.listen(0, r));
  await server.ready;
  base = `http://localhost:${server.address().port}`;
}
const out = path.resolve('.shots');
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
const shots = [];

for (const mode of ['dark', 'light']) {
  for (const [w, h, tag] of [[1440, 900, 'desk'], [390, 844, 'phone']]) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, colorScheme: mode, deviceScaleFactor: tag === 'phone' ? 2 : 1, hasTouch: tag === 'phone', isMobile: tag === 'phone' });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    await page.goto(`${base}/`);
    await page.waitForFunction(() => window.chatReady === true);
    const ids = await page.evaluate(() => Object.fromEntries(window.chatState.channels.map((c) => [c.name, c.id])));
    const snap = async (name) => {
      await page.waitForTimeout(350);
      const file = path.join(out, `${tag}-${mode}-${name}.png`);
      await page.screenshot({ path: file });
      shots.push(file);
    };
    const go = async (hash, wait) => { await page.evaluate((h) => { location.hash = h; }, hash); if (wait) await page.waitForSelector(wait); };
    if (tag === 'phone') { await go('#/home', '#home-list .chans'); await snap('home'); }
    await go(`#/c/${ids['front-desk']}`, '.msg'); await snap('channel');
    const root = await page.evaluate(() => [...window.chatState.convos.values()].flatMap((c) => c.messages).find((m) => m.reply_count)?.id);
    await go(`#/c/${ids.marketing}`, '.msg');
    const mroot = await page.evaluate(() => [...window.chatState.convos.values()].flatMap((c) => c.messages).filter((m) => m.reply_count).pop()?.id);
    await go(`#/c/${ids.marketing}/t/${mroot ?? root}`, '#thread .msg'); await snap('thread');
    // Ask the example agent in the thread, and see it answer there.
    await page.fill('#thread-composer textarea', '@scout summarise this thread');
    await page.press('#thread-composer textarea', 'Enter');
    if (tag === 'phone') await page.click('#thread-composer [type=submit]').catch(() => {});
    await page.waitForFunction(() => window.chatState.thread?.messages.some((m) => m.author.handle === 'scout'), null, { timeout: 8000 }).catch(() => errors.push('agent did not answer'));
    await snap('thread-agent');
    await go(`#/c/${ids.marketing}`, '.msg');
    const one = await page.$('.msg:not(.is-cont)');
    if (tag === 'desk') { await one.hover(); await page.click('.msg:hover [data-open=emoji]'); await snap('react'); await page.keyboard.press('Escape'); }
    await go(`#/c/${ids.general}`, '.msg');
    await page.fill('#composer textarea', 'Hi @');
    await page.dispatchEvent('#composer textarea', 'input');
    await snap('mention-picker');
    await page.fill('#composer textarea', '');
    await go('#/search?q=card', '.list .msg'); await snap('search');
    await go('#/activity', '.sect'); await snap('activity');
    await go('#/browse', '.list'); await snap('browse');
    await go('#/settings', '.sect'); await snap('settings');
    await page.evaluate(() => window.scrollTo(0, 0));
    if (tag === 'desk') { await go(`#/c/${ids.general}`, '.msg'); await page.click('[data-open=new-channel]'); await snap('dialog-new-channel'); }
    if (errors.length) console.log(`${tag} ${mode} errors:`, [...new Set(errors)].join(' | '));
    await ctx.close();
  }
}
await browser.close();
server?.close();
console.log(`${shots.length} screenshots in .shots/`);
process.exit(0);
