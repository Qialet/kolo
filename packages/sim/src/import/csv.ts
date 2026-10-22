/**
 * Calls `row` for every record of a CSV text. Handles a BOM, CRLF and quoted fields; a quote opens
 * quoting only at the start of a field, so stray quotes inside a field stay literal (the Belgrade feed has them).
 * Walks the text line by line, so a large file never becomes an array of rows.
 */
export function eachCsvRow(text: string, row: (fields: string[]) => void): void {
  const n = text.length;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  let quote = -1;
  while (i < n) {
    let end = text.indexOf('\n', i);
    if (end < 0) end = n;
    if (quote < i) {
      quote = text.indexOf('"', i);
      if (quote < 0) quote = n;
    }
    if (quote > end) {
      const line = text.charCodeAt(end - 1) === 13 ? text.slice(i, end - 1) : text.slice(i, end);
      if (line.length) row(line.split(','));
      i = end + 1;
      continue;
    }
    const fields: string[] = [];
    let field = '';
    let quoted = false;
    let atStart = true;
    let j = i;
    for (; j < n; j++) {
      const c = text[j]!;
      if (quoted) {
        if (c !== '"') field += c;
        else if (text[j + 1] === '"') {
          field += '"';
          j++;
        } else quoted = false;
      } else if (c === '"' && atStart) {
        quoted = true;
        atStart = false;
      } else if (c === ',') {
        fields.push(field);
        field = '';
        atStart = true;
      } else if (c === '\n') break;
      else if (c !== '\r' || text[j + 1] !== '\n') {
        field += c;
        atStart = false;
      }
    }
    fields.push(field);
    row(fields);
    i = j + 1;
  }
}

/** Calls `each` per data row with a getter of trimmed values by header column; nothing for a missing file. */
export function eachRecord(text: string | undefined, each: (get: (col: string) => string) => void): void {
  if (!text) return;
  let cols: Map<string, number> | null = null;
  let cur: string[] = [];
  const get = (col: string) => {
    const i = cols!.get(col);
    return i === undefined ? '' : (cur[i] ?? '').trim();
  };
  eachCsvRow(text, (fields) => {
    if (!cols) cols = new Map(fields.map((c, i) => [c.trim(), i]));
    else {
      cur = fields;
      each(get);
    }
  });
}
