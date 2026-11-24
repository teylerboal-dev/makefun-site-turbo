// High-speed, dependency-free, byte-exact drop-in replacement for makefun-site 1.0.0.
// Optimizations:
// 1. Span-based inline Markdown renderer with Uint8Array LUT (eliminates per-char regex calls).
// 2. Zero-split indexOf('\n') block lexer and front-matter parser with charCodeAt dispatch.
// 3. JIT-compiled templates (new Function) with inlined includes and static scope resolution.
// 4. ASCII fast-path + memoized slugify, zero-alloc wordsOf, fast escapeHtml, conditional CR strip.

const REPORT_FILE = 'build-report.txt';
const RESERVED = ['posts', 'tags', 'page'];
const SLUG_MAX = 64;
const INCLUDE_DEPTH = 8;
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// Escapable Markdown characters LUT: \ ` * _ [ ] ( ) # + - . ! >
const ESC_LUT = new Uint8Array(128);
for (const ch of ['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']) {
  ESC_LUT[ch.charCodeAt(0)] = 1;
}

// Inline special characters LUT: \ ` * [ & < > " '
const INLINE_SPECIAL = new Uint8Array(128);
for (const ch of ['\\', '`', '*', '[', '&', '<', '>', '"', "'"]) {
  INLINE_SPECIAL[ch.charCodeAt(0)] = 1;
}

function escapeHtml(text) {
  const len = text.length;
  let out = '';
  let last = 0;
  for (let i = 0; i < len; i++) {
    const c = text.charCodeAt(i);
    if (c > 62) continue;
    let ent;
    if (c === 38) ent = '&amp;';
    else if (c === 60) ent = '&lt;';
    else if (c === 62) ent = '&gt;';
    else if (c === 34) ent = '&quot;';
    else if (c === 39) ent = '&#39;';
    else continue;
    if (last < i) out += text.slice(last, i);
    out += ent;
    last = i + 1;
  }
  if (last === 0) return text;
  if (last < len) out += text.slice(last);
  return out;
}

function slugifyRaw(text) {
  const len = text.length;
  let ascii = true;
  for (let i = 0; i < len; i++) {
    if (text.charCodeAt(i) >= 128) {
      ascii = false;
      break;
    }
  }
  if (ascii) {
    let out = '';
    let gap = false;
    for (let i = 0; i < len; i++) {
      let c = text.charCodeAt(i);
      if (c >= 65 && c <= 90) c += 32;
      if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) {
        if (gap) {
          if (out.length >= SLUG_MAX - 1) break;
          out += '-';
          gap = false;
        } else if (out.length >= SLUG_MAX) {
          break;
        }
        out += String.fromCharCode(c);
      } else {
        if (out.length > 0) gap = true;
      }
    }
    return out === '' ? 'untitled' : out;
  }
  const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (const ch of plain) {
    const c = ch.charCodeAt(0);
    let keep = null;
    if (ch.length === 1) {
      if (c >= 65 && c <= 90) keep = String.fromCharCode(c + 32);
      else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = ch;
    }
    if (keep === null) {
      if (out.length > 0) gap = true;
      continue;
    }
    if (gap) {
      if (out.length >= SLUG_MAX - 1) break;
      out += '-';
      gap = false;
    } else if (out.length >= SLUG_MAX) {
      break;
    }
    out += keep;
  }
  return out === '' ? 'untitled' : out;
}

function uniqueSlug(slug, taken) {
  if (!taken.has(slug)) {
    taken.add(slug);
    return slug;
  }
  let n = 2;
  let out = slug + '-' + n;
  while (taken.has(out)) {
    n++;
    out = slug + '-' + n;
  }
  taken.add(out);
  return out;
}

function longDate(date) {
  const y = date.slice(0, 4);
  const m = (date.charCodeAt(5) - 48) * 10 + (date.charCodeAt(6) - 48);
  const d = (date.charCodeAt(8) - 48) * 10 + (date.charCodeAt(9) - 48);
  return d + ' ' + MONTHS[m - 1] + ' ' + y;
}

// Fast JS \S+ word counter matching text.match(/\S+/g)?.length ?? 0
const NON_ASCII_WS = /\s/;
function wordsOf(text) {
  let count = 0;
  let inWord = false;
  const len = text.length;
  for (let i = 0; i < len; i++) {
    const c = text.charCodeAt(i);
    let ws;
    if (c <= 32) {
      ws = c === 32 || (c >= 9 && c <= 13);
    } else if (c < 160) {
      ws = false;
    } else {
      ws = NON_ASCII_WS.test(text[i]);
    }
    if (ws) {
      inWord = false;
    } else if (!inWord) {
      inWord = true;
      count++;
    }
  }
  return count;
}

// ---------------------------------------------------------------- Front Matter

