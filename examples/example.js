// Example Zirc script. Copy into ~/.zirc/scripts/ and type /reload.
// A script is plain JavaScript with a `zirc` object in scope (and `require`).

// --- Events: zirc.on(event, handler). Return false to halt default handling.
// Events: text, action, notice, ctcp, join, part, kick, quit, nick, topic, mode,
//         invite, input, connect, disconnect, raw, start
zirc.on('text', e => {
  // e: { nick, user, host, channel, text, isChannel, isPrivate, highlight, server, me, reply(), say(), echo() }
  if (/^!ping\b/i.test(e.text)) e.reply(`${e.nick}: pong`);

  if (e.text.startsWith('!roll')) {
    const sides = parseInt(e.text.split(/\s+/)[1], 10) || 6;
    e.reply(`${e.nick} rolled ${1 + Math.floor(Math.random() * sides)} (d${sides})`);
  }
});

// --- Greet people who join channels you are in (not yourself).
zirc.on('join', e => {
  if (!e.self && e.channel === '#zirc-test') e.say(e.channel, `Welcome, ${e.nick}!`);
});

// --- Aliases become /commands: /shout hello world
zirc.alias('shout', (args, ctx) => {
  if (!args) return ctx.echo('usage: /shout <text>');
  ctx.reply(zirc.fmt.bold(zirc.fmt.color(4, args.toUpperCase() + '!')));
});

// --- Persistent per-script storage (JSON in ~/.zirc/store).
zirc.alias('seen', (args, ctx) => {
  const who = args.trim().toLowerCase();
  const t = zirc.store.get('seen:' + who);
  ctx.echo(t ? `${who} last spoke ${new Date(t).toLocaleString()}` : `never seen ${who}`);
});
zirc.on('text', e => { if (e.isChannel) zirc.store.set('seen:' + e.nick.toLowerCase(), Date.now()); });

// --- Timers are cleaned up automatically on /reload or /unload.
zirc.every(60 * 60 * 1000, () => zirc.echo('One hour passed. Stretch!'));

// --- Intercept your own input: return false to stop it being sent.
zirc.on('input', e => {
  if (e.text === 'brb') { zirc.action(e.target, 'will be right back'); return false; }
});
