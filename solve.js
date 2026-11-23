// Fast, dependency-free ES module drop-in replacement for makefun-site 1.0.0.

const REPORT_FILE = 'build-report.txt';
const RESERVED = ['posts', 'tags', 'page'];
const SLUG_MAX = 64;
const INCLUDE_DEPTH = 8;

const MONTHS_SPACE = [
  '',
  'January ', 'February ', 'March ', 'April ', 'May ', 'June ',
  'July ', 'August ', 'September ', 'October ', 'November ', 'December ',
];
const DAYS_SPACE = new Array(32);
for (let d = 1; d <= 31; d++) DAYS_SPACE[d] = d + ' ';

const DAYS_IN_MONTH = new Uint8Array([0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]);

// Lookup tables for ASCII fast paths
const HTML_ESC_TBL = new Uint8Array(64);
HTML_ESC_TBL[38] = 1; // &
HTML_ESC_TBL[60] = 2; // <
HTML_ESC_TBL[62] = 3; // >
HTML_ESC_TBL[34] = 4; // "
HTML_ESC_TBL[39] = 5; // '
const HTML_ESC_STR = ['', '&amp;', '&lt;', '&gt;', '&quot;', '&#39;'];

// Inline Markdown table: 0=passthrough, 1..5=HTML escape, 6=\, 7=`, 8=*, 9=[
const INLINE_TBL = new Uint8Array(128);
INLINE_TBL[38] = 1; // &
INLINE_TBL[60] = 2; // <
INLINE_TBL[62] = 3; // >
INLINE_TBL[34] = 4; // "
INLINE_TBL[39] = 5; // '
INLINE_TBL[92] = 6; // \
INLINE_TBL[96] = 7; // `
INLINE_TBL[42] = 8; // *
INLINE_TBL[91] = 9; // [

// Backslash-escapable Markdown characters: \ ` * _ [ ] ( ) # + - . ! >
const ESCAPABLE_TBL = new Uint8Array(128);
for (const ch of '\\`*_[]()#+-.!>') ESCAPABLE_TBL[ch.charCodeAt(0)] = 1;

// Preallocated 1-char ASCII strings for zero-alloc backslash escapes
const ASCII_CHAR = new Array(128);
for (let c = 0; c < 128; c++) ASCII_CHAR[c] = String.fromCharCode(c);

// ASCII whitespace table for branchless word counting
const WS_TBL = new Uint8Array(128);
WS_TBL[9] = 1;
WS_TBL[10] = 1;
WS_TBL[11] = 1;
WS_TBL[12] = 1;
WS_TBL[13] = 1;
WS_TBL[32] = 1;

// Fence language chars: A-Za-z0-9_+-
const FENCE_LANG_TBL = new Uint8Array(128);
for (let c = 48; c <= 57; c++) FENCE_LANG_TBL[c] = 1; // 0-9
for (let c = 65; c <= 90; c++) FENCE_LANG_TBL[c] = 1; // A-Z
for (let c = 97; c <= 122; c++) FENCE_LANG_TBL[c] = 1; // a-z
FENCE_LANG_TBL[95] = 1; // _
FENCE_LANG_TBL[43] = 1; // +
FENCE_LANG_TBL[45] = 1; // -

// Scheme continuation chars: A-Za-z0-9+.-
const SCHEME_TBL = new Uint8Array(128);
for (let c = 48; c <= 57; c++) SCHEME_TBL[c] = 1;
for (let c = 65; c <= 90; c++) SCHEME_TBL[c] = 1;
for (let c = 97; c <= 122; c++) SCHEME_TBL[c] = 1;
SCHEME_TBL[43] = 1; // +
SCHEME_TBL[46] = 1; // .
SCHEME_TBL[45] = 1; // -

// Slug ASCII char map: 0 = separator, otherwise lowercase ASCII char code (a-z, 0-9)
const SLUG_ASCII = new Uint8Array(128);
for (let c = 48; c <= 57; c++) SLUG_ASCII[c] = c;
for (let c = 97; c <= 122; c++) SLUG_ASCII[c] = c;
for (let c = 65; c <= 90; c++) SLUG_ASCII[c] = c + 32;

// Pure memo caches (deterministic functions of their string input)
const slugCache = new Map();
const dateCache = new Map();
const slugBuf = Buffer.allocUnsafe(64);

const ESC_RE = /[&<>"']/g;
const ESC_TEST_RE = /[&<>"']/;
const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escCb = (c) => ESC_MAP[c];
const JSON_ESC_TEST_RE = /["\\\x00-\x1f\ud800-\udfff]/;
const FLAT_RE = /^/;
let _jsonMode = false;

function jsonSliceAlways(s) {
  if (s.length === 0) return '';
  FLAT_RE.test(s);
  const q = JSON.stringify(s);
  return q.slice(1, q.length - 1);
}

function jsonSliceFast(s) {
  if (s.length === 0 || !JSON_ESC_TEST_RE.test(s)) return s;
  const q = JSON.stringify(s);
  return q.slice(1, q.length - 1);
}
const INLINE_RE = /[&<>"'\\`*\[]/g;
const TICK_OR_ESC_RE = /[&<>"'`]/g;
const BRACKET_OR_INLINE_RE = /[&<>"'\\`*[\]]/g;
const WORD_200_RE = /\s*\S+(?:\s+\S+){199}/y;
const WORD_1_RE = /\s*\S+/y;
const CLOSE_PAREN_OR_WS_RE = /[)\s]/g;

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// ---------------------------------------------------------------- text helpers

function escapeHtml(s) {
  if (!ESC_TEST_RE.test(s)) return s;
  return s.replace(ESC_RE, escCb);
}

function escapeHtmlSpan(s, start, end) {
  if (start >= end) return '';
  ESC_RE.lastIndex = start;
  if (!ESC_RE.test(s) || ESC_RE.lastIndex - 1 >= end) return s.slice(start, end);
  return s.slice(start, end).replace(ESC_RE, escCb);
}

function slugifyAsciiFrom(plain) {
  const len = plain.length;
  let outLen = 0;
  let gap = false;
  for (let i = 0; i < len; i++) {
    const c = plain.charCodeAt(i);
    const k = c < 128 ? SLUG_ASCII[c] : 0;
    if (k === 0) {
      if (outLen > 0) gap = true;
      continue;
    }
    if (gap) {
      if (outLen >= 63) break;
      slugBuf[outLen++] = 45;
      gap = false;
    }
    slugBuf[outLen++] = k;
    if (outLen === 64) break;
  }
  while (outLen > 0 && slugBuf[outLen - 1] === 45) outLen--;
  if (outLen === 0) return 'untitled';
  return slugBuf.toString('latin1', 0, outLen);
}

function slugify(text) {
  const cached = slugCache.get(text);
  if (cached !== undefined) return cached;
  const len = text.length;
  let outLen = 0;
  let gap = false;
  let hasNonAscii = false;
  for (let i = 0; i < len; i++) {
    const c = text.charCodeAt(i);
    if (c >= 128) {
      hasNonAscii = true;
      break;
    }
    const k = SLUG_ASCII[c];
    if (k === 0) {
      if (outLen > 0) gap = true;
      continue;
    }
    if (gap) {
      if (outLen >= 63) break;
      slugBuf[outLen++] = 45;
      gap = false;
    }
    slugBuf[outLen++] = k;
    if (outLen === 64) break;
  }
  let res;
  if (hasNonAscii) {
    const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
    res = slugifyAsciiFrom(plain);
  } else {
    while (outLen > 0 && slugBuf[outLen - 1] === 45) outLen--;
    res = outLen === 0 ? 'untitled' : slugBuf.toString('latin1', 0, outLen);
  }
  if (slugCache.size >= 8192) slugCache.clear();
  slugCache.set(text, res);
  return res;
}

function uniqueSlug(slug, taken) {
  let out = slug;
  if (taken.has(out)) {
    let n = 2;
    do {
      out = slug + '-' + n;
      n++;
    } while (taken.has(out));
  }
  taken.add(out);
  return out;
}

function longDate(date) {
  const cached = dateCache.get(date);
  if (cached !== undefined) return cached;
  const m = (date.charCodeAt(5) - 48) * 10 + (date.charCodeAt(6) - 48);
  const d = (date.charCodeAt(8) - 48) * 10 + (date.charCodeAt(9) - 48);
  const res = DAYS_SPACE[d] + MONTHS_SPACE[m] + date.slice(0, 4);
  if (dateCache.size >= 4096) dateCache.clear();
  dateCache.set(date, res);
  return res;
}

function isUnicodeWs(c) {
  return (
    c === 0x00a0 ||
    c === 0xfeff ||
    (c >= 0x2000 && c <= 0x200a) ||
    c === 0x2028 ||
    c === 0x2029 ||
    c === 0x202f ||
    c === 0x205f ||
    c === 0x3000 ||
    c === 0x1680
  );
}

function isJsWs(c) {
  return c <= 32
    ? (c === 32 || c === 10 || c === 9 || c === 13 || c === 12 || c === 11)
    : (c >= 160 && isUnicodeWs(c));
}

function readingMinutesOf(s, start) {
  const len = s.length;
  let pos = start;
  let mins = 0;
  while (len - pos >= 399) {
    WORD_200_RE.lastIndex = pos;
    if (!WORD_200_RE.test(s)) break;
    mins++;
    pos = WORD_200_RE.lastIndex;
  }
  if (pos < len) {
    WORD_1_RE.lastIndex = pos;
    if (WORD_1_RE.test(s)) mins++;
  }
  return mins === 0 ? 1 : mins;
}

// ---------------------------------------------------------------- front matter

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return DAYS_IN_MONTH[m];
}

let _fmErr = '';

function parseQuotedString(s, start, end) {
  if (end - start < 2 || s.charCodeAt(end - 1) !== 34) {
    _fmErr = 'a quoted string is not closed';
    return null;
  }
  const innerStart = start + 1;
  const innerEnd = end - 1;
  const bs = s.indexOf('\\', innerStart);
  const q = s.indexOf('"', innerStart);
  if ((bs === -1 || bs >= innerEnd) && (q === -1 || q >= innerEnd)) {
    return s.slice(innerStart, innerEnd);
  }
  let out = '';
  let last = innerStart;
  for (let i = innerStart; i < innerEnd; i++) {
    const c = s.charCodeAt(i);
    if (c === 92) {
      if (i + 1 === innerEnd) {
        _fmErr = 'a quoted string holds an escape other than \\" or \\\\';
        return null;
      }
      const n = s.charCodeAt(i + 1);
      if (n !== 34 && n !== 92) {
        _fmErr = 'a quoted string holds an escape other than \\" or \\\\';
        return null;
      }
      if (last < i) out += s.slice(last, i);
      out += n === 34 ? '"' : '\\';
      i++;
      last = i + 1;
    } else if (c === 34) {
      _fmErr = 'a quoted string holds a stray quote';
      return null;
    }
  }
  if (last < innerEnd) out += s.slice(last, innerEnd);
  return out;
}

function parseFmString(s, start, end) {
  const c0 = s.charCodeAt(start);
  if (c0 === 34) return parseQuotedString(s, start, end);
  if (c0 === 91) {
    _fmErr = 'a bare string opens on [';
    return null;
  }
  return s.slice(start, end);
}

function parseFmDate(s, start, end) {
  if (
    end - start !== 10 ||
    s.charCodeAt(start + 4) !== 45 ||
    s.charCodeAt(start + 7) !== 45
  ) {
    _fmErr = 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)';
    return null;
  }
  const d0 = s.charCodeAt(start) - 48;
  const d1 = s.charCodeAt(start + 1) - 48;
  const d2 = s.charCodeAt(start + 2) - 48;
  const d3 = s.charCodeAt(start + 3) - 48;
  const m0 = s.charCodeAt(start + 5) - 48;
  const m1 = s.charCodeAt(start + 6) - 48;
  const day0 = s.charCodeAt(start + 8) - 48;
  const day1 = s.charCodeAt(start + 9) - 48;
  if (
    (d0 | d1 | d2 | d3 | m0 | m1 | day0 | day1) < 0 ||
    d0 > 9 || d1 > 9 || d2 > 9 || d3 > 9 ||
    m0 > 9 || m1 > 9 || day0 > 9 || day1 > 9
  ) {
    _fmErr = 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)';
    return null;
  }
  const y = d0 * 1000 + d1 * 100 + d2 * 10 + d3;
  const mo = m0 * 10 + m1;
  const d = day0 * 10 + day1;
  if (y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) {
    _fmErr = 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)';
    return null;
  }
  return s.slice(start, end);
}

function parseFmTags(s, start, end) {
  if (end - start < 2 || s.charCodeAt(start) !== 91 || s.charCodeAt(end - 1) !== 93) {
    _fmErr = 'key "tags": not a list [a, b]';
    return null;
  }
  let p = start + 1;
  let q = end - 1;
  while (p < q && isJsWs(s.charCodeAt(p))) p++;
  while (q > p && isJsWs(s.charCodeAt(q - 1))) q--;
  if (p === q) return [];
  const tags = [];
  let segStart = start + 1;
  const innerEnd = end - 1;
  while (segStart <= innerEnd) {
    let comma = s.indexOf(',', segStart);
    if (comma === -1 || comma > innerEnd) comma = innerEnd;
    let ts = segStart;
    let te = comma;
    while (ts < te && isJsWs(s.charCodeAt(ts))) ts++;
    while (te > ts && isJsWs(s.charCodeAt(te - 1))) te--;
    if (ts === te) {
      _fmErr = 'key "tags": an empty tag, or one holding " [ or ]';
      return null;
    }
    for (let i = ts; i < te; i++) {
      const c = s.charCodeAt(i);
      if (c === 34 || c === 91 || c === 93) {
        _fmErr = 'key "tags": an empty tag, or one holding " [ or ]';
        return null;
      }
    }
    tags.push(s.slice(ts, te));
    segStart = comma + 1;
  }
  return tags;
}

function isValidLayoutName(s, start, end) {
  if (start >= end) return false;
  for (let i = start; i < end; i++) {
    const c = s.charCodeAt(i);
    if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) return false;
  }
  return true;
}

