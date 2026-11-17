'use strict';
// IRC protocol layer: parsing, connection, IRCv3 caps, SASL PLAIN, state tracking.
const net = require('net');
const tls = require('tls');
const { EventEmitter } = require('events');

// RFC1459 case mapping.
const CASEMAP = { '[': '{', ']': '}', '\\': '|', '~': '^' };
const lc = s => String(s).toLowerCase().replace(/[\[\]\\~]/g, c => CASEMAP[c]);

const TAG_UNESC = { ':': ';', s: ' ', '\\': '\\', r: '\r', n: '\n' };
const unescapeTag = v => v.replace(/\\(.?)/g, (_, c) => (c in TAG_UNESC ? TAG_UNESC[c] : c));

function parsePrefix(p) {
  if (!p) return { nick: '', user: '', host: '', server: true };
  const m = /^([^!@]*)(?:!([^@]*))?(?:@(.*))?$/.exec(p);
  return { nick: m[1], user: m[2] || '', host: m[3] || '', server: !m[2] && !m[3] && p.includes('.') };
}

function parseLine(line) {
  const msg = { raw: line, tags: {}, prefix: null, command: '', params: [] };
  let rest = line;
  if (rest[0] === '@') {
    const i = rest.indexOf(' ');
    if (i < 0) return msg;
    for (const t of rest.slice(1, i).split(';')) {
      if (!t) continue;
      const eq = t.indexOf('=');
      if (eq < 0) msg.tags[t] = true;
      else msg.tags[t.slice(0, eq)] = unescapeTag(t.slice(eq + 1));
    }
    rest = rest.slice(i + 1).trimStart();
  }
  if (rest[0] === ':') {
    const i = rest.indexOf(' ');
    msg.prefix = i < 0 ? rest.slice(1) : rest.slice(1, i);
    rest = i < 0 ? '' : rest.slice(i + 1).trimStart();
  }
  const sp = rest.indexOf(' ');
  msg.command = (sp < 0 ? rest : rest.slice(0, sp)).toUpperCase();
  rest = sp < 0 ? '' : rest.slice(sp + 1);
  while (rest.length) {
    rest = rest.replace(/^ +/, '');
    if (!rest.length) break;
    if (rest[0] === ':') { msg.params.push(rest.slice(1)); break; }
    const i = rest.indexOf(' ');
    if (i < 0) { msg.params.push(rest); break; }
    msg.params.push(rest.slice(0, i));
    rest = rest.slice(i + 1);
  }
  return msg;
}

// Build a wire line. CR/LF/NUL are stripped (no command injection through params);
// only the last parameter may contain spaces.
function formatLine(cmd, ...params) {
  params = params.filter(p => p !== undefined && p !== null).map(p => String(p).replace(/[\r\n\0]+/g, ' '));
  let out = cmd;
  params.forEach((p, i) => {
    const last = i === params.length - 1;
    if (!last) p = p.replace(/\s/g, '');
    out += ' ' + (last && (p === '' || p.includes(' ') || p[0] === ':') ? ':' + p : p);
  });
  return out;
}

// Split text into chunks of at most `max` bytes, preferring word boundaries.
function splitMessage(text, max) {
  const out = [];
  let rest = text;
  while (Buffer.byteLength(rest) > max) {
    let bytes = 0, i = 0;
    for (const ch of rest) {
      const b = Buffer.byteLength(ch);
      if (bytes + b > max) break;
      bytes += b;
      i += ch.length;
    }
    let cut = i;
    const sp = rest.lastIndexOf(' ', i);
    if (sp > i * 0.6) cut = sp;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^ /, '');
  }
  out.push(rest);
  return out;
}

const DEFAULT_CAPS = ['server-time', 'multi-prefix', 'away-notify', 'account-notify', 'extended-join',
  'userhost-in-names', 'chghost', 'invite-notify', 'sasl'];

