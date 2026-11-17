#!/usr/bin/env node
'use strict';
// Zirc - a terminal IRC client with mIRC-style scripting (in JavaScript).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { IRCConnection, lc } = require('./lib/irc');
const fmt = require('./lib/fmt');
const { ScriptEngine } = require('./lib/script');

const VERSION = '0.1.0';
const HOME = process.env.ZIRC_HOME || path.join(os.homedir(), '.zirc');
const CONFIG_FILE = path.join(HOME, 'config.json');
const MAX_LINES = 5000;
const NICK_COLORS = [3, 4, 6, 7, 8, 9, 10, 11, 12, 13];
const GREY = '\x0314', RED = '\x0304', GREEN = '\x0303', PURPLE = '\x0306', RESET = '\x0f';

const two = n => String(n).padStart(2, '0');
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const take = s => { s = String(s).trim(); const i = s.search(/\s/); return i < 0 ? [s, ''] : [s.slice(0, i), s.slice(i).trim()]; };
function nickColor(nick) { let h = 0; for (const ch of nick) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return NICK_COLORS[h % NICK_COLORS.length]; }
const cnick = nick => `\x03${two(nickColor(nick))}${nick}${RESET}`;
const wildRe = pat => new RegExp('^' + pat.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');
function dur(s) {
  s = Math.floor(+s);
  const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60);
  return [d && d + 'd', h && h + 'h', m && m + 'm', (s % 60) + 's'].filter(Boolean).join(' ');
}

// ---------------------------------------------------------------- config
function defaultNick() {
  let n = 'zirc';
  try { n = os.userInfo().username || n; } catch { /* ignore */ }
  n = n.replace(/[^A-Za-z0-9_\-[\]\\`^{|}]/g, '').slice(0, 15) || 'zirc';
  return /^[A-Za-z_[\]\\`^{|}]/.test(n) ? n : 'z' + n;
}

const defaultConfig = () => ({
  nick: defaultNick(), user: 'zirc', realname: 'Zirc IRC client',
  timestamp: 'HH:MM', bell: true, logging: true, joinParts: true, showMotd: false, nicklistWidth: 18,
  highlights: [], ignore: [],
  aliases: { ns: '/msg NickServ $*', cs: '/msg ChanServ $*' },
  servers: {
    libera: { host: 'irc.libera.chat', port: 6697, tls: true, autojoin: [], autoconnect: false },
    oftc: { host: 'irc.oftc.net', port: 6697, tls: true, autojoin: [], autoconnect: false },
  },
});

function loadConfig() {
  const def = defaultConfig();
  let user = {}, error = null, first = false;
  try {
    user = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') first = true; else error = `Could not read ${CONFIG_FILE}: ${e.message}`;
  }
  const cfg = Object.assign({}, def, user);
  cfg.servers = Object.assign({}, def.servers, user.servers);
  cfg.aliases = Object.assign({}, def.aliases, user.aliases);
  if (first) {
    try { fs.mkdirSync(HOME, { recursive: true }); fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), { mode: 0o600 }); } catch { /* ignore */ }
  }
  return { cfg, error, first };
}

// ---------------------------------------------------------------- keys
function csiKey(p, f) {
  const nums = p.split(';').map(Number);
  const mod = nums.length > 1 ? nums[1] - 1 : 0;
  const k = { ctrl: !!(mod & 4), alt: !!(mod & 2), shift: !!(mod & 1) };
  const map = { A: 'up', B: 'down', C: 'right', D: 'left', H: 'home', F: 'end' };
  if (f === '~') k.name = { 1: 'home', 7: 'home', 4: 'end', 8: 'end', 3: 'delete', 5: 'pageup', 6: 'pagedown' }[nums[0]] || 'unknown';
  else k.name = map[f] || 'unknown';
  return k;
}

function charKey(c) {
  const code = c.codePointAt(0);
  if (c === '\r' || c === '\n') return { name: 'enter' };
  if (c === '\t') return { name: 'tab' };
  if (c === '\x7f' || c === '\b') return { name: 'backspace' };
  if (code < 32) return { ctrl: true, name: code === 31 ? '_' : String.fromCharCode(code + 96) };
  return { char: c };
}