const FM_KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);
const FM_LINE = /^([a-z_]+):(?: (.*))?$/;
const FM_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const FM_NAME = /^[a-z0-9-]+$/;
const FM_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FM_TAG = /^[^"[\]]+$/;

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    const len = raw.length;
    if (len < 2 || raw.charCodeAt(len - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    let last = 1;
    for (let i = 1; i < len - 1; i++) {
      const c = raw.charCodeAt(i);
      if (c === 92) {
        const n = raw.charCodeAt(i + 1);
        if ((n !== 34 && n !== 92) || i + 1 === len - 1) {
          return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        }
        if (last < i) out += raw.slice(last, i);
        out += n === 34 ? '"' : '\\';
        i++;
        last = i + 1;
      } else if (c === 34) {
        return { error: 'a quoted string holds a stray quote' };
      }
    }
    if (last === 1) return { value: raw.slice(1, len - 1) };
    if (last < len - 1) out += raw.slice(last, len - 1);
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = FM_DATE.exec(raw);
      if (!m) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      const y = Number(m[1]);
      const mo = Number(m[2]);
      const d = Number(m[3]);
      if (y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) {
        return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      }
      return { value: raw };
    }
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) {
        return { error: 'key "tags": not a list [a, b]' };
      }
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const parts = inner.split(',');
      const tags = new Array(parts.length);
      for (let i = 0; i < parts.length; i++) {
        const t = parts[i].trim();
        if (t === '' || !FM_TAG.test(t)) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        tags[i] = t;
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return FM_NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return raw.length <= 64 && FM_SLUG.test(raw) ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

function isBlankSpan(s, start, end) {
  for (let i = start; i < end; i++) {
    const c = s.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

function parseFrontMatter(text) {
  const len = text.length;
  let nl = text.indexOf('\n');
  const firstEnd = nl === -1 ? len : nl;
  if (firstEnd !== 3 || text.charCodeAt(0) !== 45 || text.charCodeAt(1) !== 45 || text.charCodeAt(2) !== 45) {
    return { error: 'no front matter' };
  }
  if (nl === -1) return { error: 'the front matter is not closed' };

  // Find closing '---' line first (exact same behavior as reference: unclosed front matter reported before line errors)
  let pos = nl + 1;
  let closeStart = -1;
  let closeEnd = -1;
  while (pos <= len) {
    const nextNl = text.indexOf('\n', pos);
    const lineEnd = nextNl === -1 ? len : nextNl;
    if (lineEnd - pos === 3 && text.charCodeAt(pos) === 45 && text.charCodeAt(pos + 1) === 45 && text.charCodeAt(pos + 2) === 45) {
      closeStart = pos;
      closeEnd = nextNl === -1 ? len : nextNl + 1;
      break;
    }
    if (nextNl === -1) break;
    pos = nextNl + 1;
  }
  if (closeStart === -1) return { error: 'the front matter is not closed' };

  const data = {};
  pos = nl + 1;
  let lineIdx = 1;
  while (pos < closeStart) {
    const nextNl = text.indexOf('\n', pos);
    const lineEnd = nextNl === -1 || nextNl > closeStart ? closeStart : nextNl;
    if (!isBlankSpan(text, pos, lineEnd) && text.charCodeAt(pos) !== 35) {
      const line = text.slice(pos, lineEnd);
      const m = FM_LINE.exec(line);
      if (!m) return { error: `line ${lineIdx + 1} is not "key: value"` };
      const key = m[1];
      let raw = m[2] ?? '';
      let rEnd = raw.length;
      while (rEnd > 0) {
        const rc = raw.charCodeAt(rEnd - 1);
        if (rc === 32 || rc === 9) rEnd--;
        else break;
      }
      if (rEnd !== raw.length) raw = raw.slice(0, rEnd);
      if (!FM_KEYS.has(key)) return { error: `unknown key "${key}"` };
      if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
      if (raw === '') return { error: `key "${key}" has no value` };
      const v = valueOf(key, raw);
      if ('error' in v) return v;
      data[key] = v.value;
    }
    lineIdx++;
    pos = nextNl + 1;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: closeEnd >= len ? '' : text.slice(closeEnd) };
}

// ---------------------------------------------------------------- Markdown

const FENCE_OPEN_RE = /^```([A-Za-z0-9_+-]*)[ \t]*$/;
const ORDERED_RE = /^(\d{1,9})\. (.*)$/;
const WS_RE = /\s/;

function trimSpacesTabs(s, start, end) {
  while (start < end) {
    const c = s.charCodeAt(start);
    if (c === 32 || c === 9) start++;
    else break;
  }
  while (end > start) {
    const c = s.charCodeAt(end - 1);
    if (c === 32 || c === 9) end--;
    else break;
  }
  return s.slice(start, end);
}

function parseFenceOpen(s, start, end) {
  if (end - start < 3 || s.charCodeAt(start) !== 96 || s.charCodeAt(start + 1) !== 96 || s.charCodeAt(start + 2) !== 96) {
    return null;
  }
  const m = FENCE_OPEN_RE.exec(s.slice(start, end));
  return m === null ? null : m[1];
}

function isFenceClose(s, start, end) {
  if (end - start < 3 || s.charCodeAt(start) !== 96 || s.charCodeAt(start + 1) !== 96 || s.charCodeAt(start + 2) !== 96) {
    return false;
  }
  return isBlankSpan(s, start + 3, end);
}

function parseHeading(s, start, end) {
  if (start >= end || s.charCodeAt(start) !== 35) return null;
  let depth = 1;
  while (depth < 6 && start + depth < end && s.charCodeAt(start + depth) === 35) depth++;
  if (start + depth >= end) return null;
  const sp = s.charCodeAt(start + depth);
  if (sp !== 32 && sp !== 9) return null;
  let ts = start + depth + 1;
  while (ts < end) {
    const c = s.charCodeAt(ts);
    if (c === 32 || c === 9) ts++;
    else break;
  }
  let te = end;
  while (te > ts) {
    const c = s.charCodeAt(te - 1);
    if (c === 32 || c === 9) te--;
    else break;
  }
  if (ts >= te) return null;
  return { depth, text: s.slice(ts, te) };
}

function isHr(s, start, end) {
  if (end - start < 3) return false;
  const c0 = s.charCodeAt(start);
  if ((c0 === 45 && s.charCodeAt(start + 1) === 45 && s.charCodeAt(start + 2) === 45) ||
      (c0 === 42 && s.charCodeAt(start + 1) === 42 && s.charCodeAt(start + 2) === 42)) {
    return isBlankSpan(s, start + 3, end);
  }
  return false;
}

function endsParagraphSpan(s, start, end) {
  if (isBlankSpan(s, start, end)) return true;
  const c0 = s.charCodeAt(start);
  if (c0 === 96) return parseFenceOpen(s, start, end) !== null;
  if (c0 === 35) return parseHeading(s, start, end) !== null;
  if (c0 === 45 || c0 === 42) return isHr(s, start, end);
  return false;
}

function isContinuedSpan(s, start, end) {
  if (end - start < 3 || s.charCodeAt(start) !== 32 || s.charCodeAt(start + 1) !== 32) return false;
  let p = start + 2;
  while (p < end && s.charCodeAt(p) === 32) p++;
  if (p >= end) return false;
  const c = s.charCodeAt(p);
  if (c <= 32) return !(c === 32 || (c >= 9 && c <= 13));
  if (c < 160) return true;
  return !WS_RE.test(s[p]);
}

function findUnescapedChar(s, targetCode, from) {
  const len = s.length;
  for (let j = from; j < len; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < len) {
      const next = s.charCodeAt(j + 1);
      if (next < 128 && ESC_LUT[next]) {
        j++;
        continue;
      }
    }
    if (c === targetCode) return j;
  }
  return -1;
}

function findUnescapedDoubleStar(s, from) {
  const limit = s.length - 1;
  for (let j = from; j < limit; j++) {
    const c = s.charCodeAt(j);
    if (c === 92) {
      const next = s.charCodeAt(j + 1);
      if (next < 128 && ESC_LUT[next]) {
        j++;
        continue;
      }
    }
    if (c === 42 && s.charCodeAt(j + 1) === 42) return j;
  }
  return -1;
}

function findSingleStar(s, from) {
  const len = s.length;
  for (let j = from; j < len; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < len) {
      const next = s.charCodeAt(j + 1);
      if (next < 128 && ESC_LUT[next]) {
        j++;
        continue;
      }
    }
    if (c !== 42) continue;
    if (j + 1 < len && s.charCodeAt(j + 1) === 42) {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

function inline(s, env) {
  const len = s.length;
  let out = '';
  let plain = 0;
  let i = 0;
  while (i < len) {
    const c = s.charCodeAt(i);
    if (c >= 128 || !INLINE_SPECIAL[c]) {
      i++;
      continue;
    }
    // HTML entities fast path
    if (c === 38) {
      if (plain < i) out += s.slice(plain, i);
      out += '&amp;';
      i++;
      plain = i;
      continue;
    }
    if (c === 60) {
      if (plain < i) out += s.slice(plain, i);
      out += '&lt;';
      i++;
      plain = i;
      continue;
    }
    if (c === 62) {
      if (plain < i) out += s.slice(plain, i);
      out += '&gt;';
      i++;
      plain = i;
      continue;
    }
    if (c === 34) {
      if (plain < i) out += s.slice(plain, i);
      out += '&quot;';
      i++;
      plain = i;
      continue;
    }
    if (c === 39) {
      if (plain < i) out += s.slice(plain, i);
      out += '&#39;';
      i++;
      plain = i;
      continue;
    }
    if (c === 92) {
      if (i + 1 < len) {
        const next = s.charCodeAt(i + 1);
        if (next < 128 && ESC_LUT[next]) {
          if (plain < i) out += s.slice(plain, i);
          out += next === 62 ? '&gt;' : s[i + 1];
          i += 2;
          plain = i;
          continue;
        }
      }
      i++;
      continue;
    }
    if (c === 96) {
      const j = s.indexOf('`', i + 1);
      if (j > i + 1) {
        if (plain < i) out += s.slice(plain, i);
        out += '<code>' + escapeHtml(s.slice(i + 1, j)) + '</code>';
        i = j + 1;
        plain = i;
      } else {
        i++;
      }
      continue;
    }
    if (c === 42) {
      if (i + 1 < len && s.charCodeAt(i + 1) === 42) {
        const j = findUnescapedDoubleStar(s, i + 2);
        if (j > i + 2) {
          if (plain < i) out += s.slice(plain, i);
          out += '<strong>' + inline(s.slice(i + 2, j), env) + '</strong>';
          i = j + 2;
          plain = i;
        } else {
          i += 2;
        }
        continue;
      }
      const j = findSingleStar(s, i + 1);
      if (j > i + 1) {
        if (plain < i) out += s.slice(plain, i);
        out += '<em>' + inline(s.slice(i + 1, j), env) + '</em>';
        i = j + 1;
        plain = i;
      } else {
        i++;
      }
      continue;
    }
    if (c === 91) {
      const k = findUnescapedChar(s, 93, i + 1);
      const m = k !== -1 && k + 1 < len && s.charCodeAt(k + 1) === 40 ? s.indexOf(')', k + 2) : -1;
      if (m !== -1) {
        const target = s.slice(k + 2, m);
        if (target !== '' && !WS_RE.test(target)) {
          if (plain < i) out += s.slice(plain, i);
          out += '<a href="' + escapeHtml(env.link(target)) + '">' + inline(s.slice(i + 1, k), env) + '</a>';
          i = m + 1;
          plain = i;
          continue;
        }
      }
      i++;
      continue;
    }
    i++;
  }
  if (plain === 0) return s;
  if (plain < len) out += s.slice(plain);
  return out;
}

function renderMarkdown(src, env, slugCache) {
  const ids = new Set();
  const toc = [];
  let htmlOut = '';
  let excerpt = null;

  const len = src.length;
  let pos = 0;

  while (pos <= len) {
    let nl = src.indexOf('\n', pos);
    let end = nl === -1 ? len : nl;

    if (isBlankSpan(src, pos, end)) {
      if (nl === -1) break;
      pos = nl + 1;
      continue;
    }

    const c0 = src.charCodeAt(pos);

    // Fenced code
    if (c0 === 96) {
      const lang = parseFenceOpen(src, pos, end);
      if (lang !== null) {
        const cls = lang === '' ? '' : ' class="language-' + escapeHtml(lang) + '"';
        let codeOut = '<pre><code' + cls + '>';
        if (nl !== -1) {
          pos = nl + 1;
          while (pos <= len) {
            nl = src.indexOf('\n', pos);
            end = nl === -1 ? len : nl;
            if (isFenceClose(src, pos, end)) {
              pos = nl === -1 ? len + 1 : nl + 1;
              break;
            }
            codeOut += escapeHtml(src.slice(pos, end)) + '\n';
            if (nl === -1) {
              pos = len + 1;
              break;
            }
            pos = nl + 1;
          }
        } else {
          pos = len + 1;
        }
        htmlOut += codeOut + '</code></pre>\n';
        continue;
      }
    }

    // ATX Heading
    if (c0 === 35) {
      const h = parseHeading(src, pos, end);
      if (h !== null) {
        let baseSlug = slugCache.get(h.text);
        if (baseSlug === undefined) {
          baseSlug = slugifyRaw(h.text);
          slugCache.set(h.text, baseSlug);
        }
        const id = uniqueSlug(baseSlug, ids);
        const hHtml = inline(h.text, env);
        htmlOut += '<h' + h.depth + ' id="' + id + '">' + hHtml + '</h' + h.depth + '>\n';
        if (h.depth === 2 || h.depth === 3) toc.push({ level: h.depth, id, html: hHtml });
        if (nl === -1) break;
        pos = nl + 1;
        continue;
      }
    }

    // HR
    if ((c0 === 45 || c0 === 42) && isHr(src, pos, end)) {
      htmlOut += '<hr>\n';
      if (nl === -1) break;
      pos = nl + 1;
      continue;
    }

    // Blockquote
    if (c0 === 62) {
      let qLines = '';
      let hasLine = false;
      while (pos <= len) {
        nl = src.indexOf('\n', pos);
        end = nl === -1 ? len : nl;
        if (pos >= end || src.charCodeAt(pos) !== 62) break;
        let qs = pos + 1;
        if (qs < end && src.charCodeAt(qs) === 32) qs++;
        const trimmed = trimSpacesTabs(src, qs, end);
        if (trimmed !== '') {
          if (hasLine) qLines += '\n' + trimmed;
          else {
            qLines = trimmed;
            hasLine = true;
          }
        }
        if (nl === -1) {
          pos = len + 1;
          break;
        }
        pos = nl + 1;
      }
      if (!hasLine) htmlOut += '<blockquote>\n</blockquote>\n';
      else htmlOut += '<blockquote>\n<p>' + inline(qLines, env) + '</p>\n</blockquote>\n';
      continue;
    }

    // Lists
    const isBullet = (c0 === 45 || c0 === 42) && pos + 1 < end && src.charCodeAt(pos + 1) === 32;
    let ordMatch = null;
    if (!isBullet && c0 >= 48 && c0 <= 57) {
      ordMatch = ORDERED_RE.exec(src.slice(pos, end));
    }
    if (isBullet || ordMatch !== null) {
      const isOrdered = ordMatch !== null;
      const startNum = isOrdered ? Number(ordMatch[1]) : 1;
      const tag = isOrdered ? 'ol' : 'ul';
      let listOut = isOrdered && startNum !== 1 ? '<ol start="' + startNum + '">\n' : '<' + tag + '>\n';
      let curItem = isOrdered ? trimSpacesTabs(ordMatch[2], 0, ordMatch[2].length) : trimSpacesTabs(src, pos + 2, end);
      pos = nl === -1 ? len + 1 : nl + 1;
      while (pos <= len) {
        nl = src.indexOf('\n', pos);
        end = nl === -1 ? len : nl;
        if (pos < end) {
          const lc0 = src.charCodeAt(pos);
          if (!isOrdered && (lc0 === 45 || lc0 === 42) && pos + 1 < end && src.charCodeAt(pos + 1) === 32) {
            listOut += '<li>' + inline(curItem, env) + '</li>\n';
            curItem = trimSpacesTabs(src, pos + 2, end);
            pos = nl === -1 ? len + 1 : nl + 1;
            continue;
          }
          if (isOrdered && lc0 >= 48 && lc0 <= 57) {
            const m = ORDERED_RE.exec(src.slice(pos, end));
            if (m !== null) {
              listOut += '<li>' + inline(curItem, env) + '</li>\n';
              curItem = trimSpacesTabs(m[2], 0, m[2].length);
              pos = nl === -1 ? len + 1 : nl + 1;
              continue;
            }
          }
          if (isContinuedSpan(src, pos, end)) {
            curItem += '\n' + trimSpacesTabs(src, pos, end);
            pos = nl === -1 ? len + 1 : nl + 1;
            continue;
          }
        }
        break;
      }
      listOut += '<li>' + inline(curItem, env) + '</li>\n</' + tag + '>\n';
      htmlOut += listOut;
      continue;
    }

    // Paragraph
    let pText = trimSpacesTabs(src, pos, end);
    pos = nl === -1 ? len + 1 : nl + 1;
    while (pos <= len) {
      nl = src.indexOf('\n', pos);
      end = nl === -1 ? len : nl;
      if (endsParagraphSpan(src, pos, end)) break;
      pText += '\n' + trimSpacesTabs(src, pos, end);
      pos = nl === -1 ? len + 1 : nl + 1;
    }
    const pHtml = inline(pText, env);
    if (excerpt === null) excerpt = pHtml;
    htmlOut += '<p>' + pHtml + '</p>\n';
  }

  return { html: htmlOut, toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- Templates (Parser + JIT Compiler)

const TPL_PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const TPL_FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const TPL_IF = /^if (not )?(\S+)$/;
const TPL_INCLUDE = /^include "([a-z0-9-]+)"$/;

class TemplateError extends Error {}

function pathOf(name, text) {
  if (!TPL_PATH.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

function tokenizeTemplate(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  const len = src.length;
  while (i < len) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === len - 1) {
      text += src.slice(i);
      break;
    }
    const next = src.charCodeAt(open + 1);
    if (next !== 123 && next !== 37) {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === 123) {
      const raw = src.charCodeAt(open + 2) === 123;
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? len : nl;
    const standalone = isBlankSpan(src, lineStart, open) && isBlankSpan(src, end, lineEnd);
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? len : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenizeTemplate(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = TPL_FOR.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = TPL_IF.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = TPL_INCLUDE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

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

const SITE_CONST_ROOTS = new Set(['site', 'tags', 'recent']);

function nodeRefsLoop(list) {
  for (let i = 0; i < list.length; i++) {
    const n = list[i];
    if (n.kind === 'var' || n.kind === 'raw') {
      if (n.path[0] === 'loop') return true;
    } else if (n.kind === 'if') {
      if (n.path[0] === 'loop' || nodeRefsLoop(n.then) || (n.else !== null && nodeRefsLoop(n.else))) return true;
    } else if (n.kind === 'for') {
      if (n.path[0] === 'loop') return true;
      // inner for shadows loop, so don't recurse into n.body
    } else if (n.kind === 'include') {
      return true; // conservative: include could reference loop
    }
  }
  return false;
}

function lookupStatic(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

function renderStaticNodes(nodes, scope, templates, depth) {
  let out = '';
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (n.kind === 'text') out += n.text;
    else if (n.kind === 'var') out += escapeHtml(textOf(lookupStatic(scope, n.path)));
    else if (n.kind === 'raw') out += textOf(lookupStatic(scope, n.path));
    else if (n.kind === 'if') {
      const branch = truthy(lookupStatic(scope, n.path)) !== n.not ? n.then : n.else;
      if (branch !== null) out += renderStaticNodes(branch, scope, templates, depth);
    } else if (n.kind === 'for') {
      const xs = lookupStatic(scope, n.path);
      if (!Array.isArray(xs)) continue;
      for (let k = 0, l = xs.length; k < l; k++) {
        const vars = { [n.name]: xs[k], loop: { index: k + 1, first: k === 0, last: k === l - 1, length: l } };
        out += renderStaticNodes(n.body, { vars, parent: scope }, templates, depth);
      }
    } else if (n.kind === 'include') {
      const t = templates.get(n.name);
      if (t !== undefined && depth < INCLUDE_DEPTH) out += renderStaticNodes(t, scope, templates, depth + 1);
    }
  }
  return out;
}

function isConstNodes(nodes, bound, templates, depth) {
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (n.kind === 'text') continue;
    if (n.kind === 'var' || n.kind === 'raw') {
      const p0 = n.path[0];
      if (!bound.has(p0) && !SITE_CONST_ROOTS.has(p0)) return false;
    } else if (n.kind === 'if') {
      const p0 = n.path[0];
      if (!bound.has(p0) && !SITE_CONST_ROOTS.has(p0)) return false;
      if (!isConstNodes(n.then, bound, templates, depth)) return false;
      if (n.else !== null && !isConstNodes(n.else, bound, templates, depth)) return false;
    } else if (n.kind === 'for') {
      const p0 = n.path[0];
      if (!bound.has(p0) && !SITE_CONST_ROOTS.has(p0)) return false;
      const next = new Set(bound);
      next.add(n.name);
      next.add('loop');
      if (!isConstNodes(n.body, next, templates, depth)) return false;
    } else if (n.kind === 'include') {
      if (depth < INCLUDE_DEPTH) {
        const t = templates.get(n.name);
        if (t !== undefined && !isConstNodes(t, bound, templates, depth + 1)) return false;
      }
    }
  }
  return true;
}

// Compile a parsed template into a direct JS function with site-constant partial evaluation,
// coalesced string literals, inlined includes, and static scope lookup.
function compileTemplate(name, templates, baseScope) {
  const nodes = templates.get(name);
  if (nodes === undefined) return null;

  const staticRoot = { vars: baseScope, parent: null };
  const emptyBound = new Set();
  if (isConstNodes(nodes, emptyBound, templates, 0)) {
    const constantHtml = renderStaticNodes(nodes, staticRoot, templates, 0);
    return () => constantHtml;
  }

  let uid = 0;
  const code = ['let _o = "";'];
  let pendingText = '';

  function flushText() {
    if (pendingText !== '') {
      code.push(`_o+=${JSON.stringify(pendingText)};`);
      pendingText = '';
    }
  }

  function genLookup(path, scopeEnv) {
    const p0 = path[0];
    let expr;
    if (scopeEnv.has(p0)) {
      expr = scopeEnv.get(p0);
    } else {
      expr = `_ho(_r,${JSON.stringify(p0)})?_r[${JSON.stringify(p0)}]:undefined`;
    }
    if (path.length === 1) return expr;
    const v = `_v${uid++}`;
    code.push(`let ${v}=${expr};`);
    for (let k = 1; k < path.length; k++) {
      const pk = JSON.stringify(path[k]);
      code.push(`${v}=(${v}!==null&&typeof ${v}==="object"&&_ho(${v},${pk}))?${v}[${pk}]:undefined;`);
    }
    return v;
  }

  function emit(list, scopeEnv, depth) {
    for (let i = 0; i < list.length; i++) {
      const n = list[i];
      if (n.kind === 'text') {
        pendingText += n.text;
        continue;
      }
      // If at root scope (no dynamic loop vars), try constant-folding the entire node!
      if (scopeEnv.size === 0 && isConstNodes([n], emptyBound, templates, depth)) {
        pendingText += renderStaticNodes([n], staticRoot, templates, depth);
        continue;
      }
      if (n.kind === 'include') {
        if (depth < INCLUDE_DEPTH) {
          const inc = templates.get(n.name);
          if (inc !== undefined) emit(inc, scopeEnv, depth + 1);
        }
        continue;
      }
      flushText();
      if (n.kind === 'var') {
        const v = genLookup(n.path, scopeEnv);
        code.push(`_o+=_esc(_txt(${v}));`);
      } else if (n.kind === 'raw') {
        const v = genLookup(n.path, scopeEnv);
        code.push(`_o+=_txt(${v});`);
      } else if (n.kind === 'if') {
        const v = genLookup(n.path, scopeEnv);
        code.push(n.not ? `if(!_tr(${v})){` : `if(_tr(${v})){`);
        emit(n.then, scopeEnv, depth);
        flushText();
        if (n.else !== null) {
          code.push('}else{');
          emit(n.else, scopeEnv, depth);
          flushText();
        }
        code.push('}');
      } else if (n.kind === 'for') {
        const xs = `_a${uid++}`;
        const k = `_k${uid++}`;
        const l = `_l${uid++}`;
        const itemVar = `_x${uid++}`;
        const needsLoop = nodeRefsLoop(n.body);
        const loopVar = needsLoop ? `_p${uid++}` : '';
        const arrExpr = genLookup(n.path, scopeEnv);
        code.push(`const ${xs}=${arrExpr};if(Array.isArray(${xs})){for(let ${k}=0,${l}=${xs}.length;${k}<${l};${k}++){const ${itemVar}=${xs}[${k}];${needsLoop ? `const ${loopVar}={index:${k}+1,first:${k}===0,last:${k}===${l}-1,length:${l}};` : ''}`);
        const nextEnv = new Map(scopeEnv);
        nextEnv.set(n.name, itemVar);
        if (needsLoop) nextEnv.set('loop', loopVar);
        emit(n.body, nextEnv, depth);
        flushText();
        code.push('}}');
      }
    }
  }

  emit(nodes, new Map(), 0);
  flushText();
  code.push('return _o;');
  return new Function('_r', '_esc', '_txt', '_tr', '_ho', code.join('\n'));
}

// ---------------------------------------------------------------- Pipeline

const SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/;

function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  const segs = rel.split('/');
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else {
      parts.push(seg);
    }
  }
  return parts.join('/');
}

function dirOf(path) {
  const idx = path.lastIndexOf('/');
  return idx === -1 ? '' : path.slice(0, idx);
}

export function run(input) {
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

  const base = input.site.base_url.replace(/\/+$/, '');
  const slugCache = new Map();
  const getSlug = (t) => {
    let s = slugCache.get(t);
    if (s === undefined) {
      s = slugifyRaw(t);
      slugCache.set(t, s);
    }
    return s;
  };

  // 1. Read sources
  const files = input.files.slice().sort((x, y) => byCodeUnits(x.path, y.path));
  const rawSources = [];
  const statics = [];
  const staticPaths = new Set();
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    if (f.path.endsWith('.md')) {
      const content = f.content;
      const text = content.indexOf('\r') === -1 ? content : content.replace(/\r\n?/g, '\n');
      rawSources.push({ path: f.path, text });
    } else {
      statics.push(f);
      staticPaths.add(f.path);
    }
  }

  // 2. Front matter
  const sources = [];
  for (let i = 0; i < rawSources.length; i++) {
    const s = rawSources[i];
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      reportLines.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    const data = fm.data;
    const isPost = s.path.startsWith('posts/');
    let own = undefined;
    if (s.path.startsWith('tags/')) own = 'tags';
    else if (s.path.startsWith('page/')) own = 'page';
    if (own !== undefined) {
      reportLines.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (isPost && !Object.hasOwn(data, 'date')) {
      reportLines.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = data.layout ?? (isPost ? 'post' : 'page');
    if (!templates.has(layout)) {
      reportLines.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    if (data.draft === true) {
      reportLines.push(`draft ${s.path}`);
      continue;
    }
    sources.push({
      path: s.path,
      data,
      body: fm.body,
      post: isPost,
      layout,
      slug: '',
      outDir: '',
      url: '',
      html: '',
      toc: null,
      excerpt: '',
      newer: null,
      older: null,
      tagRefs: null,
    });
  }

  // 3. Permalinks
  const taken = new Map();
  const bySource = new Map();
  for (let i = 0; i < sources.length; i++) {
    const s = sources[i];
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : undefined);
      taken.set(dir, set);
    }
    const slug = uniqueSlug(s.data.slug ?? getSlug(s.data.title), set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : dir + '/' + slug;
    s.url = base + '/' + s.outDir + '/';
    bySource.set(s.path, s);
  }

  // 4. Markdown
  const broken = new Set();
  for (let i = 0; i < sources.length; i++) {
    const s = sources[i];
    const dir = dirOf(s.path);
    const sPath = s.path;
    const env = {
      link(target) {
        const c0 = target.charCodeAt(0);
        if (c0 === 47 || c0 === 35 || SCHEME_RE.test(target)) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        if (path !== null) {
          const hit = bySource.get(path);
          if (hit !== undefined) return hit.url + frag;
          if (staticPaths.has(path)) return base + '/' + path + frag;
        }
        broken.add('broken-link ' + sPath + ' -> ' + target);
        return target;
      },
    };
    const md = renderMarkdown(s.body, env, slugCache);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 5. Collections
  const posts = [];
  for (let i = 0; i < sources.length; i++) {
    if (sources[i].post) posts.push(sources[i]);
  }
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  for (let k = 0; k < posts.length; k++) {
    posts[k].newer = k === 0 ? null : posts[k - 1];
    posts[k].older = k === posts.length - 1 ? null : posts[k + 1];
  }

  // 6. Tags
  const bySlug = new Map();
  for (let i = 0; i < posts.length; i++) {
    const p = posts[i];
    const rawTags = p.data.tags;
    const tagRefs = [];
    if (rawTags !== undefined && rawTags.length > 0) {
      const seen = new Set();
      for (let j = 0; j < rawTags.length; j++) {
        const name = rawTags[j];
        const slug = getSlug(name);
        if (seen.has(slug)) continue;
        seen.add(slug);
        let tag = bySlug.get(slug);
        if (tag === undefined) {
          tag = { name, slug, url: base + '/tags/' + slug + '/', posts: [] };
          bySlug.set(slug, tag);
        }
        tag.posts.push(p);
        tagRefs.push(tag);
      }
    }
    p.tagRefs = tagRefs;
  }
  for (let i = 0; i < sources.length; i++) {
    const s = sources[i];
    if (s.post) continue;
    const rawTags = s.data.tags;
    const tagRefs = [];
    if (rawTags !== undefined && rawTags.length > 0) {
      const seen = new Set();
      for (let j = 0; j < rawTags.length; j++) {
        const name = rawTags[j];
        const slug = getSlug(name);
        if (seen.has(slug)) continue;
        seen.add(slug);
        tagRefs.push(bySlug.get(slug) ?? { name, slug, url: '', posts: [] });
      }
    }
    s.tagRefs = tagRefs;
  }
  const tagsList = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // 7. Layouts (JIT-compiled templates with site-constant partial evaluation)
  const compiled = new Map();
  let baseScope = null;
  const getRenderer = (name) => {
    let fn = compiled.get(name);
    if (fn === undefined) {
      fn = compileTemplate(name, templates, baseScope);
      compiled.set(name, fn);
    }
    return fn;
  };

  const linkOf = (s) => (s === null ? null : {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
  });

  const tagViewCache = new Map();
  const tagViewOf = (t) => {
    let v = tagViewCache.get(t);
    if (v === undefined) {
      v = { name: t.name, slug: t.slug, url: t.url };
      tagViewCache.set(t, v);
    }
    return v;
  };

  const cardOf = (s) => {
    const tr = s.tagRefs;
    const tArr = new Array(tr.length);
    for (let i = 0; i < tr.length; i++) tArr[i] = tagViewOf(tr[i]);
    return {
      title: s.data.title,
      url: s.url,
      date: s.data.date ?? '',
      date_long: s.data.date === undefined ? '' : longDate(s.data.date),
      summary: s.data.summary ?? '',
      excerpt: s.excerpt,
      reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
      tags: tArr,
    };
  };

  const cards = new Map();
  for (let i = 0; i < posts.length; i++) cards.set(posts[i], cardOf(posts[i]));

  const site = { title: input.site.title, base_url: base };
  const allTags = new Array(tagsList.length);
  for (let i = 0; i < tagsList.length; i++) {
    const t = tagsList[i];
    allTags[i] = { name: t.name, slug: t.slug, url: t.url, count: t.posts.length };
  }
  const recentCount = Math.min(posts.length, input.site.recent);
  const recent = new Array(recentCount);
  for (let i = 0; i < recentCount; i++) recent[i] = cards.get(posts[i]);

  const output = {};
  const ho = Object.hasOwn;
  baseScope = { site, tags: allTags, recent };

  for (let i = 0; i < sources.length; i++) {
    const s = sources[i];
    const fn = getRenderer(s.layout);
    const c = s.post ? cards.get(s) : cardOf(s);
    const page = {
      title: c.title,
      url: c.url,
      date: c.date,
      date_long: c.date_long,
      summary: c.summary,
      excerpt: c.excerpt,
      reading_minutes: c.reading_minutes,
      tags: c.tags,
      slug: s.slug,
      content: s.html,
      toc: s.toc,
      newer: linkOf(s.newer),
      older: linkOf(s.older),
      is_post: s.post,
    };
    output[s.outDir + '/index.html'] = fn === null ? null : fn({ site, tags: allTags, recent, page }, escapeHtml, textOf, truthy, ho);
  }

  const indexFn = getRenderer('index');
  if (indexFn !== null) {
    const per = input.site.per_page;
    const totalPages = Math.max(1, Math.ceil(posts.length / per));
    const indexUrl = (k) => (k === 1 ? base + '/' : base + '/page/' + k + '/');
    for (let k = 1; k <= totalPages; k++) {
      const start = (k - 1) * per;
      const end = Math.min(posts.length, start + per);
      const pagePosts = new Array(end - start);
      for (let j = start; j < end; j++) pagePosts[j - start] = cards.get(posts[j]);
      const pager = {
        number: k,
        total: totalPages,
        url: indexUrl(k),
        newer_url: k === 1 ? '' : indexUrl(k - 1),
        older_url: k === totalPages ? '' : indexUrl(k + 1),
      };
      output[k === 1 ? 'index.html' : 'page/' + k + '/index.html'] = indexFn({ site, tags: allTags, recent, posts: pagePosts, pager }, escapeHtml, textOf, truthy, ho);
    }
  }

  const tagFn = getRenderer('tag');
  if (tagFn !== null) {
    for (let i = 0; i < tagsList.length; i++) {
      const t = tagsList[i];
      const tPosts = new Array(t.posts.length);
      for (let j = 0; j < t.posts.length; j++) tPosts[j] = cards.get(t.posts[j]);
      const tag = { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: tPosts };
      output['tags/' + t.slug + '/index.html'] = tagFn({ site, tags: allTags, recent, tag }, escapeHtml, textOf, truthy, ho);
    }
  }

  const tagsFn = getRenderer('tags');
  if (tagsFn !== null) {
    output['tags/index.html'] = tagsFn(baseScope, escapeHtml, textOf, truthy, ho);
  }

  for (let i = 0; i < statics.length; i++) {
    const f = statics[i];
    if (ho(output, f.path)) reportLines.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 8. Report
  for (const bl of broken) reportLines.push(bl);
  reportLines.sort(byCodeUnits);
  const pageCount = sources.length - posts.length;
  reportLines.push(`built ${pageCount} pages, ${posts.length} posts, ${tagsList.length} tags and ${statics.length} static files`);
  output[REPORT_FILE] = reportLines.join('\n') + '\n';

  return output;
}
