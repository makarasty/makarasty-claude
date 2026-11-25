const chkDelim = d => { if (typeof d !== 'string' || d.length !== 1 || '"\r\n'.includes(d)) throw new RangeError('delimiter'); };
export function parse(text, { delimiter = ',' } = {}) {
  if (typeof text !== 'string') throw new TypeError('text');
  chkDelim(delimiter);
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  const rows = []; let row = [], i = 0; const n = text.length;
  const atEnd = () => i >= n || text[i] === delimiter || text[i] === '\n' || (text[i] === '\r' && text[i + 1] === '\n');
  while (i < n) {
    let f = '';
    if (text[i] === '"') {
      i++; let closed = false;
      while (i < n) {
        if (text[i] === '"') { if (text[i + 1] === '"') { f += '"'; i += 2; } else { i++; closed = true; break; } } else f += text[i++];
      }
      if (!closed) throw new SyntaxError('unterminated quote');
      if (!atEnd()) throw new SyntaxError('junk after quote');
    } else {
      while (!atEnd()) f += text[i++];
    }
    row.push(f);
    if (i >= n) { rows.push(row); row = null; break; }
    if (text[i] === delimiter) { i++; if (i >= n) { row.push(''); rows.push(row); row = null; } continue; }
    i += text[i] === '\r' ? 2 : 1; rows.push(row); row = [];
  }
  return rows;
}
const q = (v, d) => { const s = v == null ? '' : String(v); return /["\r\n]/.test(s) || s.includes(d) ? `"${s.replaceAll('"', '""')}"` : s; };
export function stringify(rows, { delimiter = ',' } = {}) {
  chkDelim(delimiter);
  return rows.map(r => r.length === 1 && (r[0] == null || String(r[0]) === '') ? '""' : r.map(v => q(v, delimiter)).join(delimiter)).join('\r\n');
}
