import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

// Agent parity (ROADMAP 3.2), enforced:
// 1. Screen-to-tool: open every screen, menu and dialog, at desk and phone width, and collect every button,
//    menu item, form and file picker. Each must name a tool from the catalogue (data-tool), be the submit
//    button or a field of a form that does, or say data-tool="none" with a reason in data-why when it only
//    opens, closes, copies or fills something on the page (the suite's rule). Links are navigation.
// 2. No side doors: screen code only talks to /api/tools/*, /files (upload and download streams) and /ws (live events).
// 3. A parity report: actions per screen, the tools the screens use, and tools with no screen (allowed).

process.env.OAUTH_SECRET = 'parity-secret';
process.env.CHAT_DEMO = '1';
process.env.SQLITE_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'chat-parity-')), 'chat.db');
process.env.FILES_STORAGE = 'db';

let server, base, browser, catalogue;

before(async () => {
  const mod = await import('../server.mjs');
  catalogue = new Set(mod.catalogue().map((t) => t.name));
  server = mod.createServer();
  await new Promise((r) => server.listen(0, r));
  await server.ready;
  base = `http://localhost:${server.address().port}`;
  browser = await chromium.launch();
});
after(async () => { await browser?.close(); server?.closeAllConnections?.(); server?.close(); });

// Everything on the page right now that does something.
const collect = (page) => page.evaluate(() => {
  const out = [];
  const visible = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length) || el.type === 'file';
  for (const el of document.querySelectorAll('button, [role=menuitem], form, input[type=file], select')) {
    if (!visible(el) && el.tagName !== 'FORM') continue;
    if (el.closest('[data-auth]')) continue;
    const form = el.closest('form');
    let tool = el.getAttribute('data-tool');
    let how = tool ? 'tool' : null;
    if (tool === 'none') { how = el.getAttribute('data-why') ? `page helper: ${el.getAttribute('data-why')}` : null; tool = null; }
    if (!how && el.tagName === 'BUTTON' && el.type === 'submit' && form?.dataset.tool) { tool = form.dataset.tool; how = 'submit'; }
    if (!how && (el.tagName === 'SELECT' || el.tagName === 'INPUT') && form?.dataset.tool) { tool = form.dataset.tool; how = 'form field'; }
    out.push({ tag: el.tagName.toLowerCase(), text: (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 50), tool, how });
  }
  return out;
});