function isValidSlug(s, start, end) {
  const len = end - start;
  if (len === 0 || len > 64) return false;
  let prevDash = true;
  for (let i = start; i < end; i++) {
    const c = s.charCodeAt(i);
    if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) {
      prevDash = false;
    } else if (c === 45) {
      if (prevDash) return false;
      prevDash = true;
    } else {
      return false;
    }
  }
  return !prevDash;
}

let _fmBodyStart = 0;

function parseFrontMatter(text) {
  const len = text.length;
  if (
    len < 3 ||
    text.charCodeAt(0) !== 45 ||
    text.charCodeAt(1) !== 45 ||
    text.charCodeAt(2) !== 45 ||
    (len > 3 && text.charCodeAt(3) !== 10)
  ) {
    _fmErr = 'no front matter';
    return null;
  }
  if (len === 3) {
    _fmErr = 'the front matter is not closed';
    return null;
  }

  let closeIdx = -1;
  let searchFrom = 3;
  while (true) {
    const idx = text.indexOf('\n---', searchFrom);
    if (idx === -1) break;
    const after = idx + 4;
    if (after === len || text.charCodeAt(after) === 10) {
      closeIdx = idx;
      break;
    }
    searchFrom = idx + 1;
  }
  if (closeIdx === -1) {
    _fmErr = 'the front matter is not closed';
    return null;
  }

  let title = undefined;
  let date = undefined;
  let tags = undefined;
  let draft = false;
  let layout = undefined;
  let slug = undefined;
  let summary = undefined;
  let seen = 0; // bit 0=title, 1=date, 2=tags, 3=draft, 4=layout, 5=slug, 6=summary

  let pos = 4;
  let lineNo = 2;
  while (pos <= closeIdx) {
    let nl = text.indexOf('\n', pos);
    if (nl === -1 || nl > closeIdx) nl = closeIdx;
    if (pos < nl) {
      const c0 = text.charCodeAt(pos);
      if (c0 !== 35) {
        let k = pos;
        while (k < nl && (text.charCodeAt(k) === 32 || text.charCodeAt(k) === 9)) k++;
        if (k < nl) {
          let ke = pos;
          while (ke < nl) {
            const kc = text.charCodeAt(ke);
            if ((kc >= 97 && kc <= 122) || kc === 95) ke++;
            else break;
          }
          if (ke === pos || ke >= nl || text.charCodeAt(ke) !== 58) {
            _fmErr = 'line ' + lineNo + ' is not "key: value"';
            return null;
          }
          let vs, ve;
          if (ke + 1 === nl) {
            vs = nl;
            ve = nl;
          } else if (text.charCodeAt(ke + 1) === 32) {
            vs = ke + 2;
            ve = nl;
            while (ve > vs && (text.charCodeAt(ve - 1) === 32 || text.charCodeAt(ve - 1) === 9)) ve--;
          } else {
            _fmErr = 'line ' + lineNo + ' is not "key: value"';
            return null;
          }

          const klen = ke - pos;
          let keyId = -1;
          if (c0 === 116) { // 't'
            if (klen === 5 && text.startsWith('title', pos)) keyId = 0;
            else if (klen === 4 && text.startsWith('tags', pos)) keyId = 2;
          } else if (c0 === 100) { // 'd'
            if (klen === 4 && text.startsWith('date', pos)) keyId = 1;
            else if (klen === 5 && text.startsWith('draft', pos)) keyId = 3;
          } else if (c0 === 115) { // 's'
            if (klen === 4 && text.startsWith('slug', pos)) keyId = 5;
            else if (klen === 7 && text.startsWith('summary', pos)) keyId = 6;
          } else if (c0 === 108) { // 'l'
            if (klen === 6 && text.startsWith('layout', pos)) keyId = 4;
          }

          if (keyId === -1) {
            _fmErr = 'unknown key "' + text.slice(pos, ke) + '"';
            return null;
          }
          const bit = 1 << keyId;
          if ((seen & bit) !== 0) {
            _fmErr = 'key "' + text.slice(pos, ke) + '" is given twice';
            return null;
          }
          if (vs === ve) {
            _fmErr = 'key "' + text.slice(pos, ke) + '" has no value';
            return null;
          }
          seen |= bit;

          if (keyId === 0) {
            const v = parseFmString(text, vs, ve);
            if (v === null) { _fmErr = 'key "title": ' + _fmErr; return null; }
            title = v;
          } else if (keyId === 1) {
            const v = parseFmDate(text, vs, ve);
            if (v === null) return null;
            date = v;
          } else if (keyId === 2) {
            const v = parseFmTags(text, vs, ve);
            if (v === null) return null;
            tags = v;
          } else if (keyId === 3) {
            const vlen = ve - vs;
            if (vlen === 4 && text.startsWith('true', vs)) draft = true;
            else if (vlen === 5 && text.startsWith('false', vs)) draft = false;
            else { _fmErr = 'key "draft": true or false'; return null; }
          } else if (keyId === 4) {
            if (!isValidLayoutName(text, vs, ve)) { _fmErr = 'key "layout": not a template name'; return null; }
            layout = text.slice(vs, ve);
          } else if (keyId === 5) {
            if (!isValidSlug(text, vs, ve)) { _fmErr = 'key "slug": not a slug'; return null; }
            slug = text.slice(vs, ve);
          } else {
            const v = parseFmString(text, vs, ve);
            if (v === null) { _fmErr = 'key "summary": ' + _fmErr; return null; }
            summary = v;
          }
        }
      }
    }
    pos = nl + 1;
    lineNo++;
  }
  if ((seen & 1) === 0) {
    _fmErr = 'no title';
    return null;
  }
  const afterClose = closeIdx + 4;
  _fmBodyStart = afterClose === len ? len : afterClose + 1;
  return { title, date, tags, draft, layout, slug, summary };
}

// ---------------------------------------------------------------- markdown

