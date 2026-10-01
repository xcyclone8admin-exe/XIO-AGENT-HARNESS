/**
 * Dependency-free, deterministic CSV parser/writer (RFC 4180 subset): comma-separated,
 * double-quote quoting with "" escaping, CRLF or LF line endings. No CSV utility exists yet
 * in @xyra/core, so this is module-local.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  let i = 0;
  const pushField = () => { row.push(field); field = ''; };
  const pushRow = () => { pushField(); rows.push(row); row = []; };
  while (i < normalized.length) {
    const ch = normalized[i];
    if (inQuotes) {
      if (ch === '"') {
        if (normalized[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i += 1; continue;
      }
      field += ch; i += 1; continue;
    }
    if (ch === '"') { inQuotes = true; i += 1; continue; }
    if (ch === ',') { pushField(); i += 1; continue; }
    if (ch === '\n') { pushRow(); i += 1; continue; }
    field += ch; i += 1;
  }
  if (field.length > 0 || row.length > 0) pushRow();
  if (rows.length && rows[rows.length - 1]?.length === 1 && rows[rows.length - 1]?.[0] === '') rows.pop();
  return rows;
}

function csvEscape(value: string): string {
  if (/[",\n]/.test(value)) return '"' + value.replace(/"/g, '""') + '"';
  return value;
}

export function writeCsv(rows: readonly (readonly string[])[]): string {
  return rows.map((row) => row.map(csvEscape).join(',')).join('\n');
}
