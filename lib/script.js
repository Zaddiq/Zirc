'use strict';
// Zirc scripting engine. Scripts are plain JavaScript files that receive a `zirc`
// API object (and `require`). They run with full trust, exactly like mIRC scripts do.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const Module = require('module');
const { ircfmt } = require('./fmt');

class ScriptEngine {
  // host must provide: version, home, storeDir, echo(text, where), error(name, err),
  //   say/action/notice(target, text, server), send(raw, server), runLine(line),
  //   info(server) -> { nick, channels, users(chan), connected } | null
  constructor(host) {
    this.host = host;
    this.scripts = new Map(); // abs file -> record
  }

  _guard(rec, fn, ...args) {
    try {
      const r = fn(...args);
      if (r && typeof r.then === 'function') r.catch(e => this.host.error(rec.name, e));
      return r;
    } catch (e) {
      this.host.error(rec.name, e);
      return undefined;
    }
  }

  // Fire an event. Returns false if a handler halted it (returned false).
  emit(event, ev) {
    event = event.toLowerCase();
    for (const rec of [...this.scripts.values()]) {
      for (const h of rec.handlers) {
        if (h.evt !== event && h.evt !== '*') continue;
        const r = this._guard(rec, h.fn, ev);
        if (r === false) return false;
      }
    }
    return true;
  }

  alias(name) {
    name = name.toLowerCase();
    for (const rec of this.scripts.values()) {
      const fn = rec.aliases.get(name);
      if (fn) return (args, ctx) => this._guard(rec, fn, args, ctx);
    }
    return null;
  }

  _store(rec) {
    const file = path.join(this.host.storeDir, rec.name.replace(/[^\w.-]/g, '_') + '.json');
    let data = null;
    const load = () => { if (data) return data; try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { data = {}; } return data; };
    const save = () => { fs.mkdirSync(this.host.storeDir, { recursive: true }); fs.writeFileSync(file, JSON.stringify(data, null, 2)); };
    return {
      get: (k, d) => { const v = load()[k]; return v === undefined ? d : v; },
      set: (k, v) => { load()[k] = v; save(); },
      delete: k => { delete load()[k]; save(); },
      all: () => ({ ...load() }),
    };
  }

  _api(rec) {
    const h = this.host;
    const track = t => { rec.timers.add(t); return t; };
    return {
      version: h.version,
      fmt: ircfmt,
      script: { name: rec.name, file: rec.file },
      on(evt, fn) {
        if (typeof fn !== 'function') throw new TypeError('zirc.on: handler must be a function');
        rec.handlers.push({ evt: String(evt).toLowerCase(), fn });
      },
      alias(name, fn) {
        if (typeof fn !== 'function') throw new TypeError('zirc.alias: handler must be a function');
        rec.aliases.set(String(name).toLowerCase().replace(/^\//, ''), fn);
      },
      after: (ms, fn) => {
        const t = setTimeout(() => { rec.timers.delete(t); this._guard(rec, fn); }, ms);
        return track(t);
      },
      every: (ms, fn) => track(setInterval(() => this._guard(rec, fn), Math.max(100, ms))),
      cancel: t => { clearTimeout(t); clearInterval(t); rec.timers.delete(t); },
      echo: (text, where) => h.echo(String(text), where),
      say: (target, text, server) => h.say(target, String(text), server),
      msg: (target, text, server) => h.say(target, String(text), server),
      action: (target, text, server) => h.action(target, String(text), server),
      notice: (target, text, server) => h.notice(target, String(text), server),
      send: (raw, server) => h.send(String(raw), server),
      join: (chan, server) => h.send('JOIN ' + chan, server),
      part: (chan, server) => h.send('PART ' + chan, server),
      command: line => h.runLine(String(line)),
      nick: server => (h.info(server) || {}).nick || null,
      channels: server => (h.info(server) || {}).channels || [],
      users: (chan, server) => { const i = h.info(server); return i ? i.users(chan) : []; },
      store: this._store(rec),
    };
  }

  load(file) {
    file = path.resolve(file);
    this.unloadFile(file);
    const name = path.basename(file).replace(/\.js$/i, '');
    const rec = { name, file, handlers: [], aliases: new Map(), timers: new Set() };
    this.scripts.set(file, rec);
    try {
      const code = fs.readFileSync(file, 'utf8');
      const wrapper = new vm.Script(`(function (zirc, require, module, exports, __filename, __dirname) {${code}\n})`, { filename: file });
      const fn = wrapper.runInThisContext();
      const mod = { exports: {} };
      fn(this._api(rec), Module.createRequire(file), mod, mod.exports, file, path.dirname(file));
    } catch (e) {
      this.unloadFile(file);
      throw e;
    }
    return rec;
  }

  loadDir(dir) {
    const loaded = [], errors = [];
    let files = [];
    try { files = fs.readdirSync(dir).filter(f => /\.js$/i.test(f) && !/^[._]/.test(f)).sort(); } catch { return { loaded, errors }; }
    for (const f of files) {
      try { loaded.push(this.load(path.join(dir, f)).name); } catch (e) { errors.push({ name: f, error: e }); }
    }
    return { loaded, errors };
  }

  unloadFile(file) {
    const rec = this.scripts.get(file);
    if (!rec) return false;
    for (const t of rec.timers) { clearTimeout(t); clearInterval(t); }
    this.scripts.delete(file);
    return true;
  }

  unload(name) {
    for (const rec of this.scripts.values()) {
      if (rec.name === name) return this.unloadFile(rec.file);
    }
    return false;
  }

  unloadAll() { for (const f of [...this.scripts.keys()]) this.unloadFile(f); }

  list() {
    return [...this.scripts.values()].map(r => ({
      name: r.name, file: r.file, handlers: r.handlers.length, aliases: [...r.aliases.keys()],
    }));
  }
}

module.exports = { ScriptEngine };
