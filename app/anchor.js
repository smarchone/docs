// Text-quote anchoring on a ProseMirror document (like W3C TextQuoteSelector).
// A comment stores the highlighted visible text plus some context on each side,
// so it can be found again after the document changes. Text blocks are joined
// with "\n", matching what Claude sees as visible text.

const CONTEXT = 32;

export function buildIndex(doc) {
  let text = '';
  const segs = []; // { pos, start, len } for each text node
  let first = true;
  doc.descendants((node, pos) => {
    if (node.isTextblock) {
      if (!first) text += '\n';
      first = false;
    } else if (node.type.name === 'hardBreak') {
      text += '\n';
    } else if (node.isText) {
      segs.push({ pos, start: text.length, len: node.text.length });
      text += node.text;
    }
    return true;
  });
  return { text, segs };
}

// Text offset -> document position. bias 'start' snaps forward, 'end' snaps back.
function posAt(index, off, bias) {
  const { segs } = index;
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    if (off >= s.start && off <= s.start + s.len) {
      if (bias === 'start' && off === s.start + s.len && segs[i + 1]?.start === off) continue;
      return s.pos + (off - s.start);
    }
    if (off < s.start) return bias === 'start' ? s.pos : i ? segs[i - 1].pos + segs[i - 1].len : s.pos;
  }
  const last = segs[segs.length - 1];
  return last ? last.pos + last.len : 0;
}

// Document position -> text offset
function offsetAt(index, pos) {
  for (const s of index.segs) {
    if (pos >= s.pos && pos <= s.pos + s.len) return s.start + (pos - s.pos);
    if (pos < s.pos) return s.start;
  }
  return index.text.length;
}

export function anchorFromRange(doc, from, to) {
  const index = buildIndex(doc);
  const a = offsetAt(index, from);
  const b = offsetAt(index, to);
  const quote = index.text.slice(a, b);
  if (!quote.trim()) return null;
  return {
    quote,
    prefix: index.text.slice(Math.max(0, a - CONTEXT), a),
    suffix: index.text.slice(b, b + CONTEXT),
  };
}

function commonSuffixLen(a, b) {
  let n = 0;
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
  return n;
}
function commonPrefixLen(a, b) {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
}

// Best match for an anchor: exact quote, ranked by how well the context matches
export function locate(index, anchor) {
  if (!anchor?.quote) return null;
  const { text } = index;
  let best = null;
  for (let i = text.indexOf(anchor.quote); i !== -1; i = text.indexOf(anchor.quote, i + 1)) {
    const score =
      commonSuffixLen(text.slice(Math.max(0, i - CONTEXT), i), anchor.prefix || '') +
      commonPrefixLen(text.slice(i + anchor.quote.length, i + anchor.quote.length + CONTEXT), anchor.suffix || '');
    if (!best || score > best.score) best = { start: i, end: i + anchor.quote.length, score };
  }
  if (!best) return null;
  return { from: posAt(index, best.start, 'start'), to: posAt(index, best.end, 'end') };
}