function isBlankLine(s, ls, le) {
  for (let i = ls; i < le; i++) {
    const c = s.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

function matchFenceOpen(s, ls, le) {
  if (le - ls < 3 || s.charCodeAt(ls) !== 96 || s.charCodeAt(ls + 1) !== 96 || s.charCodeAt(ls + 2) !== 96) {
    return null;
  }
  let k = ls + 3;
  while (k < le) {
    const c = s.charCodeAt(k);
    if (c < 128 && FENCE_LANG_TBL[c] === 1) k++;
    else break;
  }
  const langEnd = k;
  while (k < le) {
    const c = s.charCodeAt(k);
    if (c !== 32 && c !== 9) return null;
    k++;
  }
  return langEnd === ls + 3 ? '' : s.slice(ls + 3, langEnd);
}

function isFenceClose(s, ls, le) {
  if (le - ls < 3 || s.charCodeAt(ls) !== 96 || s.charCodeAt(ls + 1) !== 96 || s.charCodeAt(ls + 2) !== 96) {
    return false;
  }
  for (let k = ls + 3; k < le; k++) {
    const c = s.charCodeAt(k);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

// Returns packed (depth << 24) or 0? Better: write into module scratch or return depth (0 if none)
let _hStart = 0;
let _hEnd = 0;
function matchHeading(s, ls, le) {
  if (ls >= le || s.charCodeAt(ls) !== 35) return 0;
  let k = ls + 1;
  const maxHash = ls + 6 < le ? ls + 6 : le;
  while (k < maxHash && s.charCodeAt(k) === 35) k++;
  const depth = k - ls;
  if (k >= le) return 0;
  const sp = s.charCodeAt(k);
  if (sp !== 32 && sp !== 9) return 0;
  k++;
  while (k < le && (s.charCodeAt(k) === 32 || s.charCodeAt(k) === 9)) k++;
  let e = le;
  while (e > k && (s.charCodeAt(e - 1) === 32 || s.charCodeAt(e - 1) === 9)) e--;
  if (k >= e) return 0;
  _hStart = k;
  _hEnd = e;
  return depth;
}

function isHr(s, ls, le) {
  if (le - ls < 3) return false;
  const c0 = s.charCodeAt(ls);
  if ((c0 !== 45 && c0 !== 42) || s.charCodeAt(ls + 1) !== c0 || s.charCodeAt(ls + 2) !== c0) {
    return false;
  }
  for (let k = ls + 3; k < le; k++) {
    const c = s.charCodeAt(k);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

function endsParagraphLine(s, ls, le) {
  if (ls >= le) return true;
  const c0 = s.charCodeAt(ls);
  if (c0 === 32 || c0 === 9) return isBlankLine(s, ls, le);
  if (c0 === 96) return matchFenceOpen(s, ls, le) !== null;
  if (c0 === 35) return matchHeading(s, ls, le) !== 0;
  if (c0 === 45 || c0 === 42) return isHr(s, ls, le);
  return false;
}

function isBulletLine(s, ls, le) {
  if (le - ls < 2) return false;
  const c0 = s.charCodeAt(ls);
  return (c0 === 45 || c0 === 42) && s.charCodeAt(ls + 1) === 32;
}

let _ordVal = 0;
let _ordTextStart = 0;
function matchOrderedLine(s, ls, le) {
  if (ls >= le) return false;
  const c0 = s.charCodeAt(ls);
  if (c0 < 48 || c0 > 57) return false;
  let val = c0 - 48;
  let k = ls + 1;
  const maxD = ls + 9 < le ? ls + 9 : le;
  while (k < maxD) {
    const c = s.charCodeAt(k);
    if (c >= 48 && c <= 57) {
      val = val * 10 + (c - 48);
      k++;
    } else break;
  }
  if (k + 1 >= le || s.charCodeAt(k) !== 46 || s.charCodeAt(k + 1) !== 32) return false;
  _ordVal = val;
  _ordTextStart = k + 2;
  return true;
}

function isContinuedLine(s, ls, le) {
  if (le - ls < 3 || s.charCodeAt(ls) !== 32 || s.charCodeAt(ls + 1) !== 32) return false;
  let k = ls + 2;
  while (k < le && s.charCodeAt(k) === 32) k++;
  return k < le && !isJsWs(s.charCodeAt(k));
}

function countBackslashesBefore(s, j, floor) {
  let k = j;
  while (k > floor && s.charCodeAt(k - 1) === 92) k--;
  return j - k;
}

function findUnescapedDoubleStar(s, from, end) {
  let pos = from;
  const limit = end - 2;
  while (pos <= limit) {
    const j = s.indexOf('**', pos);
    if (j === -1 || j > limit) return -1;
    if ((countBackslashesBefore(s, j, from) & 1) === 0) return j;
    pos = j + 1;
  }
  return -1;
}

function findSingleStar(s, from, end) {
  let pos = from;
  while (pos < end) {
    const j = s.indexOf('*', pos);
    if (j === -1 || j >= end) return -1;
    if ((countBackslashesBefore(s, j, from) & 1) !== 0) {
      pos = j + 1;
      continue;
    }
    if (j + 1 < end && s.charCodeAt(j + 1) === 42) {
      pos = j + 2;
      continue;
    }
    return j;
  }
  return -1;
}

function findUnescapedCloseBracket(s, from, end) {
  let pos = from;
  while (pos < end) {
    const j = s.indexOf(']', pos);
    if (j === -1 || j >= end) return -1;
    if ((countBackslashesBefore(s, j, from) & 1) === 0) return j;
    pos = j + 1;
  }
  return -1;
}

function hasScheme(s, start, end) {
  if (start >= end) return false;
  const c0 = s.charCodeAt(start);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return false;
  for (let i = start + 1; i < end; i++) {
    const c = s.charCodeAt(i);
    if (c === 58) return true;
    if (c >= 128 || SCHEME_TBL[c] === 0) return false;
  }
  return false;
}

// Per-document markdown render context (avoids passing 8 args through recursive inlineSpan)
let _mdDirInfo = null;
let _mdSourcePath = '';
let _mdResolvedUrlsEsc = null;
let _mdBroken = null;
const _mdIds = new Set();
const H_OPEN = ['', '<h1 id="', '<h2 id="', '<h3 id="', '<h4 id="', '<h5 id="', '<h6 id="'];
const H_CLOSE = ['', '</h1>\n', '</h2>\n', '</h3>\n', '</h4>\n', '</h5>\n', '</h6>\n'];

function makeDirInfo(dirStr) {
  if (dirStr === '') return { str: '', parts: [], prefixes: [''] };
  const parts = dirStr.split('/');
  const prefixes = new Array(parts.length + 1);
  prefixes[0] = '';
  let acc = '';
  for (let i = 0; i < parts.length; i++) {
    acc += parts[i] + '/';
    prefixes[i + 1] = acc;
  }
  return { str: dirStr, parts, prefixes };
}

function resolvePathFast(dirInfo, rel) {
  const rlen = rel.length;
  let up = 0;
  let off = 0;
  while (off + 2 < rlen && rel.charCodeAt(off) === 46 && rel.charCodeAt(off + 1) === 46 && rel.charCodeAt(off + 2) === 47) {
    up++;
    off += 3;
  }
  const parts = dirInfo.parts;
  const keep = parts.length - up;
  if (keep < 0) return null;
  if (off < rlen) {
    const c0 = rel.charCodeAt(off);
    if (
      c0 !== 46 &&
      c0 !== 47 &&
      rel.charCodeAt(rlen - 1) !== 47 &&
      rel.indexOf('..', off) === -1 &&
      rel.indexOf('//', off) === -1 &&
      rel.indexOf('/.', off) === -1
    ) {
      const rem = off === 0 ? rel : rel.slice(off);
      return keep === 0 ? rem : dirInfo.prefixes[keep] + rem;
    }
  }
  // General fallback for edge cases ('.', '..', trailing '/', '//', inner '..')
  const stack = parts.length === 0 ? [] : parts.slice();
  let pos = 0;
  while (pos <= rlen) {
    let sl = rel.indexOf('/', pos);
    if (sl === -1) sl = rlen;
    const segLen = sl - pos;
    if (segLen === 2 && rel.charCodeAt(pos) === 46 && rel.charCodeAt(pos + 1) === 46) {
      if (stack.length === 0) return null;
      stack.pop();
    } else if (segLen > 0 && !(segLen === 1 && rel.charCodeAt(pos) === 46)) {
      stack.push(rel.slice(pos, sl));
    }
    pos = sl + 1;
  }
  return stack.join('/');
}

function resolveLink(s, tStart, tEnd) {
  const c0 = s.charCodeAt(tStart);
  if (c0 === 47 || c0 === 35) {
    return escapeHtmlSpan(s, tStart, tEnd);
  }
  if (c0 !== 46 && hasScheme(s, tStart, tEnd)) {
    return escapeHtmlSpan(s, tStart, tEnd);
  }
  const target = s.slice(tStart, tEnd);
  const hash = target.indexOf('#');
  const rel = hash === -1 ? target : target.slice(0, hash);
  if (rel.length > 0) {
    const path = resolvePathFast(_mdDirInfo, rel);
    if (path !== null) {
      const destEsc = _mdResolvedUrlsEsc.get(path);
      if (destEsc !== undefined) {
        return hash === -1 ? destEsc : destEsc + escapeHtml(target.slice(hash));
      }
    }
  }
  _mdBroken.add('broken-link ' + _mdSourcePath + ' -> ' + target);
  return escapeHtml(target);
}

function inlineSpan(s, start, end) {
  if (start >= end) return '';
  INLINE_RE.lastIndex = start;
  if (!INLINE_RE.test(s) || INLINE_RE.lastIndex - 1 >= end) {
    return s.slice(start, end);
  }
  let out = '';
  let last = start;
  let i = INLINE_RE.lastIndex - 1;
  while (true) {
    const c = s.charCodeAt(i);
    const kind = INLINE_TBL[c];
    if (kind <= 5) {
      if (last < i) out += s.slice(last, i);
      out += HTML_ESC_STR[kind];
      i++;
      last = i;
    } else if (kind === 6) {
      if (i + 1 < end) {
        const nc = s.charCodeAt(i + 1);
        if (nc < 128 && ESCAPABLE_TBL[nc] === 1) {
          if (last < i) out += s.slice(last, i);
          out += nc === 62 ? '&gt;' : ASCII_CHAR[nc];
          i += 2;
          last = i;
        } else {
          i++;
        }
      } else {
        i++;
      }
    } else if (kind === 7) {
      // Backtick: 1-pass C++ Irregexp proves clean code spans with zero escapeHtmlSpan call
      TICK_OR_ESC_RE.lastIndex = i + 1;
      if (TICK_OR_ESC_RE.test(s)) {
        const hit = TICK_OR_ESC_RE.lastIndex - 1;
        if (hit < end) {
          if (s.charCodeAt(hit) === 96) {
            if (hit > i + 1) {
              if (last < i) out += s.slice(last, i);
              out += '<code>' + s.slice(i + 1, hit) + '</code>';
              i = hit + 1;
              last = i;
            } else {
              i++;
            }
          } else {
            const j = s.indexOf('`', hit + 1);
            if (j > i + 1 && j < end) {
              if (last < i) out += s.slice(last, i);
              out += '<code>' + s.slice(i + 1, j).replace(ESC_RE, escCb) + '</code>';
              i = j + 1;
              last = i;
            } else {
              i++;
            }
          }
        } else {
          i++;
        }
      } else {
        i++;
      }
    } else if (kind === 8) {
      if (i + 1 < end && s.charCodeAt(i + 1) === 42) {
        // Strong '**': 1-pass C++ Irregexp proves clean **word** with zero recursion/indexOf
        INLINE_RE.lastIndex = i + 2;
        if (INLINE_RE.test(s)) {
          const hit = INLINE_RE.lastIndex - 1;
          if (hit < end) {
            if (s.charCodeAt(hit) === 42 && hit + 1 < end && s.charCodeAt(hit + 1) === 42) {
              if (hit > i + 2) {
                if (last < i) out += s.slice(last, i);
                out += '<strong>' + s.slice(i + 2, hit) + '</strong>';
                i = hit + 2;
                last = i;
              } else {
                i += 2;
              }
            } else {
              const j = findUnescapedDoubleStar(s, hit, end);
              if (j > i + 2) {
                if (last < i) out += s.slice(last, i);
                out += '<strong>' + inlineSpan(s, i + 2, j) + '</strong>';
                i = j + 2;
                last = i;
              } else {
                i += 2;
              }
            }
          } else {
            i += 2;
          }
        } else {
          i += 2;
        }
      } else {
        // Em '*': 1-pass C++ Irregexp proves clean *word* with zero recursion/indexOf
        INLINE_RE.lastIndex = i + 1;
        if (INLINE_RE.test(s)) {
          const hit = INLINE_RE.lastIndex - 1;
          if (hit < end) {
            if (s.charCodeAt(hit) === 42 && (hit + 1 >= end || s.charCodeAt(hit + 1) !== 42)) {
              if (hit > i + 1) {
                if (last < i) out += s.slice(last, i);
                out += '<em>' + s.slice(i + 1, hit) + '</em>';
                i = hit + 1;
                last = i;
              } else {
                i++;
              }
            } else {
              const j = findSingleStar(s, hit, end);
              if (j > i + 1) {
                if (last < i) out += s.slice(last, i);
                out += '<em>' + inlineSpan(s, i + 1, j) + '</em>';
                i = j + 1;
                last = i;
              } else {
                i++;
              }
            }
          } else {
            i++;
          }
        } else {
          i++;
        }
      }
    } else {
      // kind === 9: '[' — 1-pass C++ Irregexp proves clean link label with zero recursion
      BRACKET_OR_INLINE_RE.lastIndex = i + 1;
      if (BRACKET_OR_INLINE_RE.test(s)) {
        const hit = BRACKET_OR_INLINE_RE.lastIndex - 1;
        if (hit < end) {
          let k;
          let cleanLabel;
          if (s.charCodeAt(hit) === 93) {
            k = hit;
            cleanLabel = true;
          } else {
            k = findUnescapedCloseBracket(s, hit, end);
            cleanLabel = false;
          }
          if (k !== -1 && k + 1 < end && s.charCodeAt(k + 1) === 40) {
            CLOSE_PAREN_OR_WS_RE.lastIndex = k + 2;
            if (CLOSE_PAREN_OR_WS_RE.test(s)) {
              const m = CLOSE_PAREN_OR_WS_RE.lastIndex - 1;
              if (m > k + 2 && m < end && s.charCodeAt(m) === 41) {
                if (last < i) out += s.slice(last, i);
                const href = resolveLink(s, k + 2, m);
                const label = cleanLabel ? s.slice(i + 1, k) : inlineSpan(s, i + 1, k);
                out += '<a href="' + href + '">' + label + '</a>';
                i = m + 1;
                last = i;
              } else {
                i++;
              }
            } else {
              i++;
            }
          } else {
            i++;
          }
        } else {
          i++;
        }
      } else {
        i++;
      }
    }
    if (i >= end) break;
    INLINE_RE.lastIndex = i;
    if (!INLINE_RE.test(s)) break;
    i = INLINE_RE.lastIndex - 1;
    if (i >= end) break;
  }
  if (last === start) return s.slice(start, end);
  if (last < end) out += s.slice(last, end);
  return out;
}

function trimSpacesTabsStart(s, ls, le) {
  while (ls < le && (s.charCodeAt(ls) === 32 || s.charCodeAt(ls) === 9)) ls++;
  return ls;
}

function trimSpacesTabsEnd(s, ls, le) {
  while (le > ls && (s.charCodeAt(le - 1) === 32 || s.charCodeAt(le - 1) === 9)) le--;
  return le;
}

function renderMarkdown(src, bodyStart, dirInfo, sourcePath, resolvedUrlsEsc, broken) {
  _mdDirInfo = dirInfo;
  _mdSourcePath = sourcePath;
  _mdResolvedUrlsEsc = resolvedUrlsEsc;
  _mdBroken = broken;
  _mdIds.clear();

  const len = src.length;
  const toc = [];
  let excerpt = null;
  let html = '';

  let ls = bodyStart;
  let nl = src.indexOf('\n', ls);
  let le = nl === -1 ? len : nl;
  let hasLine = true;

  while (hasLine) {
    if (ls === le) {
      if (nl === -1) break;
      ls = nl + 1;
      nl = src.indexOf('\n', ls);
      le = nl === -1 ? len : nl;
      continue;
    }
    const c0 = src.charCodeAt(ls);
    if ((c0 === 32 || c0 === 9) && isBlankLine(src, ls, le)) {
      if (nl === -1) break;
      ls = nl + 1;
      nl = src.indexOf('\n', ls);
      le = nl === -1 ? len : nl;
      continue;
    }
    // Fence
    if (c0 === 96) {
      const lang = matchFenceOpen(src, ls, le);
      if (lang !== null) {
        if (nl === -1) {
          hasLine = false;
        } else {
          ls = nl + 1;
          nl = src.indexOf('\n', ls);
          le = nl === -1 ? len : nl;
        }
        let bodyBegin = -1;
        let bodyEnd = -1;
        while (hasLine && !isFenceClose(src, ls, le)) {
          if (bodyBegin === -1) bodyBegin = ls;
          bodyEnd = le;
          if (nl === -1) {
            hasLine = false;
          } else {
            ls = nl + 1;
            nl = src.indexOf('\n', ls);
            le = nl === -1 ? len : nl;
          }
        }
        if (hasLine) {
          if (nl === -1) hasLine = false;
          else {
            ls = nl + 1;
            nl = src.indexOf('\n', ls);
            le = nl === -1 ? len : nl;
          }
        }
        const openTag = lang === '' ? '<pre><code>' : '<pre><code class="language-' + lang + '">';
        if (bodyBegin === -1) {
          html += openTag + '</code></pre>\n';
        } else {
          html += openTag + escapeHtmlSpan(src, bodyBegin, bodyEnd) + '\n</code></pre>\n';
        }
        continue;
      }
    }
    // Heading
    if (c0 === 35) {
      const depth = matchHeading(src, ls, le);
      if (depth !== 0) {
        const hs = _hStart;
        const he = _hEnd;
        const hText = src.slice(hs, he);
        const id = uniqueSlug(slugify(hText), _mdIds);
        const inner = inlineSpan(hText, 0, hText.length);
        html += H_OPEN[depth] + id + '">' + inner + H_CLOSE[depth];
        if (depth === 2 || depth === 3) {
          toc.push(_jsonMode ? { level: depth, id, html: inner, $html: jsonSliceFast(inner) } : { level: depth, id, html: inner });
        }
        if (nl === -1) break;
        ls = nl + 1;
        nl = src.indexOf('\n', ls);
        le = nl === -1 ? len : nl;
        continue;
      }
    }
    // HR
    if ((c0 === 45 || c0 === 42) && isHr(src, ls, le)) {
      html += '<hr>\n';
      if (nl === -1) break;
      ls = nl + 1;
      nl = src.indexOf('\n', ls);
      le = nl === -1 ? len : nl;
      continue;
    }
    // Blockquote
    if (c0 === 62) {
      let firstS = -1;
      let firstE = -1;
      let parts = null;
      while (hasLine && ls < le && src.charCodeAt(ls) === 62) {
        let qs = ls + 1;
        if (qs < le && src.charCodeAt(qs) === 32) qs++;
        qs = trimSpacesTabsStart(src, qs, le);
        const qe = trimSpacesTabsEnd(src, qs, le);
        if (qs < qe) {
          if (firstS === -1) {
            firstS = qs;
            firstE = qe;
          } else {
            if (parts === null) parts = src.slice(firstS, firstE) + '\n' + src.slice(qs, qe);
            else parts += '\n' + src.slice(qs, qe);
          }
        }
        if (nl === -1) {
          hasLine = false;
        } else {
          ls = nl + 1;
          nl = src.indexOf('\n', ls);
          le = nl === -1 ? len : nl;
        }
      }
      if (firstS === -1) {
        html += '<blockquote>\n</blockquote>\n';
      } else if (parts === null) {
        html += '<blockquote>\n<p>' + inlineSpan(src, firstS, firstE) + '</p>\n</blockquote>\n';
      } else {
        html += '<blockquote>\n<p>' + inlineSpan(parts, 0, parts.length) + '</p>\n</blockquote>\n';
      }
      continue;
    }
    // List (bullet or ordered)
    const isBullet = (c0 === 45 || c0 === 42) && isBulletLine(src, ls, le);
    const isOrdered = !isBullet && c0 >= 48 && c0 <= 57 && matchOrderedLine(src, ls, le);
    if (isBullet || isOrdered) {
      const startNum = isOrdered ? _ordVal : 1;
      html += isOrdered ? (startNum !== 1 ? '<ol start="' + startNum + '">\n' : '<ol>\n') : '<ul>\n';
      let itemS = trimSpacesTabsStart(src, isOrdered ? _ordTextStart : ls + 2, le);
      let itemE = trimSpacesTabsEnd(src, itemS, le);
      let itemJoined = null;
      if (nl === -1) {
        hasLine = false;
      } else {
        ls = nl + 1;
        nl = src.indexOf('\n', ls);
        le = nl === -1 ? len : nl;
      }
      while (hasLine) {
        if (isOrdered ? matchOrderedLine(src, ls, le) : isBulletLine(src, ls, le)) {
          const inner = itemJoined === null
            ? inlineSpan(src, itemS, itemE)
            : inlineSpan(itemJoined, 0, itemJoined.length);
          html += '<li>' + inner + '</li>\n';
          itemS = trimSpacesTabsStart(src, isOrdered ? _ordTextStart : ls + 2, le);
          itemE = trimSpacesTabsEnd(src, itemS, le);
          itemJoined = null;
          if (nl === -1) {
            hasLine = false;
          } else {
            ls = nl + 1;
            nl = src.indexOf('\n', ls);
            le = nl === -1 ? len : nl;
          }
        } else if (isContinuedLine(src, ls, le)) {
          const cs = trimSpacesTabsStart(src, ls, le);
          const ce = trimSpacesTabsEnd(src, cs, le);
          if (itemJoined === null) {
            itemJoined = src.slice(itemS, itemE) + '\n' + src.slice(cs, ce);
          } else {
            itemJoined += '\n' + src.slice(cs, ce);
          }
          if (nl === -1) {
            hasLine = false;
          } else {
            ls = nl + 1;
            nl = src.indexOf('\n', ls);
            le = nl === -1 ? len : nl;
          }
        } else {
          break;
        }
      }
      const inner = itemJoined === null
        ? inlineSpan(src, itemS, itemE)
        : inlineSpan(itemJoined, 0, itemJoined.length);
      html += '<li>' + inner + (isOrdered ? '</li>\n</ol>\n' : '</li>\n</ul>\n');
      continue;
    }
    // Paragraph
    const pStart0 = ls;
    let pEnd0 = le;
    let pJoined = null;
    if (c0 === 32 || c0 === 9 || src.charCodeAt(le - 1) === 32 || src.charCodeAt(le - 1) === 9) {
      const ts0 = trimSpacesTabsStart(src, ls, le);
      const te0 = trimSpacesTabsEnd(src, ts0, le);
      pJoined = src.slice(ts0, te0);
    }
    if (nl === -1) {
      hasLine = false;
    } else {
      ls = nl + 1;
      nl = src.indexOf('\n', ls);
      le = nl === -1 ? len : nl;
    }
    while (hasLine) {
      if (ls === le) break;
      const pc = src.charCodeAt(ls);
      if (pc > 96 || (pc >= 48 && pc <= 95)) {
        const lc = src.charCodeAt(le - 1);
        if (lc !== 32 && lc !== 9) {
          if (pJoined === null) pEnd0 = le;
          else pJoined += '\n' + src.slice(ls, le);
        } else {
          const te = trimSpacesTabsEnd(src, ls, le);
          if (pJoined === null) pJoined = src.slice(pStart0, pEnd0) + '\n' + src.slice(ls, te);
          else pJoined += '\n' + src.slice(ls, te);
        }
      } else {
        if (endsParagraphLine(src, ls, le)) break;
        const ts = (pc === 32 || pc === 9) ? trimSpacesTabsStart(src, ls, le) : ls;
        const lc = src.charCodeAt(le - 1);
        const te = (lc === 32 || lc === 9) ? trimSpacesTabsEnd(src, ts, le) : le;
        if (pJoined === null && ts === ls && te === le) {
          pEnd0 = le;
        } else if (pJoined === null) {
          pJoined = src.slice(pStart0, pEnd0) + '\n' + src.slice(ts, te);
        } else {
          pJoined += '\n' + src.slice(ts, te);
        }
      }
      if (nl === -1) {
        hasLine = false;
      } else {
        ls = nl + 1;
        nl = src.indexOf('\n', ls);
        le = nl === -1 ? len : nl;
      }
    }
    const inner = pJoined === null
      ? inlineSpan(src, pStart0, pEnd0)
      : inlineSpan(pJoined, 0, pJoined.length);
    if (excerpt === null) excerpt = inner;
    html += '<p>' + inner + '</p>\n';
  }

  return { html, toc, excerpt: excerpt === null ? '' : excerpt };
}

// ---------------------------------------------------------------- templates

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

class TemplateError extends Error {}

function pathOf(name, text) {
  if (!PATH_RE.test(text)) {
    throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  }
  return text.split('.');
}

function tokenizeTemplate(name, src) {
  const tokens = [];
  const len = src.length;
  let text = '';
  let i = 0;
  while (i < len) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === len - 1) {
      text += src.slice(i);
      break;
    }
    const next = src.charCodeAt(open + 1);
    if (next !== 123 && next !== 37) { // '{' or '%'
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    if (open > i) text += src.slice(i, open);
    if (next === 123) {
      const raw = src.charCodeAt(open + 2) === 123;
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) {
        throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      }
      if (text !== '') {
        tokens.push({ t: 0, text });
        text = '';
      }
      tokens.push({ t: raw ? 2 : 1, path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) {
      throw new TemplateError(`template "${name}": a {% is not closed`);
    }
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? len : nl;
    const standalone = isBlankLine(src, lineStart, open) && isBlankLine(src, end, lineEnd);
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') {
      tokens.push({ t: 0, text });
      text = '';
    }
    tokens.push({ t: 3, tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? len : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 0, text });
  return tokens;
}

function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  const tokens = tokenizeTemplate(name, src);
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok.t === 0) {
      body.push({ kind: 0, text: tok.text });
    } else if (tok.t === 1 || tok.t === 2) {
      body.push({ kind: tok.t, path: tok.path });
    } else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 4, name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 3, not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 3 || top.else !== null) {
          throw new TemplateError(`template "${name}": an else outside an if`);
        }
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        const expectKind = tag === 'endfor' ? 4 : 3;
        if (top.kind !== expectKind) {
          throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        }
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 4 ? parent.body : (parent.else ?? parent.then);
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) {
        body.push({ kind: 5, name: m[1] });
      } else {
        throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
      }
    }
  }
  if (stack.length > 1) {
    const topKind = stack[stack.length - 1].kind === 4 ? 'for' : 'if';
    throw new TemplateError(`template "${name}": a ${topKind} is not closed`);
  }
  return root.body;
}