test('every action on every screen has a tool, at desk and phone width', async () => {
  const report = { screens: {}, toolsOnScreens: new Set(), problems: [] };
  for (const [w, h, tag] of [[1440, 900, 'desk'], [390, 844, 'phone']]) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, hasTouch: tag === 'phone', isMobile: tag === 'phone' });
    const page = await ctx.newPage();
    await page.goto(`${base}/`);
    await page.waitForFunction(() => window.chatReady === true);
    // Put something in Activity that waits for a person's yes, made by an app acting over the API.
    const sam = await page.evaluate(() => window.chatState.me);
    const { issueTokens } = await import('../lib/auth.mjs');
    const tok = issueTokens({ id: sam.id }).access_token;
    await fetch(`${base}/api/tools/chat.remove_person`, { method: 'POST', headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' }, body: JSON.stringify({ person: 'riley' }) });
    const ids = await page.evaluate(() => Object.fromEntries(window.chatState.channels.map((c) => [c.name, c.id])));
    const check = async (name) => {
      await page.waitForTimeout(250);
      const found = await collect(page);
      report.screens[`${tag} ${name}`] = found.length;
      for (const f of found) {
        if (f.tool) report.toolsOnScreens.add(f.tool);
        if (!f.how) report.problems.push(`${tag} ${name}: <${f.tag}> "${f.text}" names no tool`);
        else if (f.tool && !catalogue.has(f.tool)) report.problems.push(`${tag} ${name}: <${f.tag}> "${f.text}" names ${f.tool}, which is not in the catalogue`);
      }
    };
    const go = async (hash, wait) => { await page.evaluate((x) => { location.hash = x; }, hash); await page.waitForSelector(wait); };
    const open = async (sel, name) => {
      const el = page.locator(sel).first();
      if (!(await el.count()) || !(await el.isVisible())) return;
      await el.click();
      await check(name);
      await page.keyboard.press('Escape');
      await page.evaluate(() => document.querySelectorAll('dialog[open]').forEach((d) => d.close()));
    };

    if (tag === 'phone') { await go('#/home', '#home-list .chans'); await check('home'); }
    await go(`#/c/${ids['front-desk']}`, '.msg');
    await check('channel');
    // Reveal message actions (hover on a desk, a tap on a phone) and open each menu.
    const msg = page.locator('.msg').nth(2);
    if (tag === 'desk') await msg.hover(); else await msg.locator('.msg-text').click();
    await check('message actions');
    await open('.msg.is-active [data-open=msg-menu], .msg:hover [data-open=msg-menu]', 'message menu');
    if (tag === 'desk') await msg.hover(); else await msg.locator('.msg-text').click();
    await open('.msg.is-active [data-open=emoji], .msg:hover [data-open=emoji]', 'reaction picker');
    await open('[data-open=channel-menu]:visible', 'channel menu');
    await open('[data-open=notify-menu]:visible', 'notification menu');
    await open('[data-open=members]:visible', 'members dialog');
    if (tag === 'desk') {
      await page.click('[data-open=channel-menu]:visible');
      await open('.pop [data-open=topic]', 'topic dialog');
      await open('[data-open=new-channel]:visible', 'new channel dialog');
      await open('[data-open=new-dm]:visible', 'new message dialog');
    }
    await open('#composer [data-open=emoji-insert]', 'emoji insert');
    // Mention picker.
    await page.fill('#composer textarea', '@');
    await page.dispatchEvent('#composer textarea', 'input');
    await check('mention picker');
    await page.fill('#composer textarea', '');
    // A message of your own (edit and delete in its menu), then its inline edit form.
    await page.fill('#composer textarea', 'parity check');
    await page.click('#composer [type=submit]');
    await page.waitForSelector('.msg:has-text("parity check")');
    const mine = page.locator('.msg:has-text("parity check")').last();
    if (tag === 'desk') await mine.hover(); else await mine.locator('.msg-text').click();
    await open('.msg.is-active [data-open=msg-menu], .msg:hover [data-open=msg-menu]', 'own message menu');
    if (tag === 'desk') await mine.hover(); else await mine.locator('.msg-text').click();
    await page.locator('.msg.is-active [data-open=msg-menu], .msg:hover [data-open=msg-menu]').first().click();
    await page.click('.pop [data-tool="chat.edit_message"]');
    await check('inline edit');
    await page.keyboard.press('Escape');
    const root = await page.evaluate(() => [...window.chatState.convos.values()].flatMap((c) => c.messages).find((m) => m.reply_count)?.id);
    await go(`#/c/${ids['front-desk']}/t/${root}`, '#thread .msg');
    await check('thread');
    await go(`#/c/${ids.leadership}`, '.msg'); await check('private channel');
    // A public channel Sam is not in shows a join button.
    await go(`#/c/${ids.random}`, '.stream'); await check('channel');
    await go('#/search?q=card', '.list .msg'); await check('search');
    await go('#/activity', '.sect'); await check('activity');
    await go('#/browse', '.list'); await check('browse');
    await go('#/settings', '.sect'); await check('settings');
    await ctx.close();
  }
  const used = [...report.toolsOnScreens].sort();
  const unused = [...catalogue].filter((t) => !report.toolsOnScreens.has(t)).sort();
  const summary = { screens: report.screens, actions: Object.values(report.screens).reduce((a, b) => a + b, 0), tools_on_screens: used, tools_without_a_screen: unused, problems: report.problems };
  fs.mkdirSync('.shots', { recursive: true });
  fs.writeFileSync('.shots/parity-report.json', JSON.stringify(summary, null, 2));
  console.log(`parity: ${summary.actions} screen actions on ${Object.keys(report.screens).length} screens, ${used.length} tools used by screens, ${unused.length} tools with no screen (${unused.join(', ')})`);
  assert.deepEqual(report.problems, []);
});

test('no side doors: screen code only calls tools, files and the live feed', () => {
  const dir = new URL('../public/app/', import.meta.url);
  for (const f of fs.readdirSync(dir).filter((x) => /\.m?js$/.test(x))) {
    const src = fs.readFileSync(new URL(f, dir), 'utf8');
    for (const m of src.matchAll(/\bfetch\(\s*(`[^`]*`|'[^']*'|"[^"]*")/g)) {
      const target = m[1].slice(1, -1);
      assert.ok(/^\/api\/tools\/|^\/files\/chat(\?|\/|$)/.test(target), `${f}: fetch(${m[1]}) is a side door`);
      if (f === 'chat.mjs') assert.ok(!/^\/api\/tools\//.test(target), 'the screen part calls tools only through ctx.callTool');
    }
    assert.ok(!/\bfetch\(\s*[a-zA-Z_$]/.test(src), `${f}: fetch with a computed address`);
    assert.ok(!/XMLHttpRequest|sendBeacon|EventSource/.test(src), `${f}: another way to the server`);
    for (const m of src.matchAll(/new WebSocket\(([^)]*)\)/g)) assert.match(m[1], /\/ws`/, `${f}: a socket to somewhere other than /ws`);
  }
});
