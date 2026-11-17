'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { IRCConnection, parseLine, formatLine, splitMessage } = require('../lib/irc');
const fmt = require('../lib/fmt');
const { ScriptEngine } = require('../lib/script');
const { startServer } = require('./fakeserver');

let passed = 0;
const t = (name, fn) => Promise.resolve().then(fn).then(() => { passed++; console.log('ok  ', name); },
  e => { console.log('FAIL', name, '\n    ', e.stack); process.exitCode = 1; });
const wait = (cond, ms = 2000) => new Promise((res, rej) => {
  const t0 = Date.now();
  const iv = setInterval(() => { if (cond()) { clearInterval(iv); res(); } else if (Date.now() - t0 > ms) { clearInterval(iv); rej(new Error('timeout')); } }, 10);
});

(async () => {
  await t('parseLine: tags, prefix, trailing', () => {
    const m = parseLine('@time=2026-01-01T00:00:00.000Z;a=b\\sc :n!u@h PRIVMSG #c :hello world');
    assert.strictEqual(m.tags.time, '2026-01-01T00:00:00.000Z');
    assert.strictEqual(m.tags.a, 'b c');
    assert.strictEqual(m.prefix, 'n!u@h');
    assert.deepStrictEqual(m.params, ['#c', 'hello world']);
  });
  await t('formatLine: strips CR/LF and quotes trailing', () => {
    assert.strictEqual(formatLine('PRIVMSG', '#c', 'a b\r\nQUIT'), 'PRIVMSG #c :a b QUIT');
    assert.strictEqual(formatLine('AWAY'), 'AWAY');
    assert.strictEqual(formatLine('PRIVMSG', 'x\r\nQUIT', 'hi'), 'PRIVMSG xQUIT hi');
  });
  await t('splitMessage respects byte limits', () => {
    const parts = splitMessage('word '.repeat(200), 100);
    assert(parts.every(p => Buffer.byteLength(p) <= 100));
    assert.strictEqual(parts.join(' ').replace(/\s+/g, ' ').trim(), 'word '.repeat(200).trim());
    const u = splitMessage('é'.repeat(300), 100);
    assert(u.every(p => Buffer.byteLength(p) <= 100) && u.join('') === 'é'.repeat(300));
  });
  await t('fmt: colors/bold parse and strip, escape removal', () => {
    assert.strictEqual(fmt.strip('\x02hi\x02 \x0304,01red\x03 \x1b[31mx'), 'hi red [31mx');
    const out = fmt.render(fmt.parse('\x034red\x03 plain'));
    assert(out.includes('\x1b[0;38;5;9m'), out);
    assert(!/\x1b\[31m/.test(fmt.render(fmt.parse('\x1b[31mevil'))));
  });
  await t('fmt: wrap keeps indent and width', () => {
    const rows = fmt.wrap(fmt.parse('aaaa bbbb cccc dddd eeee'), 12, 3);
    assert(rows.every(r => fmt.width(r) <= 12), JSON.stringify(rows.map(fmt.width)));
    assert(rows.length > 1 && rows[1][0].ch === ' ');
  });

  const { server, clients, port } = await startServer();
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'zirc-test-'));

  await t('connect, caps, SASL, register, 005, join, names, state', async () => {
    const c = new IRCConnection({ host: '127.0.0.1', port, nick: 'me', sasl: { pass: 'secret' }, reconnect: false });
    const events = [];
    c.on('registered', () => events.push('registered'));
    c.on('sasl', e => events.push('sasl:' + e.ok));
    c.on('message', m => events.push(`${m.type}:${m.from.nick}:${m.text}`));
    c.on('ctcp', e => events.push('ctcp:' + e.command));
    c.connect();
    await wait(() => c.registered);
    assert(events.includes('sasl:true'));
    assert.strictEqual(clients[0].authed, 'me\0me\0secret');
    await wait(() => c.network === 'TestNet');
    assert(c.caps.has('server-time') && c.caps.has('sasl'));
    c.join('#t');
    await wait(() => c.channels.get('#t') && c.channels.get('#t').users.size === 3);
    const ch = c.channels.get('#t');
    assert.strictEqual(ch.topic, 'The test topic');
    assert.strictEqual(c.userPrefix('#t', 'me'), '@');
    assert.strictEqual(c.userPrefix('#t', 'bob'), '+');
    const cl = clients[0];
    cl.send(':bob!b@bh PRIVMSG #t :hello there');
    cl.send(':bob!b@bh PRIVMSG #t :\x01ACTION waves\x01');
    cl.send(':bob!b@bh PRIVMSG me :\x01VERSION\x01');
    cl.send(':alice!a@ah NICK alice2');
    cl.send(':srv MODE #t +o alice2');
    cl.send(':bob!b@bh QUIT :bye');
    await wait(() => ch.users.size === 2 && ch.users.has('alice2'));
    assert(events.includes('privmsg:bob:hello there'));
    assert(events.includes('action:bob:waves'));
    assert(events.includes('ctcp:VERSION'));
    assert(cl.got.some(l => /^NOTICE bob :\x01VERSION Zirc/.test(l)), cl.got.join('|'));
    assert.strictEqual(c.userPrefix('#t', 'alice2'), '@');
    c.disconnect();
    await wait(() => !c.socket);
  });

  await t('send: injection stripped, long text split, flood queue paces output', async () => {
    const c = new IRCConnection({ host: '127.0.0.1', port, nick: 'me2', reconnect: false, floodBurst: 2, floodRate: 150 });
    c.connect();
    await wait(() => c.registered);
    const cl = clients[clients.length - 1];
    const n0 = cl.got.length;
    c.say('#t', 'hi\r\nQUIT :pwned');
    await wait(() => cl.got.some(l => l === 'PRIVMSG #t :QUIT :pwned'));
    assert(!cl.got.slice(n0).some(l => l.startsWith('QUIT')), 'newline must not inject a command');
    assert(cl.got.some(l => l === 'PRIVMSG #t hi'), cl.got.join('|'));
    c.send('PRIVMSG', '#t', 'a\r\nQUIT');
    await wait(() => cl.got.some(l => l === 'PRIVMSG #t :a QUIT'));
    const sent = c.say('#t', 'x'.repeat(1200));
    assert(sent.length >= 3 && sent.every(s => Buffer.byteLength(s) < 430));
    const t0 = Date.now();
    for (let i = 0; i < 5; i++) c.send('PRIVMSG', '#t', 'burst' + i);
    await wait(() => cl.got.filter(l => /burst4/.test(l)).length === 1, 3000);
    assert(Date.now() - t0 >= 300, 'flood limiter should pace output, took ' + (Date.now() - t0));
    c.disconnect();
    await wait(() => !c.socket);
  });

  await t('reconnect rejoins channels', async () => {
    const c = new IRCConnection({ host: '127.0.0.1', port, nick: 'me3', reconnectBase: 50 });
    let regs = 0;
    c.on('registered', () => regs++);
    c.connect();
    await wait(() => regs === 1);
    c.join('#r');
    await wait(() => c.channels.has('#r'));
    clients[clients.length - 1].sock.destroy();
    await wait(() => regs === 2 && c.channels.has('#r'), 4000);
    c.disconnect();
    await wait(() => !c.socket);
  });

  await t('script engine: events, aliases, halt, store, timers, errors isolated', async () => {
    const errors = [], echoes = [];
    const eng = new ScriptEngine({
      version: 't', home: sandbox, storeDir: path.join(sandbox, 'store'),
      echo: x => echoes.push(x), error: (n, e) => errors.push([n, e.message]),
      say() {}, action() {}, notice() {}, send() {}, runLine() {}, info: () => null,
    });
    const f = path.join(sandbox, 's1.js');
    fs.writeFileSync(f, `
      let n = 0;
      zirc.on('text', e => { n++; zirc.store.set('n', n); });
      zirc.on('text', e => { if (e.text === 'stop') return false; });
      zirc.on('text', e => { throw new Error('boom'); });
      zirc.alias('hello', (a, ctx) => ctx.echo('hi ' + a));
      const t = zirc.every(100, () => zirc.echo('tick'));
    `);
    eng.load(f);
    assert.strictEqual(eng.emit('text', { text: 'x' }), true);
    assert.deepStrictEqual(errors, [['s1', 'boom']]);
    assert.strictEqual(eng.emit('text', { text: 'stop' }), false);
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(sandbox, 'store', 's1.json'))).n, 2);
    let got; eng.alias('hello')('world', { echo: x => { got = x; } });
    assert.strictEqual(got, 'hi world');
    await new Promise(r => setTimeout(r, 250));
    assert(echoes.filter(x => x === 'tick').length >= 2);
    eng.unload('s1');
    const n = echoes.length;
    await new Promise(r => setTimeout(r, 250));
    assert.strictEqual(echoes.length, n, 'timers must stop on unload');
    assert.strictEqual(eng.alias('hello'), null);
    fs.writeFileSync(path.join(sandbox, 'bad.js'), 'this is not js (');
    assert.throws(() => eng.load(path.join(sandbox, 'bad.js')));
    assert.strictEqual(eng.list().length, 0);
  });

  server.close();
  for (const c of clients) c.sock.destroy();
  fs.rmSync(sandbox, { recursive: true, force: true });
  console.log(`\n${passed} passed`);
})();