// Runtime helpers for template evaluation
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) {
    const len = v.length;
    if (len === 0) return '';
    let s = textOf(v[0]);
    for (let i = 1; i < len; i++) s += ', ' + textOf(v[i]);
    return s;
  }
  return '';
}

function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

function propLookup(v, path) {
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

function renderVarValue(v) {
  if (typeof v === 'string') return escapeHtml(v);
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return escapeHtml(textOf(v));
  return '';
}

function renderRawValue(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return textOf(v);
  return '';
}

function renderVarValueExec(v) {
  const s = renderVarValue(v);
  return _jsonMode ? jsonSliceFast(s) : s;
}

function renderRawValueExec(v) {
  const s = renderRawValue(v);
  return _jsonMode ? jsonSliceFast(s) : s;
}

function jsonifyOps(ops) {
  for (let i = 0; i < ops.length; i++) {
    const o = ops[i];
    if (o.op === 0) {
      o.text = jsonSliceAlways(o.text);
    } else if (o.op === 8) {
      jsonifyOps(o.thenOps);
      if (o.elseOps !== null) jsonifyOps(o.elseOps);
    } else if (o.op === 9) {
      jsonifyOps(o.bodyOps);
    }
  }
}

const PLAIN_KEY_RE = /^[\x20-\x21\x23-\x5b\x5d-\x7e]*$/;
let _outBuf = Buffer.allocUnsafe(2097152);
let _outFd = -1;
let _writeSync = null;
let _chunk = '';

function flushChunk() {
  const clen = _chunk.length;
  if (clen === 0) return;
  FLAT_RE.test(_chunk);
  const maxBytes = clen * 3;
  if (maxBytes > _outBuf.length) _outBuf = Buffer.allocUnsafe(maxBytes);
  const n = _outBuf.write(_chunk, 0, 'utf8');
  _writeSync(_outFd, _outBuf, 0, n);
  _chunk = '';
}

function emitEntry(k, vs, first, knownPlain) {
  if (knownPlain || PLAIN_KEY_RE.test(k)) {
    _chunk += (first ? '"' : ',"') + k + '":"' + vs + '"';
  } else {
    _chunk += (first ? '' : ',') + JSON.stringify(k) + ':"' + vs + '"';
  }
  if (_chunk.length >= 262144) flushChunk();
}

const ALWAYS_SAFE_HTML_KEYS = new Set([
  'date', 'date_long', 'slug', 'id',
  'reading_minutes', 'level', 'count', 'number', 'total',
  'index', 'length', 'first', 'last', 'is_post',
]);
const URL_SAFE_HTML_KEYS = new Set(['url', 'newer_url', 'older_url', 'base_url']);

// Compiled specialized ops:
// op 0: text { op: 0, text }
// op 1: var1 { op: 1, slot }
// op 2: var2 { op: 2, slot, k1 }
// op 3: var3 { op: 3, slot, k1, k2 }
// op 4: varN { op: 4, slot, path }
// op 5: raw1 { op: 5, slot }
// op 6: raw2 { op: 6, slot, k1 }
// op 7: rawN { op: 7, slot, path }
// op 8: if   { op: 8, slot, path, k1, k2, plen, not, thenOps, elseOps }
// op 9: for  { op: 9, slot, path, k1, k2, plen, itemSlot, loopSlot, needsLoop, bodyOps, itemCache }
// op 10: raw3 { op: 10, slot, k1, k2 }

function evalPathSlot(stack, slot, path, plen, k1, k2) {
  let v = stack[slot];
  if (plen === 1) return v;
  if (v === null || typeof v !== 'object' || !Object.hasOwn(v, k1)) return undefined;
  v = v[k1];
  if (plen === 2) return v;
  if (v === null || typeof v !== 'object' || !Object.hasOwn(v, k2)) return undefined;
  v = v[k2];
  if (plen === 3) return v;
  for (let i = 3; i < plen; i++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[i])) return undefined;
    v = v[path[i]];
  }
  return v;
}

