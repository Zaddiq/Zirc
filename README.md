# Zirc

A terminal IRC client with mIRC-style scripting, in JavaScript. Zero dependencies, Node 18+.

```
node zirc.js                                  # start, then /server irc.libera.chat
node zirc.js -n mynick -j '#chan' irc.libera.chat
node zirc.js --no-tls localhost 6667
```

TLS is the default (port 6697). Config, scripts, logs and script storage live in `~/.zirc` (override with `ZIRC_HOME`).

## What works (v0.1)

- TLS, SASL PLAIN, IRCv3 caps (server-time, multi-prefix, away-notify, account-notify, extended-join, userhost-in-names, chghost, invite-notify)
- Auto-reconnect with backoff and rejoin, ping timeout detection, lag meter, outgoing flood limiter
- Multiple servers, channel/query/status windows, nicklist with @ + prefixes, topic bar, activity indicators, scrollback
- mIRC colors, bold/italic/underline/reverse, wrapping that handles wide characters
- Tab completion (nicks by recency, commands, channels), input history, highlights, ignore list, per-window logs
- CTCP VERSION/PING/TIME replies, /ctcp, user aliases with `$1 $2- $* $nick $chan`, `/timer`
- Scripting in plain JavaScript (below)

Not yet: DCC, SASL EXTERNAL/SCRAM, IRCv3 chathistory/message-tags sending, a GUI.

## Keys

Alt-1..9 / Ctrl-N / Ctrl-P switch windows, PgUp/PgDn scroll, Tab complete, Ctrl-B bold, Ctrl-K color, Ctrl-_ underline, Ctrl-T italic, Ctrl-R reverse, Ctrl-O reset, Ctrl-C twice quits. `/help` lists commands.

## Config (`~/.zirc/config.json`)

```json
{
  "nick": "me",
  "highlights": ["zirc"],
  "servers": {
    "libera": {
      "host": "irc.libera.chat", "port": 6697, "tls": true,
      "autoconnect": true, "autojoin": ["#zirc-test"],
      "sasl": { "user": "me", "passEnv": "LIBERA_PASS" },
      "perform": ["/msg NickServ ..."]
    }
  }
}
```

Prefer `passEnv` (an environment variable name) over putting a password in the file.

## Scripting

Drop `.js` files in `~/.zirc/scripts/` and run `/reload` (or `/load name`). Each script gets a `zirc` object and `require`. Scripts run with full trust, like mIRC scripts; only load code you trust. See `examples/example.js`.

| API | Meaning |
|---|---|
| `zirc.on(event, fn)` | Handle an event. Return `false` to stop default handling. |
| `zirc.alias(name, (args, ctx) => ...)` | Adds `/name`. `ctx` has `args, argv, target, server, reply(), echo()`. |
| `zirc.after(ms, fn)` / `zirc.every(ms, fn)` / `zirc.cancel(t)` | Timers, auto-cleared on reload. |
| `zirc.say/msg/action/notice(target, text, [server])` | Send messages. |
| `zirc.send(raw, [server])`, `zirc.join(chan)`, `zirc.part(chan)` | Raw protocol. |
| `zirc.echo(text, [window])`, `zirc.command('/line')` | Print locally, or run a command. |
| `zirc.nick()`, `zirc.channels()`, `zirc.users(chan)` | Current state. |
| `zirc.store.get/set/delete/all` | Persistent per-script JSON storage. |
| `zirc.fmt.bold/italic/underline/color(fg, text, [bg])/strip` | Formatting helpers. |

Events: `text`, `action`, `notice`, `ctcp`, `join`, `part`, `kick`, `quit`, `nick`, `topic`, `mode`, `invite`, `input` (your typed text), `connect`, `disconnect`, `raw`, `start`, or `*` for all.
Event objects carry `nick, user, host, channel, text, server, me` where relevant, plus `reply(text)`, `say(target, text)`, `echo(text)`, `send(raw)`.

## Tests

`node test/test.js` runs protocol, formatting and scripting tests against a fake IRC server.
