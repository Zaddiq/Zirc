'use strict';
// Drives docs/index.html in real Chromium against a fake WebSocket IRC server.
// Usage: node test/web.test.js [screenshot-dir]
const assert = require('assert');
const path = require('path');
const { chromium } = require('playwright');
const { startWsServer } = require('./wsserver');

const SHOTS = process.argv[2];
const PAGE = 'file://' + path.resolve(__dirname, '../docs/index.html');
let passed = 0;
const t = async (name, fn) => {
  try { await fn(); passed++; console.log('ok  ', name); }
  catch (e) { console.log('FAIL', name, '\n    ', e.message.split('\n')[0]); process.exitCode = 1; }
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
// The client paces outgoing lines (flood limiter), so wait for the server to actually receive them.
const until = async (fn, ms = 9000, what = 'condition') => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return; await sleep(40); } throw new Error('timed out waiting for ' + what); };

(async () => {
  const srv = await startWsServer();
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  const problems = [];
  page.on('pageerror', e => problems.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/fonts\.g|net::ERR/.test(m.text())) problems.push('console: ' + m.text()); });
  await page.goto(PAGE);
  const last = () => srv.clients[srv.clients.length - 1];
  const logText = () => page.locator('#log').innerText();

  await t('connect screen shows first, defaults to the Ergo test network', async () => {
    assert(await page.locator('#connect').isVisible());
    assert.strictEqual(await page.inputValue('#url'), 'wss://testnet.ergo.chat/webirc');
    assert(/^zirc\d{3}$/.test(await page.inputValue('#nick')));
  });

  await t('rejects a non-WebSocket address with a clear message', async () => {
    await page.fill('#url', 'http://example.com');
    await page.click('#gobtn');
    assert(/wss:\/\//.test(await page.innerText('#cerr')));
    assert(await page.locator('#connect').isVisible());
  });

  await t('connects, negotiates the subprotocol, logs in with SASL, joins', async () => {
    await page.fill('#url', `ws://127.0.0.1:${srv.port}`);
    await page.fill('#nick', 'tester');
    await page.fill('#chans', '#t');
    await page.click('summary:has-text("Log in")');
    await page.fill('#sasluser', 'tester');
    await page.fill('#saslpass', 'hunter2');
    await page.click('#gobtn');
    await page.waitForSelector('#connect', { state: 'hidden', timeout: 5000 });
    await page.waitForFunction(() => document.querySelector('#topic').textContent.includes('The test topic'));
    const c = last();
    assert.strictEqual(c.protocol, 'text.ircv3.net');
    assert.strictEqual(c.authed, 'tester\0tester\0hunter2');
    assert(c.got.some(l => l === 'JOIN #t'), c.got.join('|'));
    assert(!c.got.some(l => /hunter2/.test(l) && !l.startsWith('AUTHENTICATE')), 'password only in AUTHENTICATE');
    assert.strictEqual(await page.inputValue('#saslpass'), '', 'password field is cleared');
    assert(!(await page.evaluate(() => JSON.stringify(localStorage))).includes('hunter2'), 'password must not be stored');
  });

  await t('window list, nicklist and prefixes render', async () => {
    const wins = await page.locator('#wins .win').allInnerTexts();
    assert(wins.some(w => w.includes('TestNet')) && wins.some(w => w.includes('#t')), wins.join('|'));
    await page.waitForFunction(() => document.querySelectorAll('#nicks .n').length === 3);
    const nicks = (await page.locator('#nicks .n').allInnerTexts()).map(s => s.trim());
    assert.deepStrictEqual(nicks, ['@tester', '+bob', 'alice']);
  });

  await t('incoming text is escaped: no HTML injection, safe links only', async () => {
    last().send(':bob!b@bh PRIVMSG #t :<img src=x onerror="window.__pwn=1"> <b>not bold</b> see https://example.com/x). and javascript:alert(1)');
    await page.waitForFunction(() => document.querySelector('#log').textContent.includes('not bold'));
    assert.strictEqual(await page.locator('#log img').count(), 0);
    assert.strictEqual(await page.locator('#log b').count(), 0);
    assert.strictEqual(await page.evaluate(() => window.__pwn), undefined);
    const links = await page.locator('#log a').evaluateAll(as => as.map(a => [a.href, a.rel, a.target]));
    assert.deepStrictEqual(links, [['https://example.com/x', 'noopener noreferrer', '_blank']]);
    assert((await logText()).includes('<img src=x onerror="window.__pwn=1">'), 'markup shown as literal text');
  });

  await t('mIRC colours and bold render; highlight marks lines with my nick', async () => {
    last().send(':bob!b@bh PRIVMSG #t :\x0304red\x03 \x02bold\x02 hello tester');
    await page.waitForFunction(() => document.querySelector('#log').textContent.includes('hello tester'));
    assert.strictEqual(await page.locator('#log span.b', { hasText: 'bold' }).count(), 1);
    const colour = await page.locator('#log span', { hasText: /^red$/ }).first().evaluate(e => e.style.color);
    assert(/255, 107, 107|#ff6b6b/.test(colour), colour);
    assert.strictEqual(await page.locator('#log .line.hl').count(), 1);
  });

  await t('sending a message, and Tab completion', async () => {
    await page.fill('#input', 'hello world');
    await page.press('#input', 'Enter');
    await page.waitForFunction(() => document.querySelector('#log').textContent.includes('hello world'));
    await until(() => last().got.includes('PRIVMSG #t :hello world'), 9000, 'hello world at server');
    await page.fill('#input', 'bo');
    await page.press('#input', 'Tab');
    assert.strictEqual(await page.inputValue('#input'), 'bob: ');
    await page.fill('#input', '');
  });

  await t('input cannot inject IRC commands via newlines or long lines', async () => {
    const n0 = last().got.length;
    await page.evaluate(() => { const i = document.querySelector('#input'); i.value = 'a'; });
    await page.fill('#input', '/raw PRIVMSG #t :x\r\nQUIT :pwned');
    await page.press('#input', 'Enter');
    await sleep(300);
    assert(!last().got.slice(n0).some(l => l.startsWith('QUIT')), last().got.slice(n0).join('|'));
    await page.fill('#input', 'y'.repeat(1500));
    await page.press('#input', 'Enter');
    await page.waitForFunction(() => document.querySelectorAll('#log .line').length > 0);
    await sleep(800);
    await until(() => last().got.slice(n0).filter(l => /^PRIVMSG #t :?y/.test(l)).length >= 4, 12000, 'all chunks of the long line');
    const long = last().got.slice(n0).filter(l => /^PRIVMSG #t :?y/.test(l));
    assert(long.every(l => Buffer.byteLength(l) <= 510), long.map(l => l.length).join(','));
    assert.strictEqual(long.join('').replace(/PRIVMSG #t :?/g, '').length, 1500, 'no characters lost when splitting');
  });

  await t('scripts: save, run, handle events, add /commands, survive errors', async () => {
    await page.click('#btn-scripts');
    await page.click('#sd-ex');
    await page.click('#sd-save');
    assert(/Saved and running/.test(await page.innerText('#sd-msg')));
    await page.click('#sd-close');
    last().send(':bob!b@bh PRIVMSG #t :!ping');
    await page.waitForFunction(() => document.querySelector('#log').textContent.includes('bob: pong'));
    await until(() => last().got.includes('PRIVMSG #t :bob: pong'), 9000, 'pong at server');
    await page.fill('#input', '/shout ship it');
    await page.press('#input', 'Enter');
    await page.waitForFunction(() => document.querySelector('#log').textContent.includes('SHIP IT!'));
    await until(() => last().got.some(l => l === 'PRIVMSG #t :\x02\x0304SHIP IT!\x03\x02'), 9000, 'shout at server');
    // a script that throws shows an error but does not break chat
    await page.click('#btn-scripts');
    await page.click('#sd-new');
    await page.fill('#sd-code', "zirc.on('text', function () { throw new Error('kaboom'); });");
    await page.click('#sd-save');
    await page.click('#sd-close');
    last().send(':bob!b@bh PRIVMSG #t :after the error');
    await page.waitForFunction(() => document.querySelector('#log').textContent.includes('after the error'));
    assert((await logText()).includes('kaboom'));
    // syntax errors are reported in the editor
    await page.click('#btn-scripts');
    await page.click('#sd-new');
    await page.fill('#sd-code', 'this is not ( javascript');
    await page.click('#sd-save');
    assert(/failed/.test(await page.innerText('#sd-msg')));
    await page.click('#sd-close');
  });

  await t('scripts persist across reload', async () => {
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('zirc.scripts')).map(s => s.name));
    assert(saved.includes('example'), saved.join(','));
  });

  await t('private messages open a query window with an unread badge', async () => {
    last().send(':alice!a@ah PRIVMSG tester :psst');
    await page.waitForSelector('#wins .win:has-text("alice")');
    assert(await page.locator('#wins .win:has-text("alice") .badge').count() === 1);
    await page.click('#wins .win:has-text("alice")');
    assert((await logText()).includes('psst'));
    await page.click('#wins .win:has-text("#t")');
  });

  await t('CTCP VERSION from a user gets a reply', async () => {
    last().send(':alice!a@ah PRIVMSG tester :\x01VERSION\x01');
    await until(() => last().got.some(l => /^NOTICE alice :\x01VERSION Zirc/.test(l)), 9000, 'CTCP reply');
  });

  if (SHOTS) {
    await page.screenshot({ path: path.join(SHOTS, 'app-desktop.png') });
  }

  await t('reconnects after the server drops and rejoins channels', async () => {
    const n = srv.clients.length;
    last().sock.destroy();
    await page.waitForFunction(() => document.querySelector('#log').textContent.includes('Disconnected'), null, { timeout: 4000 });
    await until(() => srv.clients.length > n, 8000, 'a new connection');
    await until(() => last().got.includes('JOIN #t'), 8000, 'rejoin of #t');
  });

  await t('/disconnect closes cleanly', async () => {
    await page.fill('#input', '/disconnect');
    await page.press('#input', 'Enter');
    await page.waitForFunction(() => document.querySelector('#wins').textContent.includes('TestNet'));
    await sleep(500);
    const c = last();
    assert(c.got.some(l => l.startsWith('QUIT')), c.got.slice(-3).join('|'));
  });

  // ---- phone layout
  const phone = await browser.newContext({ viewport: { width: 390, height: 800 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
  const mp = await phone.newPage();
  mp.on('pageerror', e => problems.push('mobile pageerror: ' + e.message));
  await mp.goto(PAGE);
  if (SHOTS) await mp.screenshot({ path: path.join(SHOTS, 'connect-mobile.png') });
  await t('mobile: connect screen has no horizontal overflow', async () => {
    assert.strictEqual(await mp.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), 0);
  });
  await mp.fill('#url', `ws://127.0.0.1:${srv.port}`);
  await mp.fill('#nick', 'phoney');
  await mp.fill('#chans', '#t');
  await mp.click('#gobtn');
  await mp.waitForSelector('#connect', { state: 'hidden', timeout: 5000 });
  await mp.waitForFunction(() => document.querySelector('#topic').textContent.includes('The test topic'));
  srv.clients[srv.clients.length - 1].send(':bob!b@bh PRIVMSG #t :\x0311hello\x03 from the other side, with a long line that has to wrap across the narrow phone screen nicely');
  await mp.waitForFunction(() => document.querySelector('#log').textContent.includes('narrow phone'));
  await t('mobile: chat fits, users panel toggles', async () => {
    assert.strictEqual(await mp.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), 0);
    assert(!(await mp.locator('#nicks').isVisible()));
    await mp.click('#users-btn');
    assert(await mp.locator('#nicks').isVisible());
    if (SHOTS) await mp.screenshot({ path: path.join(SHOTS, 'app-mobile-users.png') });
    await mp.click('#users-btn');
  });
  if (SHOTS) await mp.screenshot({ path: path.join(SHOTS, 'app-mobile.png') });

  await t('no page errors or console errors', async () => { assert.deepStrictEqual(problems, []); });

  await browser.close();
  srv.close();
  console.log(`\n${passed} passed`);
})().catch(e => { console.error(e); process.exit(1); });