function execOps(ops, stack) {
  if (ops.length === 1 && ops[0].op === 0) return ops[0].text;
  let out = '';
  const len = ops.length;
  for (let i = 0; i < len; i++) {
    const o = ops[i];
    switch (o.op) {
      case 0:
        out += o.text;
        break;
      case 1:
        out += renderVarValueExec(stack[o.slot]);
        break;
      case 2: {
        const obj = stack[o.slot];
        if (obj !== null && typeof obj === 'object' && Object.hasOwn(obj, o.k1)) {
          out += renderVarValueExec(obj[o.k1]);
        }
        break;
      }
      case 3: {
        const obj = stack[o.slot];
        if (obj !== null && typeof obj === 'object' && Object.hasOwn(obj, o.k1)) {
          const v1 = obj[o.k1];
          if (v1 !== null && typeof v1 === 'object' && Object.hasOwn(v1, o.k2)) {
            out += renderVarValueExec(v1[o.k2]);
          }
        }
        break;
      }
      case 4:
        out += renderVarValueExec(evalPathSlot(stack, o.slot, o.path, o.plen, o.k1, o.k2));
        break;
      case 5:
        out += renderRawValueExec(stack[o.slot]);
        break;
      case 6: {
        const obj = stack[o.slot];
        if (obj !== null && typeof obj === 'object' && Object.hasOwn(obj, o.k1)) {
          const v = obj[o.k1];
          if (typeof v === 'string') out += v;
          else if (typeof v === 'number') out += v;
          else if (typeof v === 'boolean') out += v ? 'true' : 'false';
          else if (Array.isArray(v)) out += textOf(v);
        }
        break;
      }
      case 10: {
        const obj = stack[o.slot];
        if (obj !== null && typeof obj === 'object' && Object.hasOwn(obj, o.k1)) {
          const v1 = obj[o.k1];
          if (v1 !== null && typeof v1 === 'object' && Object.hasOwn(v1, o.k2)) {
            const v = v1[o.k2];
            if (typeof v === 'string') out += v;
            else if (typeof v === 'number') out += v;
            else if (typeof v === 'boolean') out += v ? 'true' : 'false';
            else if (Array.isArray(v)) out += textOf(v);
          }
        }
        break;
      }
      case 11: {
        const obj = stack[o.slot];
        if (obj !== null && typeof obj === 'object' && Object.hasOwn(obj, o.k1)) {
          out += renderRawValueExec(obj[o.k1]);
        }
        break;
      }
      case 12: {
        const obj = stack[o.slot];
        if (obj !== null && typeof obj === 'object' && Object.hasOwn(obj, o.k1)) {
          const v1 = obj[o.k1];
          if (v1 !== null && typeof v1 === 'object' && Object.hasOwn(v1, o.k2)) {
            out += renderRawValueExec(v1[o.k2]);
          }
        }
        break;
      }
      case 7:
        out += renderRawValueExec(evalPathSlot(stack, o.slot, o.path, o.plen, o.k1, o.k2));
        break;
      case 8: {
        let v;
        if (o.plen === 2) {
          const obj = stack[o.slot];
          v = (obj !== null && typeof obj === 'object' && Object.hasOwn(obj, o.k1)) ? obj[o.k1] : undefined;
        } else {
          v = evalPathSlot(stack, o.slot, o.path, o.plen, o.k1, o.k2);
        }
        const ok = Array.isArray(v) ? v.length > 0 : (v !== undefined && v !== null && v !== false && v !== '' && v !== 0);
        const branch = ok !== o.not ? o.thenOps : o.elseOps;
        if (branch !== null) out += execOps(branch, stack);
        break;
      }
      case 9: {
        let xs;
        if (o.plen === 2) {
          const obj = stack[o.slot];
          xs = (obj !== null && typeof obj === 'object' && Object.hasOwn(obj, o.k1)) ? obj[o.k1] : undefined;
        } else {
          xs = evalPathSlot(stack, o.slot, o.path, o.plen, o.k1, o.k2);
        }
        if (!Array.isArray(xs)) break;
        const xlen = xs.length;
        if (xlen === 0) break;
        const itemSlot = o.itemSlot;
        const bodyOps = o.bodyOps;
        const cache = o.itemCache;
        if (cache !== null) {
          for (let k = 0; k < xlen; k++) {
            const item = xs[k];
            let s = cache.get(item);
            if (s === undefined) {
              stack[itemSlot] = item;
              s = execOps(bodyOps, stack);
              cache.set(item, s);
            }
            out += s;
          }
        } else if (o.needsLoop) {
          const loopSlot = o.loopSlot;
          const lastIdx = xlen - 1;
          for (let k = 0; k < xlen; k++) {
            stack[itemSlot] = xs[k];
            stack[loopSlot] = { index: k + 1, first: k === 0, last: k === lastIdx, length: xlen };
            out += execOps(bodyOps, stack);
          }
        } else {
          for (let k = 0; k < xlen; k++) {
            stack[itemSlot] = xs[k];
            out += execOps(bodyOps, stack);
          }
        }
        break;
      }
    }
  }
  return out;
}

