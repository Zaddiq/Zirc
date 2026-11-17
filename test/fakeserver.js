'use strict';
// Minimal fake IRC server for testing Zirc.
const net = require('net');

function startServer(port = 0, hooks = {}) {
  const clients = [];
  const server = net.createServer(sock => {
    sock.setEncoding('utf8');
    const c = { sock, nick: null, got: [], send: l => sock.write(l + '\r\n') };
    clients.push(c);
    let buf = '';
    sock.on('data', d => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, '');
        buf = buf.slice(i + 1);
        c.got.push(line);
        handle(c, line);
        if (hooks.onLine) hooks.onLine(c, line);
      }
    });
    sock.on('error', () => {});
  });
  function handle(c, line) {
    const [cmd, ...rest] = line.split(' ');
    if (cmd === 'CAP' && rest[0] === 'LS') c.send(':srv CAP * LS :server-time multi-prefix sasl=PLAIN away-notify');
    else if (cmd === 'CAP' && rest[0] === 'REQ') c.send(`:srv CAP * ACK ${rest.slice(1).join(' ')}`);
    else if (cmd === 'AUTHENTICATE' && rest[0] === 'PLAIN') c.send('AUTHENTICATE +');
    else if (cmd === 'AUTHENTICATE') { c.authed = Buffer.from(rest[0], 'base64').toString(); c.send(':srv 903 me :SASL successful'); }
    else if (cmd === 'NICK') c.nick = rest[0];
    else if (cmd === 'CAP' && rest[0] === 'END') welcome(c);
    else if (cmd === 'PING') c.send(`:srv PONG srv ${rest[0]}`);
    else if (cmd === 'JOIN') {
      const ch = rest[0];
      c.send(`:${c.nick}!u@h JOIN ${ch}`);
      c.send(`:srv 332 ${c.nick} ${ch} :The test topic`);
      c.send(`:srv 353 ${c.nick} = ${ch} :@${c.nick} +bob alice`);
      c.send(`:srv 366 ${c.nick} ${ch} :End of /NAMES list.`);
    }
  }
  function welcome(c) {
    c.send(`:srv 001 ${c.nick} :Welcome`);
    c.send(`:srv 005 ${c.nick} PREFIX=(ov)@+ CHANTYPES=# NETWORK=TestNet :are supported`);
    c.send(`:srv 376 ${c.nick} :End of MOTD`);
  }
  return new Promise(res => server.listen(port, '127.0.0.1', () => res({ server, clients, port: server.address().port })));
}

module.exports = { startServer };
