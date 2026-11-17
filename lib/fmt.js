'use strict';
// mIRC-style text formatting: parse control codes -> styled cells -> wrap -> ANSI.
// Raw control characters from the network (ESC etc.) are dropped here, which is
// also what keeps remote text from injecting terminal escape sequences.

// mIRC colors 0-15 mapped onto the xterm-256 palette.
const MIRC256 = [15, 0, 18, 28, 9, 88, 127, 208, 11, 10, 30, 14, 12, 13, 244, 252];
const NOST = Object.freeze({ b: 0, i: 0, u: 0, r: 0, s: 0, fg: null, bg: null });

// Approximate terminal display width of a code point.
function cw(cp) {
  if (cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if (cp < 0x300) return 1;
  if ((cp >= 0x300 && cp <= 0x36f) || (cp >= 0x200b && cp <= 0x200f) ||
      (cp >= 0xfe00 && cp <= 0xfe0f) || cp === 0x20e3 || cp === 0xfeff) return 0;
  if ((cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe6f) || (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x1f300 && cp <= 0x1f64f) ||
      (cp >= 0x1f900 && cp <= 0x1f9ff) || (cp >= 0x20000 && cp <= 0x3fffd)) return 2;
  return 1;
}

function strWidth(s) {
  let n = 0;
  for (const ch of s) n += cw(ch.codePointAt(0));
  return n;
}

// Parse an IRC string into cells: [{ ch, w, st }].
function parse(text) {
  const chars = Array.from(String(text));
  const cells = [];
  let st = NOST;
  for (let n = 0; n < chars.length; n++) {
    const ch = chars[n];
    const cp = ch.codePointAt(0);
    switch (ch) {
      case '\x02': st = { ...st, b: st.b ^ 1 }; continue;
      case '\x1d': st = { ...st, i: st.i ^ 1 }; continue;
      case '\x1f': st = { ...st, u: st.u ^ 1 }; continue;
      case '\x16': st = { ...st, r: st.r ^ 1 }; continue;
      case '\x1e': st = { ...st, s: st.s ^ 1 }; continue;
      case '\x0f': st = NOST; continue;
      case '\x03': {
        const m = /^(\d{1,2})(?:,(\d{1,2}))?/.exec(chars.slice(n + 1, n + 6).join(''));
        if (!m) { st = { ...st, fg: null, bg: null }; continue; }
        n += m[0].length;
        st = { ...st, fg: +m[1] === 99 ? null : +m[1] };
        if (m[2] !== undefined) st.bg = +m[2] === 99 ? null : +m[2];
        continue;
      }
      case '\x04': {
        const m = /^([0-9a-fA-F]{6})(?:,([0-9a-fA-F]{6}))?/.exec(chars.slice(n + 1, n + 14).join(''));
        if (!m) continue;
        n += m[0].length;
        st = { ...st, fg: '#' + m[1] };
        if (m[2]) st.bg = '#' + m[2];
        continue;
      }
      case '\t': cells.push({ ch: ' ', w: 1, st }); continue;
      default:
    }
    if (cp < 32 || (cp >= 0x7f && cp < 0xa0)) continue; // drop other control chars
    cells.push({ ch, w: cw(cp), st });
  }
  return cells;
}

const strip = text => parse(text).map(c => c.ch).join('');
const width = cells => cells.reduce((n, c) => n + c.w, 0);

// Word-wrap cells to W columns; continuation rows get `indent` leading spaces.
function wrap(cells, W, indent = 0) {
  if (W < 2) W = 2;
  if (indent > W - 8) indent = 0;
  const rows = [];
  const pad = () => Array.from({ length: indent }, () => ({ ch: ' ', w: 1, st: NOST }));
  let cur = [], curW = 0, lastSp = -1;
  for (const c of cells) {
    if (curW + c.w > W) {
      if (lastSp >= 0) {
        rows.push(cur.slice(0, lastSp));
        cur = pad().concat(cur.slice(lastSp + 1));
      } else {
        rows.push(cur);
        cur = pad();
      }
      curW = width(cur);
      lastSp = -1;
      if (c.ch === ' ') continue;
    }
    cur.push(c);
    curW += c.w;
    if (c.ch === ' ') lastSp = cur.length - 1;
  }
  rows.push(cur);
  return rows;
}

// Truncate cells to at most W columns.
function fit(cells, W) {
  const out = [];
  let n = 0;
  for (const c of cells) {
    if (n + c.w > W) break;
    out.push(c);
    n += c.w;
  }
  return out;
}

// Truncate/pad a plain string to exactly W columns (control chars removed).
function fitPlain(str, W) {
  const cells = fit(parse(str), W);
  return cells.map(c => c.ch).join('') + ' '.repeat(Math.max(0, W - width(cells)));
}

const sameStyle = (a, b) => a === b ||
  (a.b === b.b && a.i === b.i && a.u === b.u && a.r === b.r && a.s === b.s && a.fg === b.fg && a.bg === b.bg);

function colorSgr(c, base) {
  if (c == null) return '';
  if (typeof c === 'string') {
    return `;${base};2;${parseInt(c.slice(1, 3), 16)};${parseInt(c.slice(3, 5), 16)};${parseInt(c.slice(5, 7), 16)}`;
  }
  if (c < 16) return `;${base};5;${MIRC256[c]}`;
  return ''; // extended 16-98 palette not mapped yet
}

function sgr(st) {
  let s = '\x1b[0';
  if (st.b) s += ';1';
  if (st.i) s += ';3';
  if (st.u) s += ';4';
  if (st.r) s += ';7';
  if (st.s) s += ';9';
  return s + colorSgr(st.fg, 38) + colorSgr(st.bg, 48) + 'm';
}

function render(cells) {
  let out = '', prev = null;
  for (const c of cells) {
    if (!prev || !sameStyle(prev, c.st)) { out += sgr(c.st); prev = c.st; }
    out += c.ch;
  }
  return out + '\x1b[0m';
}

// Helpers for building formatted strings (exposed to scripts as zirc.fmt).
const ircfmt = {
  bold: s => `\x02${s}\x02`,
  italic: s => `\x1d${s}\x1d`,
  underline: s => `\x1f${s}\x1f`,
  reverse: s => `\x16${s}\x16`,
  reset: '\x0f',
  color: (fg, s, bg) => `\x03${String(fg).padStart(2, '0')}${bg != null ? ',' + String(bg).padStart(2, '0') : ''}${s}\x03`,
  strip,
};

module.exports = { cw, strWidth, parse, strip, width, wrap, fit, fitPlain, render, ircfmt, NOST };