function specializeTemplate(
  nodes,
  templates,
  constRoot,
  dynRootSlots,
  guaranteedTruthyRoots,
  sharedPureCaches,
  baseSafe,
  sitePureIncludeCache
) {
  const frames = [];
  let nextSlot = dynRootSlots.size;

  function resolveBinding(rootName) {
    for (let i = frames.length - 1; i >= 0; i--) {
      const f = frames[i];
      if (rootName === 'loop') {
        if (f.isConst) return { isConst: true, value: f.loop };
        f.usesLoop = true;
        return { isConst: false, slot: f.loopSlot, frameIdx: i };
      }
      if (rootName === f.name) {
        if (f.isConst) return { isConst: true, value: f.item };
        return { isConst: false, slot: f.itemSlot, frameIdx: i };
      }
    }
    const dynSlot = dynRootSlots.get(rootName);
    if (dynSlot !== undefined) {
      return { isConst: false, slot: dynSlot, frameIdx: -1, rootName };
    }
    if (Object.hasOwn(constRoot, rootName)) {
      return { isConst: true, value: constRoot[rootName], rootName };
    }
    return { isConst: true, value: undefined, rootName };
  }

  function appendText(out, str) {
    if (str === '') return;
    const n = out.length;
    if (n > 0 && out[n - 1].op === 0) out[n - 1].text += str;
    else out.push({ op: 0, text: str });
  }

  function makeVarOp(isRaw, slot, path) {
    const plen = path.length;
    if (isRaw) {
      if (!_jsonMode) {
        if (plen === 1) return { op: 5, slot };
        if (plen === 2) return { op: 6, slot, k1: path[1] };
        if (plen === 3) return { op: 10, slot, k1: path[1], k2: path[2] };
        return { op: 7, slot, path, plen, k1: path[1], k2: path[2] };
      }
      if (plen >= 2) {
        const last = path[plen - 1];
        let mappedLast = null;
        if (last === 'content') mappedLast = '$content';
        else if (last === 'excerpt') mappedLast = '$excerpt';
        else if (last === 'html') mappedLast = '$html';
        else if (ALWAYS_SAFE_HTML_KEYS.has(last) || (baseSafe && URL_SAFE_HTML_KEYS.has(last))) {
          mappedLast = last;
        }
        if (mappedLast !== null) {
          if (plen === 2) return { op: 6, slot, k1: mappedLast };
          if (plen === 3) return { op: 10, slot, k1: path[1], k2: mappedLast };
        }
      }
      if (plen === 1) return { op: 5, slot };
      if (plen === 2) return { op: 11, slot, k1: path[1] };
      if (plen === 3) return { op: 12, slot, k1: path[1], k2: path[2] };
      return { op: 7, slot, path, plen, k1: path[1], k2: path[2] };
    }
    if (plen >= 2) {
      const last = path[plen - 1];
      let mappedLast = null;
      if (last === 'title') mappedLast = '$title';
      else if (last === 'summary') mappedLast = '$summary';
      else if (last === 'name') mappedLast = '$name';
      else if (ALWAYS_SAFE_HTML_KEYS.has(last) || (baseSafe && URL_SAFE_HTML_KEYS.has(last))) {
        mappedLast = last;
      }
      if (mappedLast !== null) {
        if (plen === 2) return { op: 6, slot, k1: mappedLast };
        if (plen === 3) return { op: 10, slot, k1: path[1], k2: mappedLast };
        if (!_jsonMode) {
          const p2 = path.slice();
          p2[plen - 1] = mappedLast;
          return { op: 7, slot, path: p2, plen, k1: p2[1], k2: p2[2] };
        }
      }
    }
    if (plen === 1) return { op: 1, slot };
    if (plen === 2) return { op: 2, slot, k1: path[1] };
    if (plen === 3) return { op: 3, slot, k1: path[1], k2: path[2] };
    return { op: 4, slot, path, plen, k1: path[1], k2: path[2] };
  }

  // info tracks purity for enclosing dynamic loops:
  // minSlotUsed: smallest dynamic slot accessed (if < loop.itemSlot, touches outer dynamic)
  // touchesNonSiteRoot: true if any root var outside {site, tags, recent} was read (even if undefined)
  function compileList(list, depth, out, info) {
    for (let i = 0; i < list.length; i++) {
      const n = list[i];
      if (n.kind === 0) {
        appendText(out, n.text);
      } else if (n.kind === 1 || n.kind === 2) {
        const isRaw = n.kind === 2;
        const b = resolveBinding(n.path[0]);
        if (b.rootName !== undefined && !Object.hasOwn(constRoot, b.rootName)) {
          info.touchesNonSiteRoot = true;
        }
        if (b.isConst) {
          const val = n.path.length === 1 ? b.value : propLookup(b.value, n.path);
          appendText(out, isRaw ? renderRawValue(val) : renderVarValue(val));
        } else {
          if (b.slot < info.minSlot) info.minSlot = b.slot;
          out.push(makeVarOp(isRaw, b.slot, n.path));
        }
      } else if (n.kind === 3) {
        // if
        const b = resolveBinding(n.path[0]);
        if (b.rootName !== undefined && !Object.hasOwn(constRoot, b.rootName)) {
          info.touchesNonSiteRoot = true;
        }
        if (b.isConst) {
          const val = n.path.length === 1 ? b.value : propLookup(b.value, n.path);
          const branch = truthy(val) !== n.not ? n.then : n.else;
          if (branch !== null) compileList(branch, depth, out, info);
        } else if (n.path.length === 1 && b.frameIdx === -1 && guaranteedTruthyRoots.has(b.rootName)) {
          // Guaranteed truthy root object (e.g. page in page/post layout, tag in tag layout, pager in index layout)
          const branch = (true !== n.not) ? n.then : n.else;
          if (branch !== null) compileList(branch, depth, out, info);
        } else {
          if (b.slot < info.minSlot) info.minSlot = b.slot;
          const thenOps = [];
          compileList(n.then, depth, thenOps, info);
          let elseOps = null;
          if (n.else !== null) {
            elseOps = [];
            compileList(n.else, depth, elseOps, info);
            if (elseOps.length === 0) elseOps = null;
          }
          if (thenOps.length > 0 || elseOps !== null) {
            const plen = n.path.length;
            out.push({
              op: 8,
              slot: b.slot,
              path: n.path,
              plen,
              k1: plen > 1 ? n.path[1] : '',
              k2: plen > 2 ? n.path[2] : '',
              not: n.not,
              thenOps,
              elseOps,
            });
          }
        }
      } else if (n.kind === 4) {
        // for
        const b = resolveBinding(n.path[0]);
        if (b.rootName !== undefined && !Object.hasOwn(constRoot, b.rootName)) {
          info.touchesNonSiteRoot = true;
        }
        if (b.isConst) {
          const xs = n.path.length === 1 ? b.value : propLookup(b.value, n.path);
          if (!Array.isArray(xs) || xs.length === 0) continue;
          const xlen = xs.length;
          const lastIdx = xlen - 1;
          for (let k = 0; k < xlen; k++) {
            frames.push({
              isConst: true,
              name: n.name,
              item: xs[k],
              loop: { index: k + 1, first: k === 0, last: k === lastIdx, length: xlen },
            });
            compileList(n.body, depth, out, info);
            frames.pop();
          }
        } else {
          if (b.slot < info.minSlot) info.minSlot = b.slot;
          const itemSlot = nextSlot;
          const loopSlot = nextSlot + 1;
          nextSlot += 2;
          const frame = { isConst: false, name: n.name, itemSlot, loopSlot, usesLoop: false };
          frames.push(frame);
          const bodyInfo = { minSlot: 1e9, touchesNonSiteRoot: false };
          const bodyOps = [];
          compileList(n.body, depth, bodyOps, bodyInfo);
          frames.pop();

          if (bodyInfo.minSlot < info.minSlot) info.minSlot = bodyInfo.minSlot;
          if (bodyInfo.touchesNonSiteRoot) info.touchesNonSiteRoot = true;

          if (bodyOps.length > 0) {
            // Check if loop body is item-pure (depends ONLY on itemSlot and site globals)
            let itemCache = null;
            const isItemPure = bodyInfo.minSlot >= itemSlot && !frame.usesLoop && !bodyInfo.touchesNonSiteRoot;
            if (isItemPure) {
              // If body is a single include (e.g. {% include "card" %}), share cache across layouts!
              if (n.body.length === 1 && n.body[0].kind === 5 && depth < INCLUDE_DEPTH) {
                const key = n.body[0].name + '\0' + n.name + '\0' + depth;
                itemCache = sharedPureCaches.get(key);
                if (itemCache === undefined) {
                  itemCache = new Map();
                  sharedPureCaches.set(key, itemCache);
                }
              } else {
                itemCache = new Map();
              }
            }
            const plen = n.path.length;
            out.push({
              op: 9,
              slot: b.slot,
              path: n.path,
              plen,
              k1: plen > 1 ? n.path[1] : '',
              k2: plen > 2 ? n.path[2] : '',
              itemSlot,
              loopSlot,
              needsLoop: frame.usesLoop,
              bodyOps,
              itemCache,
            });
          }
        }
      } else if (n.kind === 5) {
        // include
        const tpl = templates.get(n.name);
        if (tpl !== undefined && depth < INCLUDE_DEPTH) {
          if (frames.length === 0) {
            const cKey = n.name + '\0' + depth;
            const cachedStr = sitePureIncludeCache.get(cKey);
            if (cachedStr !== undefined) {
              appendText(out, cachedStr);
              continue;
            }
            const subOut = [];
            const subInfo = { minSlot: 1e9, touchesNonSiteRoot: false };
            compileList(tpl, depth + 1, subOut, subInfo);
            if (subInfo.minSlot < info.minSlot) info.minSlot = subInfo.minSlot;
            if (subInfo.touchesNonSiteRoot) info.touchesNonSiteRoot = true;
            if (!subInfo.touchesNonSiteRoot && subInfo.minSlot === 1e9) {
              const folded = subOut.length === 0 ? '' : subOut[0].text;
              sitePureIncludeCache.set(cKey, folded);
              appendText(out, folded);
            } else {
              for (let j = 0; j < subOut.length; j++) {
                const so = subOut[j];
                if (so.op === 0) appendText(out, so.text);
                else out.push(so);
              }
            }
          } else {
            compileList(tpl, depth + 1, out, info);
          }
        }
      }
    }
  }

  const ops = [];
  const rootInfo = { minSlot: 1e9, touchesNonSiteRoot: false };
  compileList(nodes, 0, ops, rootInfo);
  if (_jsonMode) jsonifyOps(ops);
  return { ops, slots: nextSlot };
}

