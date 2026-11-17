'use strict';
// Minimal IRC-over-WebSocket server for testing the web client (RFC 6455 framing by hand).
const http = require('http');
const crypto = require('crypto');

function frame(text) {
  const body = Buffer.from(text);
  let head;
  if (body.length < 126) head = Buffer.from([0x81, body.length]);
  else if (body.length < 65536) { head = Buffer.alloc(4); head[0] = 0x81; head[1] = 126; head.writeUInt16BE(body.length, 2); }
  else { head = Buffer.alloc(10); head[0] = 0x81; head[1] = 127; head.writeBigUInt64BE(BigInt(body.length), 2); }
  return Buffer.concat([head, body]);
}

function startWsServer(port = 0) {
  const clients = [];
  const server = http.createServer((req, res) => { res.statusCode = 426; res.end('upgrade required'); });
  server.on('upgrade', (req, sock) => {
    const key = req.headers['sec-websocket-key'];
    const protos = String(req.headers['sec-websocket-protocol'] || '').split(',').map(s => s.trim());
    const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    let head = `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n`;
    const chosen = protos.includes('text.ircv3.net') ? 'text.ircv3.net' : null;
    if (chosen) head += `Sec-WebSocket-Protocol: ${chosen}\r\n`;
    sock.write(head + '\r\n');
    const c = { sock, nick: null, got: [], protocol: chosen, send: l => { if (!sock.destroyed) sock.write(frame(l)); }, closed: false };
    clients.push(c);
    let buf = Buffer.alloc(0);
    sock.on('data', d => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        if (buf.length < 2) return;
        const op = buf[0] & 0x0f;
        let len = buf[1] & 0x7f, off = 2;
        if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
        else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
        const masked = !!(buf[1] & 0x80);
        if (buf.length < off + (masked ? 4 : 0) + len) return;
        let payload = buf.subarray(off + (masked ? 4 : 0), off + (masked ? 4 : 0) + len);
        if (masked) { const m = buf.subarray(off, off + 4); payload = Buffer.from(payload.map((b, i) => b ^ m[i % 4])); }
        buf = buf.subarray(off + (masked ? 4 : 0) + len);
        if (op === 8) { sock.end(Buffer.from([0x88, 0])); return; }
        if (op === 1) { const line = payload.toString('utf8'); c.got.push(line); handle(c, line); }
      }
    });
    sock.on('close', () => { c.closed = true; });
    sock.on('error', () => {});
  });

  function handle(c, line) {
    const [cmd, ...rest] = line.split(' ');
    if (cmd === 'CAP' && rest[0] === 'LS') c.send(':srv CAP * LS :server-time multi-prefix sasl=PLAIN');
    else if (cmd === 'CAP' && rest[0] === 'REQ') c.send(`:srv CAP * ACK ${rest.slice(1).join(' ')}`);
    else if (cmd === 'AUTHENTICATE' && rest[0] === 'PLAIN') c.send('AUTHENTICATE +');
    else if (cmd === 'AUTHENTICATE') { c.authed = Buffer.from(rest[0], 'base64').toString(); c.send(':srv 903 me :SASL successful'); }
    else if (cmd === 'NICK') c.nick = rest[0];
    else if (cmd === 'CAP' && rest[0] === 'END') {
      c.send(`:srv 001 ${c.nick} :Welcome`);
      c.send(`:srv 005 ${c.nick} PREFIX=(ov)@+ CHANTYPES=# NETWORK=TestNet :are supported`);
      c.send(`:srv 376 ${c.nick} :End of MOTD`);
    } else if (cmd === 'PING') c.send(`:srv PONG srv ${rest[0]}`);
    else if (cmd === 'JOIN') {
      const ch = rest[0];
      c.send(`:${c.nick}!u@h JOIN ${ch}`);
      c.send(`:srv 332 ${c.nick} ${ch} :The test topic`);
      c.send(`:srv 353 ${c.nick} = ${ch} :@${c.nick} +bob alice`);
      c.send(`:srv 366 ${c.nick} ${ch} :End of /NAMES list.`);
    } else if (cmd === 'QUIT') c.sock.end(Buffer.from([0x88, 0]));
  }

  return new Promise(res => server.listen(port, '127.0.0.1', () => res({
    server, clients, port: server.address().port,
    close() { for (const c of clients) c.sock.destroy(); server.close(); },
  })));
}

module.exports = { startWsServer };