function parseKeys(s, state) {
  const out = [];
  let i = 0;
  while (i < s.length) {
    if (state.paste !== null) {
      const e = s.indexOf('\x1b[201~', i);
      if (e < 0) { state.paste += s.slice(i); return out; }
      state.paste += s.slice(i, e);
      out.push({ paste: state.paste });
      state.paste = null;
      i = e + 6;
      continue;
    }
    if (s[i] === '\x1b') {
      const rest = s.slice(i);
      let m;
      if (rest.startsWith('\x1b[200~')) { state.paste = ''; i += 6; continue; }
      if ((m = /^\x1b\[([0-9;]*)([A-Za-z~])/.exec(rest))) { out.push(csiKey(m[1], m[2])); i += m[0].length; continue; }
      if ((m = /^\x1bO([A-Za-z])/.exec(rest))) { out.push(csiKey('', m[1])); i += 3; continue; }
      if (rest.length > 1) {
        const c = String.fromCodePoint(rest.codePointAt(1));
        out.push({ ...charKey(c), alt: true });
        i += 1 + c.length;
        continue;
      }
      out.push({ name: 'escape' });
      i++;
      continue;
    }
    const c = String.fromCodePoint(s.codePointAt(i));
    out.push(charKey(c));
    i += c.length;
  }
  return out;
}

// ---------------------------------------------------------------- windows & sessions
class Window {
  constructor(session, name, type) {
    this.session = session; this.name = name; this.type = type;
    this.lines = []; this.unread = 0; this.hl = false; this.scroll = 0;
    this.spoke = new Map(); this.nickCache = null;
  }
  get chan() {
    return this.type === 'channel' && this.session && this.session.conn
      ? this.session.conn.channels.get(lc(this.name)) || null : null;
  }
}

class Session {
  constructor(app, scfg) {
    this.app = app;
    this.windows = new Map();
    this.userJoin = new Map();
    this.attach(scfg);
    this.status = app.addWindow(this, scfg.name, 'status');
  }

  attach(scfg) {
    if (this.conn) { this.conn.removeAllListeners(); this.conn.disconnect('Changing server'); }
    this.cfg = scfg;
    this.name = scfg.name;
    if (this.status) this.status.name = scfg.name;
    this.conn = new IRCConnection({
      host: scfg.host, port: scfg.port, tls: scfg.tls, nick: scfg.nick, user: scfg.user, realname: scfg.realname,
      password: scfg.password || null,
      sasl: scfg.sasl ? { user: scfg.sasl.user, pass: scfg.sasl.pass || process.env[scfg.sasl.passEnv || ''] } : null,
      version: 'Zirc ' + VERSION, rejectUnauthorized: scfg.rejectUnauthorized !== false,
    });
    this._wire();
  }

  openWindow(name, type) {
    let w = this.windows.get(lc(name));
    if (!w) { w = this.app.addWindow(this, name, type); this.windows.set(lc(name), w); }
    return w;
  }

  // Fire a script event; returns false if a script halted it.
  fire(name, data, win) {
    const app = this.app, self = this;
    const ev = Object.assign({ event: name, server: this.name, me: this.conn.nick }, data);
    ev.window = win ? win.name : null;
    ev.reply = text => app.sayTo(self, ev.channel || ev.nick, text);
    ev.say = (target, text) => app.sayTo(self, target, text);
    ev.echo = text => app.print(win || self.status, String(text));
    ev.send = raw => self.conn.raw(raw);
    ev.command = line => app.runLine(line, win || self.status);
    return app.engine.emit(name, ev);
  }

  _wire() {
    const c = this.conn, app = this.app;
    const st = text => app.print(this.status, text, { act: false });
    c.on('connecting', e => st(`${GREY}*** Connecting to ${e.host}:${e.port}${e.tls ? ' (TLS)' : ''}...`));
    c.on('connected', () => st(`${GREY}*** Connected. Logging in...`));
    c.on('socketerror', e => st(`${RED}*** Connection error: ${e.message}`));
    c.on('disconnected', e => this._disconnected(e));
    c.on('reconnecting', e => st(`${GREY}*** Reconnecting in ${Math.round(e.delay / 1000)}s (attempt ${e.attempt})...`));
    c.on('registered', e => this._registered(e));
    c.on('sasl', e => st(e.ok ? `${GREEN}*** SASL authentication successful` : `${RED}*** SASL authentication failed: ${e.message}`));
    c.on('servererror', e => st(`${RED}*** Server error: ${e.message}`));
    c.on('lag', () => app.dirty());
    c.on('internalerror', e => st(`${RED}*** internal error: ${e.stack || e.message}`));
    c.on('names', () => app.dirty());
    c.on('raw', m => app.engine.emit('raw', {
      event: 'raw', server: this.name, line: m.raw, command: m.command, params: m.params, prefix: m.prefix, tags: m.tags,
    }));
    c.on('message', m => this._message(m));
    c.on('ctcp', e => {
      const w = app.cur.session === this ? app.cur : this.status;
      if (this.fire('ctcp', { nick: e.from.nick, command: e.command, args: e.args, target: e.target }, w) === false) return;
      app.print(w, `${GREY}[CTCP ${e.command}${e.args ? ' ' + e.args : ''} from ${e.from.nick}]`, { act: false });
    });
    c.on('ctcpreply', e => {
      const w = app.cur.session === this ? app.cur : this.status;
      let a = e.args;
      if (e.command === 'PING' && /^\d{9,}$/.test(a)) a = ((Date.now() - +a) / 1000).toFixed(2) + 's';
      app.print(w, `${GREY}[${e.from.nick} ${e.command} reply]: ${a}`, { act: false });
    });
    c.on('join', e => this._join(e));
    c.on('part', e => {
      const win = this.windows.get(lc(e.channel));
      if (!win) return;
      const ok = this.fire('part', { nick: e.who.nick, user: e.who.user, host: e.who.host, channel: e.channel, reason: e.reason, self: e.self }, win);
      if (e.self) { app.removeWindow(win); return; }
      if (ok && app.cfg.joinParts) {
        app.print(win, `${RED}<--${RESET} ${cnick(e.who.nick)} (${e.who.user}@${e.who.host}) has left ${e.channel}${e.reason ? ` (${e.reason})` : ''}`, { act: false, time: e.time });
      }
    });
    c.on('kick', e => {
      const win = this.windows.get(lc(e.channel));
      if (!win) return;
      const ok = this.fire('kick', { nick: e.who.nick, victim: e.victim, channel: e.channel, reason: e.reason, self: e.self }, win);
      if (!ok) return;
      app.print(win, e.self
        ? `${RED}<--${RESET} You were kicked from ${e.channel} by ${cnick(e.who.nick)}${e.reason ? ` (${e.reason})` : ''}`
        : `${RED}<--${RESET} ${cnick(e.victim)} was kicked by ${cnick(e.who.nick)}${e.reason ? ` (${e.reason})` : ''}`, { act: false, time: e.time });
    });
    c.on('quit', e => {
      const ok = this.fire('quit', { nick: e.who.nick, user: e.who.user, host: e.who.host, reason: e.reason, channels: e.channels }, null);
      if (!ok || !app.cfg.joinParts) return;
      for (const ch of e.channels) {
        const w = this.windows.get(lc(ch));
        if (w) app.print(w, `${RED}<--${RESET} ${cnick(e.who.nick)} (${e.who.user}@${e.who.host}) has quit${e.reason ? ` (${e.reason})` : ''}`, { act: false, time: e.time });
      }
      const q = this.windows.get(lc(e.who.nick));
      if (q && q.type === 'query') app.print(q, `${RED}<--${RESET} ${cnick(e.who.nick)} has quit${e.reason ? ` (${e.reason})` : ''}`, { act: false });
    });
    c.on('nick', e => {
      const old = e.who.nick;
      const ok = this.fire('nick', { nick: old, user: e.who.user, host: e.who.host, newNick: e.newNick, self: e.self, channels: e.channels }, null);
      if (!ok) return;
      const text = e.self ? `${GREY}*** You are now known as ${cnick(e.newNick)}` : `${GREY}***${RESET} ${cnick(old)} is now known as ${cnick(e.newNick)}`;
      for (const ch of e.channels) { const w = this.windows.get(lc(ch)); if (w) app.print(w, text, { act: false, time: e.time }); }
      const q = this.windows.get(lc(old));
      if (q && q.type === 'query' && !this.windows.has(lc(e.newNick))) {
        this.windows.delete(lc(old));
        q.name = e.newNick;
        this.windows.set(lc(e.newNick), q);
        app.print(q, text, { act: false });
      }
      if (e.self) app.print(this.status, text, { act: false });
    });
    c.on('topic', e => {
      const win = this.windows.get(lc(e.channel)) || this.status;
      if (e.who && this.fire('topic', { nick: e.who.nick, channel: e.channel, topic: e.topic }, win) === false) return;
      app.print(win, e.who
        ? `${GREY}***${RESET} ${cnick(e.who.nick)} changed the topic to: ${e.topic}`
        : `${GREY}*** Topic for ${e.channel}:${RESET} ${e.topic}`, { act: false });
    });
    c.on('mode', e => {
      const win = this.windows.get(lc(e.target)) || this.status;
      const ok = this.fire('mode', { nick: e.who.nick, target: e.target, channel: e.target, modes: e.modestr, changes: e.changes }, win);
      if (ok) app.print(win, `${GREY}*** ${e.who.nick || 'server'} sets mode: ${e.modestr}`, { act: false });
    });
    c.on('usermode', e => app.print(this.status, `${GREY}*** Mode ${e.target} ${e.modestr}`, { act: false }));
    c.on('invite', e => {
      if (this.fire('invite', { nick: e.who.nick, channel: e.channel }, null) === false) return;
      app.print(app.cur.session === this ? app.cur : this.status, `${GREEN}***${RESET} ${cnick(e.who.nick)} invites you to ${e.channel}`, { act: false });
    });
    c.on('numeric', e => this._numeric(e));
  }

  _registered(e) {
    const app = this.app;
    app.print(this.status, `${GREEN}*** Logged in as ${e.nick}${this.conn.network ? ' on ' + this.conn.network : ''}`, { act: false });
    for (const line of this.cfg.perform || []) app.runLine(line, this.status);
    if (!e.reconnect) {
      const aj = [].concat(this.cfg.autojoin || []).filter(Boolean);
      if (aj.length) this.conn.join(aj.join(','));
    }
    this.fire('connect', { reconnect: e.reconnect }, this.status);
    app.dirty();
  }

  _disconnected(e) {
    const app = this.app;
    const text = `${RED}*** Disconnected (${e.reason})`;
    app.print(this.status, text, { act: false });
    for (const w of this.windows.values()) if (w.type === 'channel') app.print(w, text, { act: false });
    this.fire('disconnect', { reason: e.reason }, this.status);
    app.dirty();
  }

  _join(e) {
    const app = this.app, chan = e.channel;
    if (e.self) {
      const win = this.openWindow(chan, 'channel');
      const t = this.userJoin.get(lc(chan));
      const recent = t && Date.now() - t < 10000;
      const first = app.cur.session === this && app.cur.type === 'status' &&
        ![...this.windows.values()].some(w => w.type === 'channel' && w !== win);
      if (recent || first) app.switchTo(win);
      this.fire('join', { nick: e.who.nick, user: e.who.user, host: e.who.host, channel: chan, self: true }, win);
      app.print(win, `${GREEN}-->${RESET} You have joined ${chan}`, { act: false, time: e.time });
      return;
    }
    const win = this.windows.get(lc(chan));
    if (!win) return;
    const ok = this.fire('join', { nick: e.who.nick, user: e.who.user, host: e.who.host, channel: chan, self: false, account: e.account }, win);
    if (ok && app.cfg.joinParts) {
      app.print(win, `${GREEN}-->${RESET} ${cnick(e.who.nick)} (${e.who.user}@${e.who.host}) has joined ${chan}`, { act: false, time: e.time });
    }
  }

  _message(m) {
    const app = this.app, c = this.conn, from = m.from;
    if (!m.self && !from.server && app.isIgnored(from)) return;
    const chan = m.isChannel ? c.chanName(m.target) : null;
    let win;
    if (chan) win = this.windows.get(lc(chan)) || this.status;
    else if (m.type === 'notice') win = (from.server || !from.nick) ? this.status : (app.cur.session === this ? app.cur : this.status);
    else win = this.openWindow(from.nick, 'query');
    const hl = chan ? app.isHighlight(this, m.text) : (m.type !== 'notice' && !from.server);
    const ok = this.fire(m.type === 'privmsg' ? 'text' : m.type, {
      nick: from.nick, user: from.user, host: from.host, target: m.target, channel: chan,
      text: m.text, isChannel: !!chan, isPrivate: !chan, highlight: hl, time: m.time,
    }, win);
    if (!ok) return;
    if (chan && m.type !== 'notice') win.spoke.set(lc(from.nick), Date.now());
    const pfx = chan ? c.userPrefix(chan, from.nick) : '';
    let text;
    if (m.type === 'privmsg') text = `<${pfx}${cnick(from.nick)}> ${m.text}`;
    else if (m.type === 'action') text = `${PURPLE}*${RESET} ${pfx}${cnick(from.nick)} ${m.text}`;
    else text = `${PURPLE}-${from.nick}${chan ? ':' + chan : ''}-${RESET} ${m.text}`;
    app.print(win, text, { hl, time: m.time });
  }

  _numeric({ code, params: p }) {
    const app = this.app;
    const act = app.cur.session === this ? app.cur : this.status;
    const out = (t, w = act) => app.print(w, t, { act: false });
    const rest = p.slice(1).join(' ');
    switch (code) {
      case '001': out(`${GREY}*** ${p[1]}`, this.status); break;
      case '002': case '003': case '004': case '005': case '315': case '318': case '321': case '323': case '329':
      case '332': case '353': case '366': case '369': case '375': case '376': case '900': case '903': break;
      case '251': case '252': case '253': case '254': case '255': case '265': case '266':
      case '372': case '377': case '378':
        if (app.cfg.showMotd) out(`${GREY}${rest}`, this.status);
        break;
      case '301': out(`${GREY}*** ${p[1]} is away: ${p[2]}`); break;
      case '305': case '306': out(`${GREY}*** ${p[1]}`); break;
      case '311': out(`${GREY}[whois]${RESET} ${cnick(p[1])} is ${p[2]}@${p[3]} (${p[5]})`); break;
      case '314': out(`${GREY}[whowas]${RESET} ${cnick(p[1])} was ${p[2]}@${p[3]} (${p[5]})`); break;
      case '312': out(`${GREY}[whois]${RESET} ${cnick(p[1])} using ${p[2]} (${p[3]})`); break;
      case '313': out(`${GREY}[whois]${RESET} ${cnick(p[1])} ${p[2]}`); break;
      case '317': out(`${GREY}[whois]${RESET} ${cnick(p[1])} idle ${dur(p[2])}${p[3] ? ', signed on ' + new Date(+p[3] * 1000).toLocaleString() : ''}`); break;
      case '319': out(`${GREY}[whois]${RESET} ${cnick(p[1])} on ${p[2]}`); break;
      case '330': out(`${GREY}[whois]${RESET} ${cnick(p[1])} is logged in as ${p[2]}`); break;
      case '322': out(`${GREY}[list]${RESET} ${p[1]} (${p[2]}) ${p[3] || ''}`); break;
      case '324': out(`${GREY}*** Modes for ${p[1]}: ${p.slice(2).join(' ')}`); break;
      case '333': out(`${GREY}*** Topic set by ${p[2]} on ${new Date(+p[3] * 1000).toLocaleString()}`, this.windows.get(lc(p[1])) || act); break;
      case '352': out(`${GREY}[who]${RESET} ${p[5]} (${p[2]}@${p[3]}) [${p[1]}] ${p[7] || ''}`); break;
      default:
        if (/^[45]/.test(code)) out(`${RED}*** ${rest}`);
        else out(`${GREY}${rest}`, this.status);
    }
  }
}

// ---------------------------------------------------------------- commands
const COMMANDS = {};
const CMD_ALIASES = {
  j: 'join', leave: 'part', exit: 'quit', q: 'query', m: 'msg', k: 'kick', t: 'topic', w: 'whois',
  n: 'names', win: 'window', quote: 'raw', kb: 'kickban',
};
function cmd(name, usage, fn) { COMMANDS[name] = { usage, fn }; }

// ---------------------------------------------------------------- app
class App {
  constructor(cfg, cfgError) {
    this.cfg = cfg;
    this.cfgReadOnly = !!cfgError;
    this.cfgError = cfgError;
    this.windows = [];
    this.cur = null;
    this.sessions = [];
    this.buf = [];
    this.pos = 0;
    this.hist = [];
    this.hi = -1;
    this.draft = '';
    this.tab = null;
    this.timers = new Map();
    this.logfds = new Map();
    this.kstate = { paste: null };
    this.lastCtrlC = 0;
    this.lastBell = 0;
    this.drawQueued = false;
    this.depth = 0;
    this.engine = new ScriptEngine(this._scriptHost());
    this.rebuildIgnore();
  }

  // ---- script host
  _scriptHost() {
    const app = this;
    return {
      version: VERSION, home: HOME, storeDir: path.join(HOME, 'store'),
      echo(text, where) { app.print(where ? app.findWindow(where) || app.cur : app.cur, text, { act: false }); },
      error(name, err) {
        const lines = String(err && err.stack ? err.stack : err).split('\n').slice(0, 3);
        for (const l of lines) app.print(app.cur, `${RED}[script ${name}] ${l.trim()}`, { act: false });
      },
      say(target, text, server) { const s = app.pickSession(server); return s ? app.sayTo(s, target, text) : false; },
      action(target, text, server) { const s = app.pickSession(server); return s ? app.sayTo(s, target, text, true) : false; },
      notice(target, text, server) {
        const s = app.pickSession(server);
        if (!s || !s.conn.connected) return false;
        s.conn.notice(target, text);
        return true;
      },
      send(raw, server) { const s = app.pickSession(server); return s ? s.conn.raw(raw) : false; },
      runLine(line) { app.runLine(line, app.cur); },
      info(server) {
        const s = app.pickSession(server);
        if (!s) return null;
        return {
          nick: s.conn.nick, connected: s.conn.connected,
          channels: [...s.conn.channels.values()].map(c => c.name),
          users: chan => { const ch = s.conn.channels.get(lc(chan)); return ch ? [...ch.users.values()].map(u => u.nick) : []; },
        };
      },
    };
  }

  findSession(name) { return name ? this.sessions.find(s => lc(s.name) === lc(name)) || null : null; }
  pickSession(name) { return this.findSession(name) || (this.cur && this.cur.session) || this.sessions[0] || null; }
  findWindow(where) {
    const w = lc(where);
    return this.windows.find(x => lc(x.name) === w) || null;
  }

  // ---- windows
  addWindow(session, name, type) {
    const w = new Window(session, name, type);
    this.windows.push(w);
    if (!this.cur) this.cur = w;
    this.dirty();
    return w;
  }
  removeWindow(w) {
    const i = this.windows.indexOf(w);
    if (i < 0) return;
    this.windows.splice(i, 1);
    if (w.session) w.session.windows.delete(lc(w.name));
    if (this.cur === w) this.switchTo(this.windows[Math.max(0, i - 1)]);
    this.dirty();
  }
  switchTo(w) {
    if (!w) return;
    this.cur = w;
    w.unread = 0; w.hl = false; w.scroll = 0;
    this.tab = null;
    this.dirty();
  }
  gotoWindow(i) { if (this.windows[i]) this.switchTo(this.windows[i]); }
  stepWindow(d) {
    const n = this.windows.length;
    this.switchTo(this.windows[(this.windows.indexOf(this.cur) + d + n) % n]);
  }

  // ---- printing
  stamp(d) {
    const f = this.cfg.timestamp;
    return f ? String(f).replace('HH', two(d.getHours())).replace('MM', two(d.getMinutes())).replace('SS', two(d.getSeconds())) : '';
  }

  print(win, text, opts = {}) {
    win = win || this.cur;
    if (!win) return;
    const d = opts.time || new Date();
    const ts = this.stamp(d);
    const line = { text: (ts ? `${GREY}[${ts}]${RESET} ` : '') + text, indent: ts ? ts.length + 3 : 0, hl: !!opts.hl, time: d };
    win.lines.push(line);
    if (win.lines.length > MAX_LINES) win.lines.splice(0, 500);
    if (win === this.cur) {
      if (win.scroll > 0 && this.ttyReady) win.scroll += this.rowsOf(line, this.layout(win).mw).length;
    } else if (opts.act !== false) {
      win.unread++;
      if (opts.hl) win.hl = true;
    }
    if (opts.hl && win !== this.cur && this.cfg.bell && Date.now() - this.lastBell > 1000 && this.ttyReady) {
      this.lastBell = Date.now();
      process.stdout.write('\x07');
    }
    this.log(win, d, text);
    this.dirty();
  }

  log(win, d, text) {
    if (!this.cfg.logging || !win.session || this.logDisabled) return;
    try {
      const safe = s => String(s).toLowerCase().replace(/[^\w#&+.-]/g, '_').replace(/^\.+/, '_');
      const file = path.join(HOME, 'logs', safe(win.session.name), safe(win.type === 'status' ? 'status' : win.name) + '.log');
      let fd = this.logfds.get(file);
      if (fd === undefined) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fd = fs.openSync(file, 'a', 0o600);
        this.logfds.set(file, fd);
      }
      const p = `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
      fs.writeSync(fd, `[${p}] ${fmt.strip(text)}\n`);
    } catch (e) {
      this.logDisabled = true;
      this.print(win, `${RED}*** Logging disabled: ${e.message}`, { act: false });
    }
  }

  sayTo(session, target, text, action = false) {
    if (!session || !session.conn.connected || !target) return false;
    const c = session.conn;
    const sent = action ? c.action(target, text) : c.say(target, text);
    const win = session.windows.get(lc(c.chanName(target)));
    for (const chunk of sent) {
      if (win) {
        const pfx = win.type === 'channel' ? c.userPrefix(win.name, c.nick) : '';
        this.print(win, action ? `${PURPLE}*${RESET} ${pfx}${cnick(c.nick)} ${chunk}` : `<${pfx}${cnick(c.nick)}> ${chunk}`, { act: false });
      } else {
        const w = this.cur.session === session ? this.cur : session.status;
        this.print(w, `${GREY}->${RESET} ${action ? '* ' : ''}[${target}] ${chunk}`, { act: false });
      }
    }
    return true;
  }

  // ---- filters
  rebuildIgnore() { this.ignoreRe = (this.cfg.ignore || []).map(wildRe); }
  isIgnored(from) { const m = `${from.nick}!${from.user}@${from.host}`; return this.ignoreRe.some(r => r.test(m)); }
  isHighlight(session, text) {
    const plain = fmt.strip(text).toLowerCase();
    return [session.conn.nick, ...(this.cfg.highlights || [])].filter(Boolean).some(w =>
      new RegExp('(^|[^\\w])' + escapeRe(w.toLowerCase()) + '($|[^\\w])').test(plain));
  }

  saveConfig() {
    if (this.cfgReadOnly) { this.print(this.cur, `${RED}*** Config not saved: the existing config file could not be read.`); return; }
    try { fs.mkdirSync(HOME, { recursive: true }); fs.writeFileSync(CONFIG_FILE, JSON.stringify(this.cfg, null, 2), { mode: 0o600 }); }
    catch (e) { this.print(this.cur, `${RED}*** Could not save config: ${e.message}`); }
  }

  // ---- sessions
  resolveServer(tok, portTok, tlsFlag) {
    const base = this.cfg.servers[tok] || this.cfg.servers[tok.toLowerCase()];
    let scfg;
    if (base) {
      scfg = { name: tok, ...base };
      if (tlsFlag !== undefined) scfg.tls = tlsFlag;
    } else {
      let host = tok, port = portTok ? +portTok : null;
      const m = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(tok);
      if (m) { host = m[1]; port = +m[2]; }
      host = host.replace(/^\[|\]$/g, '');
      let tls = tlsFlag;
      if (tls === undefined) tls = port === null || [6697, 6698, 7000, 7070].includes(port);
      if (port === null) port = tls ? 6697 : 6667;
      scfg = { name: host, host, port, tls };
    }
    return Object.assign({ nick: this.cfg.nick, user: this.cfg.user, realname: this.cfg.realname }, scfg);
  }

  newSession(scfg) {
    const taken = n => this.sessions.some(s => lc(s.name) === lc(n));
    while (taken(scfg.name)) scfg.name += '_';
    const s = new Session(this, scfg);
    this.sessions.push(s);
    return s;
  }

  // ---- terminal
  enterTerm() {
    process.stdin.setRawMode(true);
    process.stdin.setEncoding('utf8');
    process.stdin.resume();
    process.stdin.on('data', d => this.onData(d));
    process.stdout.write('\x1b[?1049h\x1b[?2004h\x1b[2J');
    process.stdout.on('resize', () => { process.stdout.write('\x1b[2J'); this.dirty(); });
    this.ttyReady = true;
  }
  leaveTerm() {
    if (!this.ttyReady) return;
    this.ttyReady = false;
    process.stdout.write('\x1b[0m\x1b[?2004l\x1b[?25h\x1b[?1049l');
    try { process.stdin.setRawMode(false); } catch { /* ignore */ }
  }

  dirty() {
    if (this.drawQueued) return;
    this.drawQueued = true;
    setTimeout(() => { this.drawQueued = false; this.draw(); }, 16);
  }

  layout(win) {
    const W = process.stdout.columns || 80, H = process.stdout.rows || 24;
    const showNicks = !!(win && win.type === 'channel' && W >= 60);
    const nw = showNicks ? Math.max(10, Math.min(this.cfg.nicklistWidth || 18, Math.floor(W / 3))) : 0;
    return { W, H, showNicks, nw, mw: W - (showNicks ? nw + 1 : 0), mh: Math.max(1, H - 3) };
  }

  rowsOf(line, W) {
    if (line.rc && line.rc.W === W) return line.rc.rows;
    let cells = fmt.parse(line.text);
    if (line.hl) cells = cells.map(c => ({ ...c, st: { ...c.st, b: 1 } }));
    const rows = fmt.wrap(cells, W, line.indent);
    line.rc = { W, rows };
    return rows;
  }

  visibleRows(win, W, H) {
    const lines = win.lines;
    const need = H + win.scroll;
    const blocks = [];
    let i = lines.length, count = 0;
    while (i > 0 && count < need) { const r = this.rowsOf(lines[--i], W); blocks.push(r); count += r.length; }
    const all = [];
    for (let k = blocks.length - 1; k >= 0; k--) for (const r of blocks[k]) all.push(r);
    if (i === 0 && all.length - H < win.scroll) win.scroll = Math.max(0, all.length - H);
    const end = all.length - win.scroll;
    return all.slice(Math.max(0, end - H), end);
  }

  nickList(win) {
    const ch = win.chan;
    if (!ch) return [];
    if (win.nickCache && win.nickCache.ch === ch && win.nickCache.ver === ch.ver) return win.nickCache.list;
    const modes = win.session.conn.prefixModes;
    const rank = u => { const i = [...modes].findIndex(m => u.modes.includes(m)); return i < 0 ? 99 : i; };
    const list = [...ch.users.values()].sort((a, b) => rank(a) - rank(b) || lc(a.nick).localeCompare(lc(b.nick)));
    win.nickCache = { ch, ver: ch.ver, list };
    return list;
  }

  topicText(win) {
    if (win.type === 'channel') return win.chan ? ` ${win.name}: ${win.chan.topic || '(no topic)'}` : ` ${win.name}`;
    if (win.type === 'query') return ` Query with ${win.name}`;
    if (win.session) {
      const c = win.session.conn;
      return ` ${win.session.name}${c.network ? ' (' + c.network + ')' : ''} - ${c.connected ? 'connected as ' + c.nick : c.connecting ? 'connecting...' : 'disconnected'}`;
    }
    return ` Zirc ${VERSION}`;
  }

  draw() {
    if (!this.ttyReady || !this.cur) return;
    const win = this.cur;
    const { W, H, showNicks, nw, mw, mh } = this.layout(win);
    let s = '\x1b[?2026h\x1b[?25l';
    s += '\x1b[1;1H\x1b[7m' + fmt.fitPlain(this.topicText(win), W) + '\x1b[0m';
    const rows = this.visibleRows(win, mw, mh);
    const nicks = showNicks ? this.nickList(win) : [];
    const conn = win.session && win.session.conn;
    const symColor = { '@': '\x0309', '+': '\x0308', '%': '\x0311', '&': '\x0304', '~': '\x0313' };
    for (let i = 0; i < mh; i++) {
      s += `\x1b[${i + 2};1H`;
      if (rows[i]) s += fmt.render(rows[i]);
      s += '\x1b[K';
      if (showNicks) {
        s += `\x1b[${i + 2};${mw + 1}H\x1b[0m\x1b[90m│\x1b[0m`;
        let cells = [];
        if (i === 0) cells = fmt.parse(`${GREY}${nicks.length} users`);
        else if (nicks[i - 1]) {
          const u = nicks[i - 1], p = conn.userPrefix(win.name, u.nick);
          cells = fmt.parse(`${p ? (symColor[p] || GREY) + p + RESET : ''}${cnick(u.nick)}`);
        }
        s += fmt.render(fmt.fit(cells, nw));
      }
    }
    // status bar
    const idx = this.windows.indexOf(win) + 1;
    const act = this.windows.map((w, i) => (w !== win && w.unread ? `${i + 1}${w.hl ? '!' : ''}` : null)).filter(Boolean);
    const d = new Date();
    let bar = ` [${two(d.getHours())}:${two(d.getMinutes())}] [${conn ? conn.nick : '-'}] [${idx}:${win.name}]`;
    if (act.length) bar += ` [Act: ${act.join(',')}]`;
    if (conn && conn.lag != null && conn.connected) bar += ` [lag ${conn.lag.toFixed(1)}s]`;
    if (win.scroll) bar += ` [scrolled -${win.scroll}]`;
    if (conn && !conn.connected) bar += conn.connecting ? ' [connecting]' : ' [offline]';
    s += `\x1b[${H - 1};1H\x1b[7m${fmt.fitPlain(bar, W)}\x1b[0m`;
    // input line
    let pname = win.name;
    if (fmt.strWidth(pname) > Math.floor(W / 3)) pname = Array.from(pname).slice(0, Math.max(3, Math.floor(W / 3) - 1)).join('') + '~';
    const prompt = `[${pname}] `;
    const pw = fmt.strWidth(prompt);
    const avail = Math.max(2, W - pw - 1);
    const chars = this.buf;
    const wd = c => fmt.cw(c.codePointAt(0)) || 1;
    let total = 0;
    for (const c of chars) total += wd(c);
    let start = 0;
    if (total > avail - 1) {
      let acc = 0;
      start = this.pos;
      while (start > 0 && acc + wd(chars[start - 1]) <= avail - 1) { start--; acc += wd(chars[start]); }
    }
    const LET = { 2: 'B', 3: 'K', 4: 'H', 15: 'O', 22: 'R', 29: 'I', 30: 'S', 31: '_' };
    let seg = '', w = 0, curOff = 0;
    for (let i = start; i < chars.length; i++) {
      const c = chars[i], cwid = wd(c);
      if (w + cwid > avail) break;
      const code = c.codePointAt(0);
      seg += code < 32 ? `\x1b[7m${LET[code] || '?'}\x1b[27m` : c;
      w += cwid;
      if (i < this.pos) curOff = w;
    }
    s += `\x1b[${H};1H\x1b[0m\x1b[90m${prompt}\x1b[0m${seg}\x1b[K`;
    s += `\x1b[${H};${pw + 1 + curOff}H\x1b[?25h\x1b[?2026l`;
    process.stdout.write(s);
  }

  // ---- input
  onData(d) {
    for (const k of parseKeys(d, this.kstate)) {
      try { this.onKey(k); } catch (e) { this.print(this.cur, `${RED}*** key handler error: ${e.message}`, { act: false }); }
    }
    this.dirty();
  }

  insert(str) {
    const arr = Array.from(str);
    if (this.buf.length + arr.length > 4096) return;
    this.buf.splice(this.pos, 0, ...arr);
    this.pos += arr.length;
  }
  setInput(s) { this.buf = Array.from(s); this.pos = this.buf.length; }
  wordLeft() { let p = this.pos; while (p > 0 && this.buf[p - 1] === ' ') p--; while (p > 0 && this.buf[p - 1] !== ' ') p--; this.pos = p; }
  wordRight() { let p = this.pos; while (p < this.buf.length && this.buf[p] === ' ') p++; while (p < this.buf.length && this.buf[p] !== ' ') p++; this.pos = p; }
  delWordBack() { const e = this.pos; this.wordLeft(); this.buf.splice(this.pos, e - this.pos); }

  onKey(k) {
    if (k.paste !== undefined) { this.insert(k.paste.replace(/\r\n|\r|\n/g, ' ')); return; }
    if (!(k.name === 'tab' && !k.ctrl && !k.alt)) this.tab = null;
    if (k.alt) {
      const key = k.char || k.name;
      if (/^[1-9]$/.test(key)) return this.gotoWindow(+key - 1);
      switch (key) {
        case '0': return this.gotoWindow(9);
        case 'left': return this.stepWindow(-1);
        case 'right': return this.stepWindow(1);
        case 'b': return this.wordLeft();
        case 'f': return this.wordRight();
        case 'backspace': return this.delWordBack();
        default: return undefined;
      }
    }
    if (k.char) return this.insert(k.char);
    if (k.ctrl && k.name === 'left') return this.wordLeft();
    if (k.ctrl && k.name === 'right') return this.wordRight();
    if (k.ctrl && k.name && k.name.length === 1) {
      switch (k.name) {
        case 'c': {
          const now = Date.now();
          if (now - this.lastCtrlC < 1500) return this.shutdown('Zirc');
          this.lastCtrlC = now;
          return this.print(this.cur, `${GREY}*** Press Ctrl-C again to quit (or type /quit)`, { act: false });
        }
        case 'a': this.pos = 0; return undefined;
        case 'e': this.pos = this.buf.length; return undefined;
        case 'b': return this.insert('\x02');
        case 'k': return this.insert('\x03');
        case '_': return this.insert('\x1f');
        case 'o': return this.insert('\x0f');
        case 'r': return this.insert('\x16');
        case 't': return this.insert('\x1d');
        case 'u': this.buf.splice(0, this.pos); this.pos = 0; return undefined;
        case 'w': return this.delWordBack();
        case 'd': if (this.pos < this.buf.length) this.buf.splice(this.pos, 1); return undefined;
        case 'n': return this.stepWindow(1);
        case 'p': return this.stepWindow(-1);
        case 'l': process.stdout.write('\x1b[2J'); return undefined;
        default: return undefined;
      }
    }
    switch (k.name) {
      case 'enter': return this.submit();
      case 'tab': return this.doTab();
      case 'backspace': if (this.pos > 0) { this.buf.splice(this.pos - 1, 1); this.pos--; } return undefined;
      case 'delete': if (this.pos < this.buf.length) this.buf.splice(this.pos, 1); return undefined;
      case 'left': if (this.pos > 0) this.pos--; return undefined;
      case 'right': if (this.pos < this.buf.length) this.pos++; return undefined;
      case 'home': this.pos = 0; return undefined;
      case 'end': this.pos = this.buf.length; return undefined;
      case 'up': return this.histUp();
      case 'down': return this.histDown();
      case 'pageup': this.cur.scroll += Math.max(1, this.layout(this.cur).mh - 2); return undefined;
      case 'pagedown': this.cur.scroll = Math.max(0, this.cur.scroll - Math.max(1, this.layout(this.cur).mh - 2)); return undefined;
      default: return undefined;
    }
  }

  histUp() {
    if (!this.hist.length) return;
    if (this.hi === -1) { this.draft = this.buf.join(''); this.hi = this.hist.length; }
    if (this.hi > 0) { this.hi--; this.setInput(this.hist[this.hi]); }
  }
  histDown() {
    if (this.hi === -1) return;
    this.hi++;
    if (this.hi >= this.hist.length) { this.hi = -1; this.setInput(this.draft); } else this.setInput(this.hist[this.hi]);
  }

  commandNames() {
    return [...new Set([...Object.keys(COMMANDS), ...Object.keys(CMD_ALIASES), ...Object.keys(this.cfg.aliases || {}),
      ...this.engine.list().flatMap(s => s.aliases)])].sort();
  }

  doTab() {
    if (!this.tab) {
      const before = this.buf.slice(0, this.pos).join('');
      const word = /(\S*)$/.exec(before)[1];
      const start = this.pos - Array.from(word).length;
      const win = this.cur, wl = lc(word);
      let list = [], kind = 'nick';
      if (word.startsWith('/') && start === 0) {
        kind = 'cmd';
        list = this.commandNames().filter(c => c.startsWith(word.slice(1).toLowerCase())).map(c => '/' + c);
      } else if (win.session && word && win.session.conn.isChannel(word)) {
        kind = 'chan';
        list = [...win.session.conn.channels.values()].map(c => c.name).filter(n => lc(n).startsWith(wl));
      } else if (win.type === 'channel' && win.chan) {
        const me = lc(win.session.conn.nick);
        list = [...win.chan.users.values()].map(u => u.nick).filter(n => lc(n) !== me && lc(n).startsWith(wl));
        list.sort((a, b) => (win.spoke.get(lc(b)) || 0) - (win.spoke.get(lc(a)) || 0) || lc(a).localeCompare(lc(b)));
      } else if (win.type === 'query') {
        list = [win.name].filter(n => lc(n).startsWith(wl));
      }
      if (!list.length) return;
      this.tab = { start, list, i: -1, len: Array.from(word).length, kind, atStart: start === 0 };
    }
    const t = this.tab;
    t.i = (t.i + 1) % t.list.length;
    let cand = t.list[t.i];
    cand += t.kind === 'nick' && t.atStart ? ': ' : ' ';
    const arr = Array.from(cand);
    this.buf.splice(t.start, t.len, ...arr);
    this.pos = t.start + arr.length;
    t.len = arr.length;
  }

  submit() {
    const line = this.buf.join('');
    this.buf = []; this.pos = 0; this.hi = -1; this.tab = null;
    if (!line.trim()) return;
    if (this.hist[this.hist.length - 1] !== line) this.hist.push(line);
    if (this.hist.length > 200) this.hist.shift();
    this.runLine(line, this.cur);
  }

  // Process one line as if typed: command, or plain text for the window.
  runLine(line, win) {
    if (line.startsWith('//')) line = line.slice(1);
    else if (line[0] === '/') return this.runCommand(line, win);
    const s = win.session;
    if (win.type === 'status' || !s) { this.print(win, `${GREY}*** You're not in a channel or query. Try /join #channel or /query nick`, { act: false }); return undefined; }
    if (!s.conn.connected) { this.print(win, `${RED}*** Not connected to ${s.name}`, { act: false }); return undefined; }
    const ok = s.fire('input', { text: line, target: win.name, channel: win.type === 'channel' ? win.name : null, isChannel: win.type === 'channel' }, win);
    if (!ok) return undefined;
    this.sayTo(s, win.name, line);
    return undefined;
  }

  expandAlias(body, args, win) {
    const argv = args.split(/\s+/).filter(Boolean);
    const s = win.session;
    return body.replace(/\$(\d+)(-)?|\$\*|\$(nick|me|chan|server)\b/g, (m, n, dash, name) => {
      if (m === '$*') return args;
      if (n) return dash ? argv.slice(+n - 1).join(' ') : (argv[+n - 1] || '');
      if (name === 'nick' || name === 'me') return s ? s.conn.nick : '';
      if (name === 'chan') return win.type === 'channel' ? win.name : '';
      return s ? s.name : '';
    });
  }

  runCommand(line, win) {
    let body = line.slice(1), bypass = false;
    if (body.startsWith('.')) { bypass = true; body = body.slice(1); }
    const m = /^(\S+)\s*([\s\S]*)$/.exec(body);
    if (!m) return;
    const name = m[1].toLowerCase(), args = m[2].trim();
    if (this.depth > 5) { this.print(win, `${RED}*** Alias recursion too deep`, { act: false }); return; }
    this.depth++;
    try {
      if (!bypass) {
        const sa = this.engine.alias(name);
        if (sa) {
          const argv = args.split(/\s+/).filter(Boolean);
          const s = win.session;
          sa(args, {
            args, argv, window: win.name, server: s ? s.name : null, target: win.type === 'status' ? null : win.name,
            reply: t => (s && win.type !== 'status' ? this.sayTo(s, win.name, String(t)) : this.print(win, String(t), { act: false })),
            echo: t => this.print(win, String(t), { act: false }),
          });
          return;
        }
        const ua = this.cfg.aliases && this.cfg.aliases[name];
        if (ua) {
          for (const part of this.expandAlias(ua, args, win).split(/\s\|\s/)) this.runLine(part.trim(), win);
          return;
        }
      }
      const def = COMMANDS[CMD_ALIASES[name] || name];
      if (!def) { this.print(win, `${RED}*** Unknown command: /${name} (try /help)`, { act: false }); return; }
      try { def.fn.call(this, args, win); } catch (e) { this.print(win, `${RED}*** /${name} failed: ${e.message}`, { act: false }); }
    } finally { this.depth--; }
  }

  // Helpers for commands
  sess(win, needConn = true) {
    const s = win && win.session;
    if (!s) { this.print(win || this.cur, `${RED}*** Not connected to a server. Use /server <host>`, { act: false }); return null; }
    if (needConn && !s.conn.connected) { this.print(win, `${RED}*** Not connected to ${s.name}`, { act: false }); return null; }
    return s;
  }
  usage(win, name) { this.print(win, `${GREY}Usage: ${COMMANDS[name].usage}`, { act: false }); }
  info(win, text) { this.print(win, `${GREY}*** ${text}`, { act: false }); }

  shutdown(msg = 'Zirc', code = 0) {
    if (this.closing) return;
    this.closing = true;
    for (const s of this.sessions) { try { s.conn.disconnect(msg); } catch { /* ignore */ } }
    for (const t of this.timers.values()) clearInterval(t.id);
    this.engine.unloadAll();
    setTimeout(() => {
      this.leaveTerm();
      for (const fd of this.logfds.values()) { try { fs.closeSync(fd); } catch { /* ignore */ } }
      process.exit(code);
    }, 300);
  }

  start(args, firstRun) {
    this.enterTerm();
    const home = this.addWindow(null, 'zirc', 'status');
    const p = t => this.print(home, t, { act: false });
    p(`${GREEN}Welcome to Zirc ${VERSION}${RESET} - an IRC client with JavaScript scripting`);
    p(`  /server irc.libera.chat      connect (TLS on 6697 by default; -notls for plain)`);
    p(`  /join #channel   /msg nick hi   /help for all commands`);
    p(`  Alt-1..9 or Ctrl-N/Ctrl-P switch windows, PgUp/PgDn scroll, Tab completes nicks/commands`);
    p(`  Scripts: put .js files in ${path.join(HOME, 'scripts')} then /reload (see README)`);
    if (firstRun) p(`${GREY}  Created ${CONFIG_FILE} - set your nick, SASL login, servers and autojoin there.`);
    if (this.cfgError) p(`${RED}  ${this.cfgError} (config changes will not be saved)`);
    if (args.bad) p(`${RED}  Ignoring unknown option ${args.bad}`);
    const r = this.engine.loadDir(path.join(HOME, 'scripts'));
    if (r.loaded.length) p(`${GREY}*** Loaded scripts: ${r.loaded.join(', ')}`);
    for (const e of r.errors) p(`${RED}*** Script ${e.name} failed: ${e.error.message}`);
    this.engine.emit('start', { event: 'start', home: HOME });
    this.cur = home;

    const connectTo = scfg => { const s = this.newSession(scfg); s.conn.connect(); return s; };
    if (args.server) {
      const scfg = this.resolveServer(args.server, args.port, args.tls);
      if (args.nick) scfg.nick = args.nick;
      scfg.autojoin = [...[].concat(scfg.autojoin || []), ...args.join];
      this.switchTo(connectTo(scfg).status);
    } else {
      let first = null;
      for (const [name, sc] of Object.entries(this.cfg.servers)) {
        if (!sc.autoconnect) continue;
        const s = connectTo(this.resolveServer(name));
        first = first || s;
      }
      if (first) this.switchTo(first.status);
    }
  }
}

// ---------------------------------------------------------------- command definitions
cmd('help', '/help [command]', function (a, win) {
  if (a) {
    const n = CMD_ALIASES[a.replace(/^\//, '')] || a.replace(/^\//, '');
    if (COMMANDS[n]) return this.print(win, `${GREY}${COMMANDS[n].usage}`, { act: false });
    return this.print(win, `${RED}*** No such command: ${a}`, { act: false });
  }
  this.info(win, 'Commands:');
  for (const c of Object.values(COMMANDS)) this.print(win, `  ${c.usage}`, { act: false });
  this.info(win, 'Keys: Alt-1..9/Ctrl-N/Ctrl-P windows, PgUp/PgDn scroll, Tab complete, Ctrl-B/K/_/O/R/T insert bold/color/underline/reset/reverse/italic');
  this.info(win, 'Scripts: ' + path.join(HOME, 'scripts') + ' (aliases defined by scripts also work as /commands). Prefix a command with . (e.g. /.msg) to bypass aliases.');
  return undefined;
});

cmd('server', '/server [-m] [-notls] <name|host[:port]> [port]   (/connect = /server -m)', function (a, win) {
  const toks = a.split(/\s+/).filter(Boolean);
  let newOne = false, tls;
  while (toks[0] && toks[0][0] === '-') {
    const f = toks.shift().toLowerCase();
    if (f === '-m') newOne = true;
    else if (f === '-tls' || f === '-ssl') tls = true;
    else if (f === '-notls' || f === '-nossl') tls = false;
    else return this.print(win, `${RED}*** Unknown flag ${f}`, { act: false });
  }
  const cur = win.session;
  if (!toks.length) {
    if (!cur) return this.usage(win, 'server');
    if (cur.conn.connected || cur.conn.connecting) return this.info(win, 'Already connected. Use /server <host> to switch servers.');
    cur.conn.connect();
    return undefined;
  }
  const scfg = this.resolveServer(toks[0], toks[1], tls);
  if (newOne || !cur) {
    const s = this.newSession(scfg);
    this.switchTo(s.status);
    s.conn.connect();
  } else {
    cur.attach(scfg);
    cur.conn.connect();
  }
  return undefined;
});

cmd('connect', '/connect <name|host[:port]> [port]   (opens an additional server connection)', function (a, win) {
  COMMANDS.server.fn.call(this, '-m ' + a, win);
});

cmd('disconnect', '/disconnect [message]', function (a, win) {
  const s = this.sess(win, false); if (!s) return;
  s.conn.disconnect(a || 'Zirc');
  this.info(win, `Disconnecting from ${s.name}`);
});

cmd('reconnect', '/reconnect', function (a, win) {
  const s = this.sess(win, false); if (!s) return;
  s.conn.connect();
});

cmd('quit', '/quit [message]   (disconnects everything and exits)', function (a) { this.shutdown(a || 'Zirc'); });

cmd('join', '/join <#channel>[,#channel...] [key]', function (a, win) {
  const s = this.sess(win); if (!s) return;
  const [chans, key] = take(a);
  if (!chans) return this.usage(win, 'join');
  const list = chans.split(',').filter(Boolean).map(c => (s.conn.isChannel(c) ? c : '#' + c));
  for (const c of list) s.userJoin.set(lc(c), Date.now());
  s.conn.join(list.join(','), key || undefined);
  return undefined;
});

cmd('part', '/part [#channel] [reason]', function (a, win) {
  const s = this.sess(win); if (!s) return;
  const [first, rest] = take(a);
  if (first && s.conn.isChannel(first)) s.conn.part(first, rest || undefined);
  else if (win.type === 'channel') s.conn.part(win.name, a || undefined);
  else this.usage(win, 'part');
});

cmd('close', '/close   (closes the current window; parts a channel)', function (a, win) {
  const s = win.session;
  if (win.type === 'status') {
    if (!s) return this.info(win, 'The main window cannot be closed.');
    if (s.conn.connected || s.conn.connecting) return this.info(win, 'Still connected - use /disconnect first.');
    for (const w of [...this.windows]) if (w.session === s) this.removeWindow(w);
    this.sessions.splice(this.sessions.indexOf(s), 1);
    return undefined;
  }
  if (win.type === 'channel' && s.conn.connected && win.chan) s.conn.part(win.name, a || undefined);
  this.removeWindow(win);
  return undefined;
});

cmd('msg', '/msg <target> <text>', function (a, win) {
  const s = this.sess(win); if (!s) return;
  const [t, text] = take(a);
  if (!t || !text) return this.usage(win, 'msg');
  this.sayTo(s, t, text);
});

cmd('notice', '/notice <target> <text>', function (a, win) {
  const s = this.sess(win); if (!s) return;
  const [t, text] = take(a);
  if (!t || !text) return this.usage(win, 'notice');
  s.conn.notice(t, text);
  this.print(win, `${GREY}->${RESET} -${t}- ${text}`, { act: false });
});

cmd('query', '/query <nick> [text]', function (a, win) {
  const s = this.sess(win, false); if (!s) return;
  const [n, text] = take(a);
  if (!n) return this.usage(win, 'query');
  this.switchTo(s.openWindow(n, 'query'));
  if (text) this.sayTo(s, n, text);
});

cmd('me', '/me <action text>', function (a, win) {
  const s = this.sess(win); if (!s) return;
  if (win.type === 'status' || !a) return this.usage(win, 'me');
  this.sayTo(s, win.name, a, true);
});

cmd('describe', '/describe <target> <action text>', function (a, win) {
  const s = this.sess(win); if (!s) return;
  const [t, text] = take(a);
  if (!t || !text) return this.usage(win, 'describe');
  this.sayTo(s, t, text, true);
});

cmd('say', '/say <text>   (send text even if it starts with /)', function (a, win) {
  const s = this.sess(win); if (!s) return;
  if (win.type === 'status') return this.info(win, 'Not in a channel or query.');
  this.sayTo(s, win.name, a);
});

cmd('echo', '/echo <text>   (print text in this window)', function (a, win) { this.print(win, a, { act: false }); });

cmd('ctcp', '/ctcp <target> <command> [args]', function (a, win) {
  const s = this.sess(win); if (!s) return;
  const [t, r] = take(a);
  const [c, args] = take(r);
  if (!t || !c) return this.usage(win, 'ctcp');
  const u = c.toUpperCase();
  s.conn.ctcp(t, u, u === 'PING' && !args ? String(Date.now()) : args);
  this.info(win, `CTCP ${u} sent to ${t}`);
});

cmd('nick', '/nick <newnick>', function (a, win) {
  const s = this.sess(win, false); if (!s) return;
  const n = take(a)[0];
  if (!n) return this.usage(win, 'nick');
  if (s.conn.connected) s.conn.setNick(n);
  else { s.conn.opts.nick = n; this.info(win, `Nick set to ${n} for the next connect`); }
});

cmd('away', '/away [message]   (no message = back)', function (a, win) {
  const s = this.sess(win); if (!s) return;
  s.conn.send('AWAY', a || undefined);
});

cmd('whois', '/whois <nick>', function (a, win) {
  const s = this.sess(win); if (!s) return;
  const n = take(a)[0] || (win.type === 'query' ? win.name : '');
  if (!n) return this.usage(win, 'whois');
  s.conn.send('WHOIS', n);
});

cmd('whowas', '/whowas <nick>', function (a, win) { const s = this.sess(win); if (s && a) s.conn.send('WHOWAS', take(a)[0]); });
cmd('who', '/who <mask|#channel>', function (a, win) { const s = this.sess(win); if (s) s.conn.send('WHO', take(a)[0] || (win.type === 'channel' ? win.name : undefined)); });
cmd('list', '/list [pattern]', function (a, win) { const s = this.sess(win); if (s) s.conn.send('LIST', a || undefined); });

cmd('names', '/names [#channel]   (lists users from local state)', function (a, win) {
  const s = this.sess(win, false); if (!s) return;
  const name = take(a)[0] || (win.type === 'channel' ? win.name : '');
  const ch = name && s.conn.channels.get(lc(name));
  if (!ch) return this.info(win, 'Not in that channel.');
  const w = s.windows.get(lc(name)) || win;
  const list = this.nickList(w).map(u => s.conn.userPrefix(name, u.nick) + u.nick);
  this.info(win, `${name}: ${list.length} users`);
  this.print(win, list.join(' '), { act: false });
});

cmd('topic', '/topic [#channel] [new topic]', function (a, win) {
  const s = this.sess(win); if (!s) return;
  const [first, rest] = take(a);
  let chan = win.type === 'channel' ? win.name : null, text = a;
  if (first && s.conn.isChannel(first)) { chan = first; text = rest; }
  if (!chan) return this.usage(win, 'topic');
  s.conn.send('TOPIC', chan, text ? text : undefined);
});

cmd('mode', '/mode [target] <+/-modes> [args]', function (a, win) {
  const s = this.sess(win); if (!s) return;
  const [first, rest] = take(a);
  if (!first) { if (win.type === 'channel') s.conn.send('MODE', win.name); else s.conn.send('MODE', s.conn.nick); return; }
  if (/^[+-]/.test(first)) {
    if (win.type !== 'channel') return this.usage(win, 'mode');
    s.conn.raw(`MODE ${win.name} ${a}`);
  } else s.conn.raw(`MODE ${first}${rest ? ' ' + rest : ''}`);
});

function modeNicks(app, win, a, sign, letter, name) {
  const s = app.sess(win); if (!s) return;
  if (win.type !== 'channel') return app.info(win, `${name} only works in a channel window.`);
  const nicks = a.split(/\s+/).filter(Boolean);
  if (!nicks.length) return app.usage(win, name);
  for (let i = 0; i < nicks.length; i += 4) {
    const g = nicks.slice(i, i + 4);
    s.conn.raw(`MODE ${win.name} ${sign}${letter.repeat(g.length)} ${g.join(' ')}`);
  }
  return undefined;
}
cmd('op', '/op <nick> [nick...]', function (a, win) { modeNicks(this, win, a, '+', 'o', 'op'); });
cmd('deop', '/deop <nick> [nick...]', function (a, win) { modeNicks(this, win, a, '-', 'o', 'deop'); });
cmd('voice', '/voice <nick> [nick...]', function (a, win) { modeNicks(this, win, a, '+', 'v', 'voice'); });
cmd('devoice', '/devoice <nick> [nick...]', function (a, win) { modeNicks(this, win, a, '-', 'v', 'devoice'); });

function parseKick(app, a, win, s) {
  const [first, rest] = take(a);
  if (first && s.conn.isChannel(first)) { const [n, r] = take(rest); return { chan: first, nick: n, reason: r }; }
  return { chan: win.type === 'channel' ? win.name : null, nick: first, reason: rest };
}
cmd('kick', '/kick [#channel] <nick> [reason]', function (a, win) {
  const s = this.sess(win); if (!s) return;
  const k = parseKick(this, a, win, s);
  if (!k.chan || !k.nick) return this.usage(win, 'kick');
  s.conn.send('KICK', k.chan, k.nick, k.reason || undefined);
});
function banMask(s, who) {
  if (/[!@]/.test(who)) return who;
  const h = s.conn.userHost(who);
  return h ? `*!*@${h.split('@')[1]}` : `${who}!*@*`;
}
cmd('ban', '/ban <nick|mask>', function (a, win) {
  const s = this.sess(win); if (!s) return;
  if (win.type !== 'channel' || !a) return this.usage(win, 'ban');
  s.conn.raw(`MODE ${win.name} +b ${banMask(s, take(a)[0])}`);
});
cmd('kickban', '/kickban [#channel] <nick> [reason]', function (a, win) {
  const s = this.sess(win); if (!s) return;
  const k = parseKick(this, a, win, s);
  if (!k.chan || !k.nick) return this.usage(win, 'kickban');
  s.conn.raw(`MODE ${k.chan} +b ${banMask(s, k.nick)}`);
  s.conn.send('KICK', k.chan, k.nick, k.reason || undefined);
});
cmd('invite', '/invite <nick> [#channel]', function (a, win) {
  const s = this.sess(win); if (!s) return;
  const [n, c] = take(a);
  const chan = c || (win.type === 'channel' ? win.name : '');
  if (!n || !chan) return this.usage(win, 'invite');
  s.conn.send('INVITE', n, chan);
});

cmd('raw', '/raw <irc line>   (alias /quote)', function (a, win) {
  const s = this.sess(win); if (!s) return;
  if (!a) return this.usage(win, 'raw');
  s.conn.raw(a);
});

cmd('ignore', '/ignore [nick|mask] | /ignore -r <mask>   (wildcards ok; no args lists)', function (a, win) {
  const [f, r] = take(a);
  if (!f) {
    this.info(win, this.cfg.ignore.length ? 'Ignoring: ' + this.cfg.ignore.join(', ') : 'Ignore list is empty.');
    return;
  }
  if (f === '-r') {
    const m = /[!@*]/.test(r) ? r : `${r}!*@*`;
    this.cfg.ignore = this.cfg.ignore.filter(x => lc(x) !== lc(m));
    this.info(win, `Removed ${m} from the ignore list`);
  } else {
    const m = /[!@*]/.test(f) ? f : `${f}!*@*`;
    if (!this.cfg.ignore.includes(m)) this.cfg.ignore.push(m);
    this.info(win, `Ignoring ${m}`);
  }
  this.rebuildIgnore();
  this.saveConfig();
});

cmd('highlight', '/highlight [word] | /highlight -r <word>   (your nick always highlights)', function (a, win) {
  const [f, r] = take(a);
  if (!f) { this.info(win, 'Highlight words: ' + (this.cfg.highlights.join(', ') || '(none besides your nick)')); return; }
  if (f === '-r') this.cfg.highlights = this.cfg.highlights.filter(x => lc(x) !== lc(r));
  else if (!this.cfg.highlights.includes(a)) this.cfg.highlights.push(a);
  this.info(win, 'Highlight words: ' + (this.cfg.highlights.join(', ') || '(none)'));
  this.saveConfig();
});

cmd('alias', '/alias [name] [body] | /alias -r <name>   (body may use $1 $2- $* $nick $chan)', function (a, win) {
  const [f, r] = take(a);
  if (!f) {
    for (const [k, v] of Object.entries(this.cfg.aliases)) this.print(win, `  /${k} = ${v}`, { act: false });
    for (const s of this.engine.list()) for (const k of s.aliases) this.print(win, `  /${k}  (script ${s.name})`, { act: false });
    return;
  }
  if (f === '-r') { delete this.cfg.aliases[r.replace(/^\//, '').toLowerCase()]; this.saveConfig(); return; }
  if (!r) return this.usage(win, 'alias');
  this.cfg.aliases[f.replace(/^\//, '').toLowerCase()] = r;
  this.saveConfig();
  this.info(win, `Alias /${f.replace(/^\//, '')} saved`);
});

cmd('window', '/window <number>   (/win)', function (a, win) {
  const n = parseInt(a, 10);
  if (!(n >= 1 && n <= this.windows.length)) return this.info(win, `Windows: ${this.windows.map((w, i) => `${i + 1}:${w.name}`).join('  ')}`);
  this.gotoWindow(n - 1);
  return undefined;
});
cmd('next', '/next', function () { this.stepWindow(1); });
cmd('prev', '/prev', function () { this.stepWindow(-1); });
cmd('clear', '/clear', function (a, win) { win.lines = []; win.scroll = 0; });

cmd('timer', '/timer [name] <repeats> <ms> <command>   (repeats 0 = forever) | /timer <name> off', function (a, win) {
  const [name, r1] = take(a);
  if (!name) {
    if (!this.timers.size) this.info(win, 'No timers running.');
    for (const t of this.timers.values()) this.print(win, `  ${t.name}: ${t.ms}ms, ${t.left === Infinity ? 'forever' : t.left + ' left'}: ${t.command}`, { act: false });
    return;
  }
  const stop = n => { const t = this.timers.get(n); if (t) { clearInterval(t.id); this.timers.delete(n); } };
  if (take(r1)[0].toLowerCase() === 'off') { stop(name); this.info(win, `Timer ${name} stopped`); return; }
  const [reps, r2] = take(r1);
  const [msS, command] = take(r2);
  const n = parseInt(reps, 10), ms = parseInt(msS, 10);
  if (!(n >= 0) || !(ms >= 100) || !command) return this.usage(win, 'timer');
  stop(name);
  const t = { name, ms, command, left: n === 0 ? Infinity : n };
  t.id = setInterval(() => {
    const w = this.windows.includes(win) ? win : this.cur;
    try { this.runLine(command, w); } catch (e) { this.print(w, `${RED}*** timer ${name}: ${e.message}`, { act: false }); }
    if (--t.left <= 0) stop(name);
  }, ms);
  this.timers.set(name, t);
  this.info(win, `Timer ${name} started`);
});

const scriptPath = n => (/[\\/]/.test(n) || /\.js$/i.test(n) ? path.resolve(n) : path.join(HOME, 'scripts', n + '.js'));
cmd('load', '/load <script>   (name in ~/.zirc/scripts, or a path)', function (a, win) {
  if (!a) return this.usage(win, 'load');
  try { const r = this.engine.load(scriptPath(a)); this.info(win, `Loaded script ${r.name}`); }
  catch (e) { this.print(win, `${RED}*** Could not load: ${e.message}`, { act: false }); }
});
cmd('unload', '/unload <script>', function (a, win) {
  this.info(win, this.engine.unload(a.replace(/\.js$/i, '')) ? `Unloaded ${a}` : `No such script: ${a}`);
});
cmd('reload', '/reload   (unload and reload every script in the scripts folder)', function (a, win) {
  this.engine.unloadAll();
  const r = this.engine.loadDir(path.join(HOME, 'scripts'));
  this.info(win, `Loaded ${r.loaded.length} script(s)${r.loaded.length ? ': ' + r.loaded.join(', ') : ''}`);
  for (const e of r.errors) this.print(win, `${RED}*** ${e.name}: ${e.error.message}`, { act: false });
});
cmd('scripts', '/scripts', function (a, win) {
  const l = this.engine.list();
  if (!l.length) return this.info(win, 'No scripts loaded.');
  for (const s of l) this.print(win, `  ${s.name}: ${s.handlers} handler(s), aliases: ${s.aliases.join(', ') || '-'}`, { act: false });
  return undefined;
});

cmd('version', '/version', function (a, win) { this.info(win, `Zirc ${VERSION} on node ${process.version}`); });
cmd('dcc', '/dcc   (not implemented yet)', function (a, win) { this.info(win, 'DCC is not implemented yet.'); });

// ---------------------------------------------------------------- main
const USAGE = `Zirc ${VERSION} - terminal IRC client with JavaScript scripting

Usage: zirc [options] [server [port]]

  server        a name from ~/.zirc/config.json, or host[:port] (TLS on 6697 by default)
  -n, --nick N  nickname to use
  -j, --join C  channels to join, comma separated (repeatable)
  --no-tls      connect without TLS (default port 6667)
  --tls         force TLS
  -h, --help    this help      -v, --version

Config and scripts live in ~/.zirc (override with ZIRC_HOME).`;

function parseArgs(argv) {
  const a = { server: null, port: null, nick: null, join: [], tls: undefined };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === '-h' || x === '--help') a.help = true;
    else if (x === '-v' || x === '--version') a.version = true;
    else if (x === '-n' || x === '--nick') a.nick = argv[++i];
    else if (x === '-j' || x === '--join') a.join.push(...String(argv[++i] || '').split(',').filter(Boolean));
    else if (x === '--tls') a.tls = true;
    else if (x === '--no-tls') a.tls = false;
    else if (x[0] === '-') a.bad = x;
    else if (!a.server) a.server = x;
    else if (!a.port) a.port = x;
  }
  return a;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(USAGE); return; }
  if (args.version) { console.log(VERSION); return; }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error('zirc needs an interactive terminal.');
    process.exit(1);
  }
  const { cfg, error, first } = loadConfig();
  const app = new App(cfg, error);
  const die = e => {
    app.leaveTerm();
    console.error(e && e.stack ? e.stack : e);
    process.exit(1);
  };
  process.on('uncaughtException', die);
  process.on('unhandledRejection', die);
  process.on('SIGTERM', () => app.shutdown('Terminated'));
  process.on('SIGHUP', () => app.shutdown('Hangup'));
  app.start(args, first);
}

if (require.main === module) main();
module.exports = { App, Session, parseKeys, COMMANDS };