function templateMentionsKey(nodes, templates, targetKey, depth) {
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (n.kind === 1 || n.kind === 2) {
      const p = n.path;
      for (let j = 0; j < p.length; j++) if (p[j] === targetKey) return true;
    } else if (n.kind === 3) {
      const p = n.path;
      for (let j = 0; j < p.length; j++) if (p[j] === targetKey) return true;
      if (templateMentionsKey(n.then, templates, targetKey, depth)) return true;
      if (n.else !== null && templateMentionsKey(n.else, templates, targetKey, depth)) return true;
    } else if (n.kind === 4) {
      const p = n.path;
      for (let j = 0; j < p.length; j++) if (p[j] === targetKey) return true;
      if (templateMentionsKey(n.body, templates, targetKey, depth)) return true;
    } else if (n.kind === 5 && depth < INCLUDE_DEPTH) {
      const sub = templates.get(n.name);
      if (sub !== undefined && templateMentionsKey(sub, templates, targetKey, depth + 1)) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------- build pipeline

function dirOf(path) {
  const sl = path.lastIndexOf('/');
  return sl === -1 ? '' : path.slice(0, sl);
}

export function run(input, jsonMode = false) {
  _jsonMode = jsonMode;
  // 1. Parse templates in code-unit order of name
  const templates = new Map();
  const reportLines = [];
  const tplNames = Object.keys(input.templates).sort(byCodeUnits);
  for (let i = 0; i < tplNames.length; i++) {
    const name = tplNames[i];
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      reportLines.push(err.message);
    }
  }

  let base = input.site.base_url;
  let baseEnd = base.length;
  while (baseEnd > 0 && base.charCodeAt(baseEnd - 1) === 47) baseEnd--;
  if (baseEnd !== base.length) base = base.slice(0, baseEnd);
  let baseSafe = escapeHtml(base) === base && (!jsonMode || !JSON_ESC_TEST_RE.test(base));

  // Check which layouts ever mention reading_minutes (skip word counting on layouts that don't!)
  const layoutNeedsReadingMinutes = new Map();
  let anyPostCardNeedsRM = false;
  for (const [name, ast] of templates) {
    const needs = templateMentionsKey(ast, templates, 'reading_minutes', 0);
    layoutNeedsReadingMinutes.set(name, needs);
    if (needs && (name === 'index' || name === 'tag' || name === 'tags' || name === 'post')) {
      anyPostCardNeedsRM = true;
    }
  }
  // If any template at all references reading_minutes (e.g. via recent/nav), posts need it
  if (!anyPostCardNeedsRM) {
    for (const needs of layoutNeedsReadingMinutes.values()) {
      if (needs) { anyPostCardNeedsRM = true; break; }
    }
  }

  // 2. Sort input files by path in code-unit order
  const rawFiles = input.files.slice().sort((x, y) => byCodeUnits(x.path, y.path));

  // 3. Separate sources vs statics, normalize CR, parse front matter, filter refused/drafts
  const sources = [];
  const statics = [];
  const resolvedUrlsEsc = new Map();

  for (let i = 0; i < rawFiles.length; i++) {
    const f = rawFiles[i];
    const path = f.path;
    if (!path.endsWith('.md')) {
      statics.push(f);
      const staticUrl = base + '/' + path;
      resolvedUrlsEsc.set(path, escapeHtml(staticUrl));
      continue;
    }
    let text = f.content;
    if (text.indexOf('\r') !== -1) {
      text = text.replace(/\r\n?/g, '\n');
    }
    const data = parseFrontMatter(text);
    if (data === null) {
      reportLines.push('refused ' + path + ': ' + _fmErr);
      continue;
    }
    const isPost = path.startsWith('posts/');
    if (!isPost) {
      if (path.startsWith('tags/')) {
        reportLines.push('refused ' + path + ": tags/ is the generator's own");
        continue;
      }
      if (path.startsWith('page/')) {
        reportLines.push('refused ' + path + ": page/ is the generator's own");
        continue;
      }
    } else if (data.date === undefined) {
      reportLines.push('refused ' + path + ': a post needs a date');
      continue;
    }
    const layout = data.layout !== undefined ? data.layout : (isPost ? 'post' : 'page');
    if (!templates.has(layout)) {
      reportLines.push('refused ' + path + ': layout "' + layout + '" is no template that parses');
      continue;
    }
    if (data.draft === true) {
      reportLines.push('draft ' + path);
      continue;
    }
    const srcDir = dirOf(path);
    if (!isPost && baseSafe && srcDir !== '') {
      if (ESC_TEST_RE.test(srcDir) || (jsonMode && JSON_ESC_TEST_RE.test(srcDir))) baseSafe = false;
    }
    sources.push({
      path,
      srcDir,
      text,
      bodyStart: _fmBodyStart,
      data,
      post: isPost,
      layout,
      slug: '',
      outDir: '',
      url: '',
      html: '',
      toc: null,
      excerpt: '',
      readingMinutes: 1,
      newer: null,
      older: null,
      tagLinks: null,
      card: null,
    });
  }

  // 4. Permalinks
  const takenByDir = new Map();
  takenByDir.set('', new Set(RESERVED));
  const dirInfoCache = new Map();
  dirInfoCache.set('', makeDirInfo(''));

  for (let i = 0; i < sources.length; i++) {
    const s = sources[i];
    const dir = s.post ? 'posts' : s.srcDir;
    let taken = takenByDir.get(dir);
    if (taken === undefined) {
      taken = new Set();
      takenByDir.set(dir, taken);
    }
    const rawSlug = s.data.slug !== undefined ? s.data.slug : slugify(s.data.title);
    const slug = uniqueSlug(rawSlug, taken);
    const outDir = dir === '' ? slug : dir + '/' + slug;
    const url = base + '/' + outDir + '/';
    s.slug = slug;
    s.outDir = outDir;
    s.url = url;
    resolvedUrlsEsc.set(s.path, baseSafe ? url : escapeHtml(url));
  }

  // 5. Markdown + word count (only when needed)
  const broken = new Set();
  for (let i = 0; i < sources.length; i++) {
    const s = sources[i];
    const dirStr = s.srcDir;
    let dirInfo = dirInfoCache.get(dirStr);
    if (dirInfo === undefined) {
      dirInfo = makeDirInfo(dirStr);
      dirInfoCache.set(dirStr, dirInfo);
    }
    const md = renderMarkdown(s.text, s.bodyStart, dirInfo, s.path, resolvedUrlsEsc, broken);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
    if ((s.post && anyPostCardNeedsRM) || layoutNeedsReadingMinutes.get(s.layout)) {
      s.readingMinutes = readingMinutesOf(s.text, s.bodyStart);
    }
    s.text = '';
  }

  // 6. Collections (posts newest first, then slug)
  const posts = [];
  let pageCount = 0;
  for (let i = 0; i < sources.length; i++) {
    const s = sources[i];
    if (s.post) posts.push(s);
    else pageCount++;
  }
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  for (let k = 0; k < posts.length; k++) {
    const p = posts[k];
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  }

  // 7. Tags
  const tagBySlug = new Map();
  for (let i = 0; i < posts.length; i++) {
    const p = posts[i];
    const rawTags = p.data.tags;
    if (rawTags === undefined || rawTags.length === 0) {
      p.tagLinks = [];
      continue;
    }
    const rlen = rawTags.length;
    const links = [];
    const seen = rlen > 16 ? new Set() : null;
    for (let j = 0; j < rlen; j++) {
      const name = rawTags[j];
      const slug = slugify(name);
      if (seen !== null) {
        if (seen.has(slug)) continue;
        seen.add(slug);
      } else {
        let dup = false;
        for (let q = 0; q < links.length; q++) {
          if (links[q].slug === slug) { dup = true; break; }
        }
        if (dup) continue;
      }
      let tag = tagBySlug.get(slug);
      if (tag === undefined) {
        const url = base + '/tags/' + slug + '/';
        const rawEsc = escapeHtml(name);
        const nameEsc = jsonMode ? jsonSliceFast(rawEsc) : rawEsc;
        tag = { name, $name: nameEsc, slug, url, posts: [], link: { name, $name: nameEsc, slug, url } };
        tagBySlug.set(slug, tag);
      }
      tag.posts.push(p);
      links.push(tag.link);
    }
    p.tagLinks = links;
  }

  for (let i = 0; i < sources.length; i++) {
    const s = sources[i];
    if (s.post) continue;
    const rawTags = s.data.tags;
    if (rawTags === undefined || rawTags.length === 0) {
      s.tagLinks = [];
      continue;
    }
    const rlen = rawTags.length;
    const links = [];
    const seen = rlen > 16 ? new Set() : null;
    for (let j = 0; j < rlen; j++) {
      const name = rawTags[j];
      const slug = slugify(name);
      if (seen !== null) {
        if (seen.has(slug)) continue;
        seen.add(slug);
      } else {
        let dup = false;
        for (let q = 0; q < links.length; q++) {
          if (links[q].slug === slug) { dup = true; break; }
        }
        if (dup) continue;
      }
      const existing = tagBySlug.get(slug);
      if (existing !== undefined) {
        links.push(existing.link);
      } else {
        const rawEsc = escapeHtml(name);
        links.push({ name, $name: jsonMode ? jsonSliceFast(rawEsc) : rawEsc, slug, url: '' });
      }
    }
    s.tagLinks = links;
  }

  const sortedTags = Array.from(tagBySlug.values()).sort(
    (x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug)
  );

  // Build cards for all posts once (with pre-escaped $title and $summary)
  for (let i = 0; i < posts.length; i++) {
    const p = posts[i];
    const date = p.data.date;
    const title = p.data.title;
    const summary = p.data.summary !== undefined ? p.data.summary : '';
    const rawTitleEsc = escapeHtml(title);
    const rawSumEsc = summary === '' ? '' : escapeHtml(summary);
    p.card = {
      title,
      $title: jsonMode ? jsonSliceFast(rawTitleEsc) : rawTitleEsc,
      url: p.url,
      date,
      date_long: longDate(date),
      summary,
      $summary: jsonMode ? jsonSliceFast(rawSumEsc) : rawSumEsc,
      excerpt: p.excerpt,
      $excerpt: jsonMode ? jsonSliceAlways(p.excerpt) : p.excerpt,
      reading_minutes: p.readingMinutes,
      tags: p.tagLinks,
    };
  }

  // Build shared constant root values
  const siteTitle = input.site.title;
  const rawSiteTitleEsc = escapeHtml(siteTitle);
  const siteObj = { title: siteTitle, $title: jsonMode ? jsonSliceFast(rawSiteTitleEsc) : rawSiteTitleEsc, base_url: base };
  const allTags = new Array(sortedTags.length);
  for (let i = 0; i < sortedTags.length; i++) {
    const t = sortedTags[i];
    allTags[i] = { name: t.name, $name: t.$name, slug: t.slug, url: t.url, count: t.posts.length };
  }
  const recentCount = Math.min(posts.length, input.site.recent);
  const recent = new Array(recentCount);
  for (let i = 0; i < recentCount; i++) recent[i] = posts[i].card;

  const constRoot = { site: siteObj, tags: allTags, recent };
  const sharedPureCaches = new Map();
  const sitePureIncludeCache = new Map();

  // Compile specialized layouts on demand
  const pageLayoutCache = new Map();
  const pageDynSlots = new Map([['page', 0]]);
  const pageTruthy = new Set(['page']);

  function getPageLayout(name) {
    let compiled = pageLayoutCache.get(name);
    if (compiled === undefined) {
      compiled = specializeTemplate(
        templates.get(name),
        templates,
        constRoot,
        pageDynSlots,
        pageTruthy,
        sharedPureCaches,
        baseSafe,
        sitePureIncludeCache
      );
      pageLayoutCache.set(name, compiled);
    }
    return compiled;
  }

  // Link record helper (cached per post for newer/older neighbors)
  const postLinks = new Map();
  function linkOfPost(p) {
    if (p === null) return null;
    let l = postLinks.get(p);
    if (l === undefined) {
      const c = p.card;
      l = { title: c.title, $title: c.$title, url: c.url, date: c.date, date_long: c.date_long };
      postLinks.set(p, l);
    }
    return l;
  }

  // 8. Render layouts
  const stack = new Array(32);
  const pageObj = {
    title: '',
    $title: '',
    url: '',
    date: '',
    date_long: '',
    summary: '',
    $summary: '',
    excerpt: '',
    $excerpt: '',
    reading_minutes: 1,
    tags: null,
    slug: '',
    content: '',
    $content: '',
    toc: null,
    newer: null,
    older: null,
    is_post: false,
  };

  if (jsonMode) {
    const builtPaths = statics.length > 0 ? new Set() : null;
    let firstEntry = true;

    for (let i = 0; i < sources.length; i++) {
      const s = sources[i];
      const compiled = getPageLayout(s.layout);
      if (s.post) {
        const c = s.card;
        pageObj.title = c.title;
        pageObj.$title = c.$title;
        pageObj.url = c.url;
        pageObj.date = c.date;
        pageObj.date_long = c.date_long;
        pageObj.summary = c.summary;
        pageObj.$summary = c.$summary;
        pageObj.excerpt = c.excerpt;
        pageObj.$excerpt = c.$excerpt;
        pageObj.reading_minutes = c.reading_minutes;
        pageObj.tags = c.tags;
        pageObj.slug = s.slug;
        pageObj.content = s.html;
        pageObj.$content = jsonSliceAlways(s.html);
        pageObj.toc = s.toc;
        pageObj.newer = linkOfPost(s.newer);
        pageObj.older = linkOfPost(s.older);
        pageObj.is_post = true;
      } else {
        const d = s.data.date;
        const title = s.data.title;
        const summary = s.data.summary !== undefined ? s.data.summary : '';
        const rawTitleEsc = escapeHtml(title);
        const rawSumEsc = summary === '' ? '' : escapeHtml(summary);
        pageObj.title = title;
        pageObj.$title = jsonSliceFast(rawTitleEsc);
        pageObj.url = s.url;
        pageObj.date = d !== undefined ? d : '';
        pageObj.date_long = d !== undefined ? longDate(d) : '';
        pageObj.summary = summary;
        pageObj.$summary = jsonSliceFast(rawSumEsc);
        pageObj.excerpt = s.excerpt;
        pageObj.$excerpt = jsonSliceFast(s.excerpt);
        pageObj.reading_minutes = s.readingMinutes;
        pageObj.tags = s.tagLinks;
        pageObj.slug = s.slug;
        pageObj.content = s.html;
        pageObj.$content = jsonSliceAlways(s.html);
        pageObj.toc = s.toc;
        pageObj.newer = null;
        pageObj.older = null;
        pageObj.is_post = false;
      }
      stack[0] = pageObj;
      const outPath = s.outDir + '/index.html';
      if (builtPaths !== null) builtPaths.add(outPath);
      emitEntry(outPath, execOps(compiled.ops, stack), firstEntry, baseSafe);
      firstEntry = false;
      s.html = '';
    }

    const indexTpl = templates.get('index');
    if (indexTpl !== undefined) {
      const compiledIndex = specializeTemplate(
        indexTpl,
        templates,
        constRoot,
        new Map([['posts', 0], ['pager', 1]]),
        new Set(['pager']),
        sharedPureCaches,
        baseSafe,
        sitePureIncludeCache
      );
      const per = input.site.per_page;
      const totalPages = Math.max(1, Math.ceil(posts.length / per));
      const pagerObj = { number: 1, total: totalPages, url: '', newer_url: '', older_url: '' };
      for (let k = 1; k <= totalPages; k++) {
        const start = (k - 1) * per;
        const end = Math.min(posts.length, k * per);
        const sliceCards = new Array(end - start);
        for (let j = start; j < end; j++) sliceCards[j - start] = posts[j].card;
        pagerObj.number = k;
        pagerObj.url = k === 1 ? base + '/' : base + '/page/' + k + '/';
        pagerObj.newer_url = k === 1 ? '' : (k === 2 ? base + '/' : base + '/page/' + (k - 1) + '/');
        pagerObj.older_url = k === totalPages ? '' : base + '/page/' + (k + 1) + '/';
        stack[0] = sliceCards;
        stack[1] = pagerObj;
        const outPath = k === 1 ? 'index.html' : 'page/' + k + '/index.html';
        if (builtPaths !== null) builtPaths.add(outPath);
        emitEntry(outPath, execOps(compiledIndex.ops, stack), firstEntry, true);
        firstEntry = false;
      }
    }

    const tagTpl = templates.get('tag');
    if (tagTpl !== undefined) {
      const compiledTag = specializeTemplate(
        tagTpl,
        templates,
        constRoot,
        new Map([['tag', 0]]),
        new Set(['tag']),
        sharedPureCaches,
        baseSafe,
        sitePureIncludeCache
      );
      const tagObj = { name: '', $name: '', slug: '', url: '', count: 0, posts: null };
      for (let i = 0; i < sortedTags.length; i++) {
        const t = sortedTags[i];
        const tPosts = t.posts;
        const cards = new Array(tPosts.length);
        for (let j = 0; j < tPosts.length; j++) cards[j] = tPosts[j].card;
        tagObj.name = t.name;
        tagObj.$name = t.$name;
        tagObj.slug = t.slug;
        tagObj.url = t.url;
        tagObj.count = tPosts.length;
        tagObj.posts = cards;
        stack[0] = tagObj;
        const outPath = 'tags/' + t.slug + '/index.html';
        if (builtPaths !== null) builtPaths.add(outPath);
        emitEntry(outPath, execOps(compiledTag.ops, stack), firstEntry, true);
        firstEntry = false;
      }
    }

    const tagsTpl = templates.get('tags');
    if (tagsTpl !== undefined) {
      const compiledTags = specializeTemplate(
        tagsTpl,
        templates,
        constRoot,
        new Map(),
        new Set(),
        sharedPureCaches,
        baseSafe,
        sitePureIncludeCache
      );
      const outPath = 'tags/index.html';
      if (builtPaths !== null) builtPaths.add(outPath);
      emitEntry(outPath, execOps(compiledTags.ops, stack), firstEntry, true);
      firstEntry = false;
    }

    for (let i = 0; i < statics.length; i++) {
      const f = statics[i];
      if (builtPaths.has(f.path)) {
        reportLines.push('shadowed ' + f.path + ': a built page has its path');
      } else {
        builtPaths.add(f.path);
        emitEntry(f.path, jsonSliceAlways(f.content), firstEntry, false);
        firstEntry = false;
      }
    }

    if (broken.size > 0) {
      for (const line of broken) reportLines.push(line);
    }
    reportLines.sort(byCodeUnits);
    reportLines.push(
      'built ' + pageCount + ' pages, ' + posts.length + ' posts, ' + sortedTags.length + ' tags and ' + statics.length + ' static files'
    );
    const repStr = reportLines.join('\n') + '\n';
    emitEntry(REPORT_FILE, jsonSliceAlways(repStr), firstEntry, true);
    _jsonMode = false;
    return null;
  }

  const output = {};
  for (let i = 0; i < sources.length; i++) {
    const s = sources[i];
    const compiled = getPageLayout(s.layout);
    if (s.post) {
      const c = s.card;
      pageObj.title = c.title;
      pageObj.$title = c.$title;
      pageObj.url = c.url;
      pageObj.date = c.date;
      pageObj.date_long = c.date_long;
      pageObj.summary = c.summary;
      pageObj.$summary = c.$summary;
      pageObj.excerpt = c.excerpt;
      pageObj.$excerpt = c.$excerpt;
      pageObj.reading_minutes = c.reading_minutes;
      pageObj.tags = c.tags;
      pageObj.slug = s.slug;
      pageObj.content = s.html;
      pageObj.$content = s.html;
      pageObj.toc = s.toc;
      pageObj.newer = linkOfPost(s.newer);
      pageObj.older = linkOfPost(s.older);
      pageObj.is_post = true;
    } else {
      const d = s.data.date;
      const title = s.data.title;
      const summary = s.data.summary !== undefined ? s.data.summary : '';
      const rawTitleEsc = escapeHtml(title);
      const rawSumEsc = summary === '' ? '' : escapeHtml(summary);
      pageObj.title = title;
      pageObj.$title = rawTitleEsc;
      pageObj.url = s.url;
      pageObj.date = d !== undefined ? d : '';
      pageObj.date_long = d !== undefined ? longDate(d) : '';
      pageObj.summary = summary;
      pageObj.$summary = rawSumEsc;
      pageObj.excerpt = s.excerpt;
      pageObj.$excerpt = s.excerpt;
      pageObj.reading_minutes = s.readingMinutes;
      pageObj.tags = s.tagLinks;
      pageObj.slug = s.slug;
      pageObj.content = s.html;
      pageObj.$content = s.html;
      pageObj.toc = s.toc;
      pageObj.newer = null;
      pageObj.older = null;
      pageObj.is_post = false;
    }
    stack[0] = pageObj;
    output[s.outDir + '/index.html'] = execOps(compiled.ops, stack);
    s.html = '';
  }

  // Index pages
  const indexTpl = templates.get('index');
  if (indexTpl !== undefined) {
    const compiledIndex = specializeTemplate(
      indexTpl,
      templates,
      constRoot,
      new Map([['posts', 0], ['pager', 1]]),
      new Set(['pager']),
      sharedPureCaches,
      baseSafe,
      sitePureIncludeCache
    );
    const per = input.site.per_page;
    const totalPages = Math.max(1, Math.ceil(posts.length / per));
    const pagerObj = { number: 1, total: totalPages, url: '', newer_url: '', older_url: '' };
    for (let k = 1; k <= totalPages; k++) {
      const start = (k - 1) * per;
      const end = Math.min(posts.length, k * per);
      const sliceCards = new Array(end - start);
      for (let j = start; j < end; j++) sliceCards[j - start] = posts[j].card;
      pagerObj.number = k;
      pagerObj.url = k === 1 ? base + '/' : base + '/page/' + k + '/';
      pagerObj.newer_url = k === 1 ? '' : (k === 2 ? base + '/' : base + '/page/' + (k - 1) + '/');
      pagerObj.older_url = k === totalPages ? '' : base + '/page/' + (k + 1) + '/';
      stack[0] = sliceCards;
      stack[1] = pagerObj;
      output[k === 1 ? 'index.html' : 'page/' + k + '/index.html'] = execOps(compiledIndex.ops, stack);
    }
  }

  // Tag pages
  const tagTpl = templates.get('tag');
  if (tagTpl !== undefined) {
    const compiledTag = specializeTemplate(
      tagTpl,
      templates,
      constRoot,
      new Map([['tag', 0]]),
      new Set(['tag']),
      sharedPureCaches,
      baseSafe,
      sitePureIncludeCache
    );
    const tagObj = { name: '', $name: '', slug: '', url: '', count: 0, posts: null };
    for (let i = 0; i < sortedTags.length; i++) {
      const t = sortedTags[i];
      const tPosts = t.posts;
      const cards = new Array(tPosts.length);
      for (let j = 0; j < tPosts.length; j++) cards[j] = tPosts[j].card;
      tagObj.name = t.name;
      tagObj.$name = t.$name;
      tagObj.slug = t.slug;
      tagObj.url = t.url;
      tagObj.count = tPosts.length;
      tagObj.posts = cards;
      stack[0] = tagObj;
      output['tags/' + t.slug + '/index.html'] = execOps(compiledTag.ops, stack);
    }
  }

  // Tags index page (100% static/constant folded!)
  const tagsTpl = templates.get('tags');
  if (tagsTpl !== undefined) {
    const compiledTags = specializeTemplate(
      tagsTpl,
      templates,
      constRoot,
      new Map(),
      new Set(),
      sharedPureCaches,
      baseSafe,
      sitePureIncludeCache
    );
    output['tags/index.html'] = execOps(compiledTags.ops, stack);
  }

  // Static files
  for (let i = 0; i < statics.length; i++) {
    const f = statics[i];
    if (Object.hasOwn(output, f.path)) {
      reportLines.push('shadowed ' + f.path + ': a built page has its path');
    } else {
      output[f.path] = f.content;
    }
  }

  // 9. Build report
  if (broken.size > 0) {
    for (const line of broken) reportLines.push(line);
  }
  reportLines.sort(byCodeUnits);
  reportLines.push(
    'built ' + pageCount + ' pages, ' + posts.length + ' posts, ' + sortedTags.length + ' tags and ' + statics.length + ' static files'
  );
  const repStr = reportLines.join('\n') + '\n';
  output[REPORT_FILE] = repStr;
  _jsonMode = false;

  return output;
}

export function runBatchToFd(cases, fd, writeSyncFn) {
  _outFd = fd;
  _writeSync = writeSyncFn;
  _chunk = '[';
  for (let i = 0; i < cases.length; i++) {
    if (i > 0) _chunk += ',{';
    else _chunk += '{';
    run(cases[i].input, true);
    cases[i] = null;
    _chunk += '}';
  }
  _chunk += ']';
  flushChunk();
}