class IRCConnection extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.opts = Object.assign({
      host: 'localhost', port: 6667, tls: false, nick: 'zirc', user: 'zirc', realname: 'Zirc IRC client',
      password: null, sasl: null, caps: DEFAULT_CAPS, reconnect: true, reconnectBase: 2000, reconnectMax: 60000,
      ctcp: true, version: 'Zirc', rejectUnauthorized: true, floodBurst: 5, floodRate: 1000,
    }, opts);
    this.nick = this.opts.nick;
    this.socket = null;
    this.registered = false;
    this.quitting = false;
    this.channels = new Map();   // lc(name) -> { name, users: Map(lc(nick) -> {nick, modes}), topic, ver }
    this.hosts = new Map();      // lc(nick) -> user@host
    this.caps = new Set();
    this.lag = null;
    this.network = null;
    this._attempts = 0;
    this._everRegistered = false;
    this._rejoin = [];
    this._keys = new Map();
    this._resetIsupport();
  }

  _resetIsupport() {
    this.isupport = new Map();
    this.prefixModes = 'ov';
    this.prefixSyms = '@+';
    this.chantypes = '#&';
    this.chanmodes = ['beI', 'k', 'l', 'imnpst'];
  }

  get connected() { return !!(this.registered && this.socket && !this.socket.destroyed); }
  get connecting() { return !!(this.socket && !this.socket.destroyed && !this.registered); }

  chanName(t) {
    let s = String(t);
    while (s && this.prefixSyms.includes(s[0])) s = s.slice(1);
    return s;
  }
  isChannel(t) { const s = this.chanName(t || ''); return !!s && this.chantypes.includes(s[0]); }
  userPrefix(chan, nick) {
    const ch = this.channels.get(lc(chan));
    const u = ch && ch.users.get(lc(nick));
    if (!u) return '';
    for (let i = 0; i < this.prefixModes.length; i++) if (u.modes.includes(this.prefixModes[i])) return this.prefixSyms[i] || '';
    return '';
  }
  userHost(nick) { return this.hosts.get(lc(nick)) || null; }

  // ---- connection lifecycle ----
  connect() {
    if (this.socket) this._kill();
    this.quitting = false;
    clearTimeout(this._rt);
    this._buf = '';
    this.registered = false;
    this._capAvail = new Map();
    this._capPending = new Set();
    this._capEnded = false;
    this._sasl = false;
    this._closeReason = null;
    this.queue = [];
    this.tokens = this.opts.floodBurst;
    this._tokT = Date.now();
    this._wantedNick = this.opts.nick;
    this.nick = this.opts.nick;
    this.caps = new Set();
    this._resetIsupport();
    const o = this.opts;
    this.emit('connecting', { host: o.host, port: o.port, tls: o.tls });
    const sock = o.tls
      ? tls.connect({ host: o.host, port: o.port, servername: net.isIP(o.host) ? undefined : o.host, rejectUnauthorized: o.rejectUnauthorized })
      : net.connect({ host: o.host, port: o.port });
    this.socket = sock;
    sock.setEncoding('utf8');
    sock.setNoDelay(true);
    sock.on(o.tls ? 'secureConnect' : 'connect', () => { if (sock === this.socket) this._onConnect(); });
    sock.on('data', d => { if (sock === this.socket) this._onData(d); });
    sock.on('error', e => { if (sock === this.socket) { this._closeReason = e.message; this.emit('socketerror', e); } });
    sock.on('close', () => this._onClose(sock));
  }

  _kill() {
    clearInterval(this._tick);
    clearTimeout(this._pt);
    if (this.socket) { this.socket.removeAllListeners('data'); this.socket.destroy(); }
    this.socket = null;
  }

  _onConnect() {
    this.lastData = Date.now();
    this._lastLagPing = Date.now();
    this._tick = setInterval(() => {
      const now = Date.now();
      if (now - this.lastData > 270000) { this._closeReason = 'Ping timeout'; this.socket && this.socket.destroy(); return; }
      if (this.registered && now - this._lastLagPing > 60000) {
        this._lastLagPing = now;
        this.sendNow('PING', 'zirc-lag-' + now);
      }
    }, 15000);
    this.emit('connected');
    if (this.opts.password) this.sendNow('PASS', this.opts.password);
    this.sendNow('CAP', 'LS', '302');
    this.sendNow('NICK', this.nick);
    this.sendNow('USER', this.opts.user, '0', '*', this.opts.realname);
  }

  _onData(d) {
    this.lastData = Date.now();
    this._buf += d;
    if (this._buf.length > 65536 && !this._buf.includes('\n')) { this._buf = ''; return; }
    let i;
    while ((i = this._buf.indexOf('\n')) >= 0) {
      const line = this._buf.slice(0, i).replace(/\r$/, '');
      this._buf = this._buf.slice(i + 1);
      if (!line) continue;
      try { this._handle(parseLine(line)); } catch (e) { this.emit('internalerror', e); }
    }
  }

  _onClose(sock) {
    if (sock !== this.socket) return;
    clearInterval(this._tick);
    clearTimeout(this._pt);
    this.socket = null;
    const wasRegistered = this.registered;
    this.registered = false;
    if (wasRegistered) this._rejoin = [...this.channels.values()].map(c => c.name);
    this.channels.clear();
    const reason = this._closeReason || 'Connection closed';
    this.emit('disconnected', { reason, quit: this.quitting });
    if (!this.quitting && this.opts.reconnect) {
      const delay = Math.min(this.opts.reconnectMax, this.opts.reconnectBase * 2 ** this._attempts++);
      this.emit('reconnecting', { delay, attempt: this._attempts });
      this._rt = setTimeout(() => this.connect(), delay);
    }
  }

  disconnect(msg = 'Zirc') {
    this.quitting = true;
    clearTimeout(this._rt);
    const s = this.socket;
    if (!s || s.destroyed) return;
    if (this.registered) {
      this.sendNow('QUIT', msg);
      s.end();
      const t = setTimeout(() => s.destroy(), 1500);
      t.unref();
    } else {
      s.destroy();
    }
  }

  // ---- sending ----
  _write(line) {
    const s = this.socket;
    if (!s || s.destroyed || !s.writable) return false;
    s.write(line + '\r\n');
    this.emit('out', /^(AUTHENTICATE \S|PASS )/.test(line) ? line.split(' ')[0] + ' ***' : line);
    return true;
  }
  sendNow(cmd, ...params) { return this._write(formatLine(cmd, ...params)); }
  send(cmd, ...params) { return this.raw(formatLine(cmd, ...params)); }
  raw(line) {
    line = String(line).replace(/[\r\n\0]+/g, ' ').slice(0, 510);
    if (!line.trim()) return false;
    if (!this.socket) return false;
    this.queue.push(line);
    this._pump();
    return true;
  }
  _pump() {
    if (this._pumping) return;
    const step = () => {
      this._pumping = false;
      const now = Date.now();
      this.tokens = Math.min(this.opts.floodBurst, this.tokens + (now - this._tokT) / this.opts.floodRate);
      this._tokT = now;
      while (this.queue.length && this.tokens >= 1) { this.tokens -= 1; this._write(this.queue.shift()); }
      if (this.queue.length) {
        this._pumping = true;
        this._pt = setTimeout(step, Math.ceil((1 - this.tokens) * this.opts.floodRate));
      }
    };
    step();
  }

  _chunks(target, text, reserve = 0) {
    const budget = Math.max(100, 500 - 70 - Buffer.byteLength(this.nick) - Buffer.byteLength(target) - 12 - reserve);
    const out = [];
    for (const l of String(text).split(/\r?\n/)) if (l.length) out.push(...splitMessage(l, budget));
    return out;
  }
  say(target, text, cmd = 'PRIVMSG') {
    const sent = this._chunks(target, text);
    for (const c of sent) this.send(cmd, target, c);
    return sent;
  }
  notice(target, text) { return this.say(target, text, 'NOTICE'); }
  action(target, text) {
    const sent = this._chunks(target, text, 10);
    for (const c of sent) this.send('PRIVMSG', target, `\x01ACTION ${c}\x01`);
    return sent;
  }
  ctcp(target, cmd, args = '') { this.send('PRIVMSG', target, `\x01${cmd}${args ? ' ' + args : ''}\x01`); }
  ctcpReply(target, cmd, args = '') { this.send('NOTICE', target, `\x01${cmd}${args ? ' ' + args : ''}\x01`); }
  join(chans, key) {
    if (key && !chans.includes(',')) this._keys.set(lc(chans), key);
    this.send('JOIN', chans, key);
  }
  part(chan, reason) { this.send('PART', chan, reason); }
  setNick(n) { this.send('NICK', n); }

  // ---- receiving ----
  _isSelf(n) { return lc(n) === lc(this.nick); }
  _touch(ch) { ch.ver++; }
  _addUser(ch, nick, modes = '') { ch.users.set(lc(nick), { nick, modes }); this._touch(ch); }
  _rememberHost(who) { if (who.user && who.host) this.hosts.set(lc(who.nick), `${who.user}@${who.host}`); }

  _handle(msg) {
    this.emit('raw', msg);
    const p = msg.params;
    const who = parsePrefix(msg.prefix);
    const tm = msg.tags.time ? new Date(msg.tags.time) : null;
    const time = tm && !isNaN(tm) ? tm : new Date();
    const cmd = msg.command;

    if (/^\d{3}$/.test(cmd)) return this._numeric(msg, cmd, p);

    switch (cmd) {
      case 'PING': this.sendNow('PONG', p[0] || ''); return;
      case 'PONG': {
        const m = /^zirc-lag-(\d+)$/.exec(p[p.length - 1] || '');
        if (m) { this.lag = (Date.now() - +m[1]) / 1000; this.emit('lag', this.lag); }
        return;
      }
      case 'CAP': return this._cap(msg);
      case 'AUTHENTICATE': {
        if (p[0] !== '+' || !this.opts.sasl) return;
        const u = this.opts.sasl.user || this.opts.nick;
        const b64 = Buffer.from(`${u}\0${u}\0${this.opts.sasl.pass}`).toString('base64');
        for (let i = 0; i < b64.length; i += 400) this.sendNow('AUTHENTICATE', b64.slice(i, i + 400));
        if (b64.length % 400 === 0) this.sendNow('AUTHENTICATE', '+');
        return;
      }
      case 'JOIN': {
        const chan = p[0];
        const self = this._isSelf(who.nick);
        this._rememberHost(who);
        if (self) {
          this.channels.set(lc(chan), { name: chan, users: new Map(), topic: '', ver: 0 });
        } else {
          const ch = this.channels.get(lc(chan));
          if (ch) this._addUser(ch, who.nick, '');
        }
        const account = p[1] && p[1] !== '*' ? p[1] : null;
        this.emit('join', { who, channel: chan, self, account, realname: p[2], time });
        return;
      }
      case 'PART': {
        const chan = p[0];
        const self = this._isSelf(who.nick);
        const ch = this.channels.get(lc(chan));
        if (self) this.channels.delete(lc(chan));
        else if (ch) { ch.users.delete(lc(who.nick)); this._touch(ch); }
        this.emit('part', { who, channel: chan, reason: p[1] || '', self, time });
        return;
      }
      case 'KICK': {
        const [chan, victim, reason] = p;
        const self = this._isSelf(victim);
        const ch = this.channels.get(lc(chan));
        if (self) this.channels.delete(lc(chan));
        else if (ch) { ch.users.delete(lc(victim)); this._touch(ch); }
        this.emit('kick', { who, channel: chan, victim, reason: reason || '', self, time });
        return;
      }
      case 'QUIT': {
        const chans = [];
        for (const ch of this.channels.values()) {
          if (ch.users.delete(lc(who.nick))) { this._touch(ch); chans.push(ch.name); }
        }
        this.hosts.delete(lc(who.nick));
        this.emit('quit', { who, reason: p[0] || '', channels: chans, time });
        return;
      }
      case 'NICK': {
        const newNick = p[0];
        const self = this._isSelf(who.nick);
        const chans = [];
        for (const ch of this.channels.values()) {
          const u = ch.users.get(lc(who.nick));
          if (u) {
            ch.users.delete(lc(who.nick));
            u.nick = newNick;
            ch.users.set(lc(newNick), u);
            this._touch(ch);
            chans.push(ch.name);
          }
        }
        const h = this.hosts.get(lc(who.nick));
        if (h) { this.hosts.delete(lc(who.nick)); this.hosts.set(lc(newNick), h); }
        if (self) this.nick = newNick;
        this.emit('nick', { who, newNick, self, channels: chans, time });
        return;
      }
      case 'CHGHOST':
        this.hosts.set(lc(who.nick), `${p[0]}@${p[1]}`);
        this.emit('chghost', { who, user: p[0], host: p[1] });
        return;
      case 'ACCOUNT': this.emit('account', { who, account: p[0] === '*' ? null : p[0] }); return;
      case 'AWAY': this.emit('away', { who, message: p[0] || null }); return;
      case 'TOPIC': {
        const ch = this.channels.get(lc(p[0]));
        if (ch) ch.topic = p[1] || '';
        this.emit('topic', { who, channel: p[0], topic: p[1] || '', time });
        return;
      }
      case 'INVITE': this.emit('invite', { who, channel: p[1], time }); return;
      case 'MODE': {
        const target = p[0];
        if (this.isChannel(target)) {
          const ch = this.channels.get(lc(target));
          const changes = this._applyModes(ch, p[1] || '', p.slice(2));
          this.emit('mode', { who, target, modestr: p.slice(1).join(' '), changes, time });
        } else {
          this.emit('usermode', { who, target, modestr: p.slice(1).join(' ') });
        }
        return;
      }
      case 'PRIVMSG':
      case 'NOTICE': return this._message(msg, who, time);
      case 'ERROR': this.emit('servererror', { message: p[0] || '' }); this._closeReason = p[0] || null; return;
      default:
    }
  }

  _message(msg, who, time) {
    const [target, text = ''] = msg.params;
    if (target === undefined) return;
    const isNotice = msg.command === 'NOTICE';
    const base = { from: who, target, isChannel: this.isChannel(target), self: this._isSelf(who.nick), time, tags: msg.tags };
    this._rememberHost(who);
    const c = /^\x01([^\x01 ]*) ?([^\x01]*)\x01?$/.exec(text);
    if (c) {
      const command = c[1].toUpperCase(), args = c[2];
      if (isNotice) { this.emit('ctcpreply', { ...base, command, args }); return; }
      if (command === 'ACTION') { this.emit('message', { ...base, type: 'action', text: args }); return; }
      this.emit('ctcp', { ...base, command, args });
      if (this.opts.ctcp && !base.isChannel) this._autoCtcp(who.nick, command, args);
      return;
    }
    this.emit('message', { ...base, type: isNotice ? 'notice' : 'privmsg', text });
  }

  _autoCtcp(nick, command, args) {
    const now = Date.now();
    this._ctcpTimes = (this._ctcpTimes || []).filter(t => now - t < 10000);
    if (this._ctcpTimes.length >= 5) return; // flood protection
    this._ctcpTimes.push(now);
    switch (command) {
      case 'VERSION': this.ctcpReply(nick, 'VERSION', `${this.opts.version} (node ${process.version})`); break;
      case 'PING': this.ctcpReply(nick, 'PING', args.slice(0, 64)); break;
      case 'TIME': this.ctcpReply(nick, 'TIME', new Date().toString()); break;
      case 'CLIENTINFO': this.ctcpReply(nick, 'CLIENTINFO', 'ACTION CLIENTINFO PING TIME VERSION'); break;
      default:
    }
  }

  _applyModes(ch, modestr, args) {
    const [A, B, C] = this.chanmodes;
    const changes = [];
    let add = true, ai = 0;
    for (const m of modestr) {
      if (m === '+') add = true;
      else if (m === '-') add = false;
      else if (this.prefixModes.includes(m)) {
        const arg = args[ai++];
        changes.push({ add, mode: m, arg });
        const u = ch && arg && ch.users.get(lc(arg));
        if (u) {
          const set = new Set(u.modes);
          if (add) set.add(m); else set.delete(m);
          u.modes = [...this.prefixModes].filter(x => set.has(x)).join('');
          this._touch(ch);
        }
      } else if (A.includes(m) || B.includes(m) || (C.includes(m) && add)) {
        changes.push({ add, mode: m, arg: args[ai++] });
      } else changes.push({ add, mode: m });
    }
    return changes;
  }

  _cap(msg) {
    const p = msg.params;
    const sub = (p[1] || '').toUpperCase();
    const list = (p[p.length - 1] || '').split(' ').filter(Boolean);
    if (sub === 'LS') {
      for (const tok of list) {
        const i = tok.indexOf('=');
        this._capAvail.set(i < 0 ? tok : tok.slice(0, i), i < 0 ? '' : tok.slice(i + 1));
      }
      if (p[2] === '*') return;
      this._requestCaps();
    } else if (sub === 'ACK') {
      for (const c of list) {
        const name = c.replace(/^[-~=]+/, '');
        if (c[0] === '-') this.caps.delete(name); else this.caps.add(name);
        this._capPending.delete(name);
        if (name === 'sasl' && c[0] !== '-' && this.opts.sasl) { this._sasl = true; this.sendNow('AUTHENTICATE', 'PLAIN'); }
      }
      this._maybeEnd();
    } else if (sub === 'NAK') {
      for (const c of list) this._capPending.delete(c);
      this._maybeEnd();
    } else if (sub === 'DEL') {
      for (const c of list) this.caps.delete(c);
    }
  }

  _requestCaps() {
    const want = this.opts.caps.filter(c => this._capAvail.has(c) && (c !== 'sasl' || (this.opts.sasl &&
      (!this._capAvail.get('sasl') || this._capAvail.get('sasl').toUpperCase().split(',').includes('PLAIN')))));
    for (const c of want) { this._capPending.add(c); this.sendNow('CAP', 'REQ', c); }
    this._maybeEnd();
  }

  _maybeEnd() {
    if (this._capEnded || this.registered || this._capPending.size || this._sasl) return;
    this._capEnded = true;
    this.sendNow('CAP', 'END');
  }

  _numeric(msg, cmd, p) {
    switch (cmd) {
      case '001':
        this.nick = p[0];
        this.registered = true;
        this._attempts = 0;
        this.emit('registered', { nick: p[0], message: p[1] || '', reconnect: this._everRegistered });
        this._everRegistered = true;
        if (this._rejoin.length) {
          for (const c of this._rejoin) this.send('JOIN', c, this._keys.get(lc(c)));
          this._rejoin = [];
        }
        break;
      case '005':
        for (const tok of p.slice(1, -1)) {
          const i = tok.indexOf('=');
          const k = i < 0 ? tok : tok.slice(0, i), v = i < 0 ? '' : tok.slice(i + 1);
          this.isupport.set(k, v);
          if (k === 'PREFIX') {
            const m = /^\((\w*)\)(.*)$/.exec(v);
            if (m) { this.prefixModes = m[1]; this.prefixSyms = m[2]; }
          } else if (k === 'CHANTYPES') this.chantypes = v || '#&';
          else if (k === 'CHANMODES') this.chanmodes = v.split(',').concat(['', '', '', '']).slice(0, 4);
          else if (k === 'NETWORK') this.network = v;
        }
        break;
      case '332': {
        const ch = this.channels.get(lc(p[1]));
        if (ch) ch.topic = p[2] || '';
        this.emit('topic', { who: null, channel: p[1], topic: p[2] || '', initial: true });
        break;
      }
      case '353': {
        const name = p[2];
        this._names = this._names || new Map();
        const key = lc(name);
        if (!this._names.has(key)) this._names.set(key, new Map());
        const users = this._names.get(key);
        for (let tok of (p[3] || '').split(' ').filter(Boolean)) {
          let modes = '';
          while (tok && this.prefixSyms.includes(tok[0])) {
            const idx = this.prefixSyms.indexOf(tok[0]);
            modes += this.prefixModes[idx] || '';
            tok = tok.slice(1);
          }
          let nick = tok;
          const bang = tok.indexOf('!');
          if (bang > 0) { nick = tok.slice(0, bang); this.hosts.set(lc(nick), tok.slice(bang + 1)); }
          users.set(lc(nick), { nick, modes: [...this.prefixModes].filter(m => modes.includes(m)).join('') });
        }
        break;
      }
      case '366': {
        const key = lc(p[1]);
        const users = this._names && this._names.get(key);
        if (this._names) this._names.delete(key);
        const ch = this.channels.get(key);
        if (ch && users) { ch.users = users; this._touch(ch); }
        this.emit('names', { channel: p[1], users: users ? [...users.values()] : [], joined: !!ch });
        break;
      }
      case '433': case '432': case '436':
        if (!this.registered) {
          this._wantedNick += '_';
          this.sendNow('NICK', this._wantedNick);
          this.nick = this._wantedNick;
        }
        break;
      case '900': break;
      case '903':
        this._sasl = false;
        this.emit('sasl', { ok: true });
        this._maybeEnd();
        break;
      case '902': case '904': case '905': case '906': case '907':
        this._sasl = false;
        this.emit('sasl', { ok: false, message: p[p.length - 1] || cmd });
        this._maybeEnd();
        break;
      default:
    }
    this.emit('numeric', { code: cmd, params: p, prefix: msg.prefix });
  }
}

module.exports = { IRCConnection, parseLine, formatLine, parsePrefix, splitMessage, lc };
