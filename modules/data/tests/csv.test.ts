import { describe, expect, it } from 'vitest';
import { parseCsv, writeCsv } from '../server/csv';

describe('CSV parse/write determinism', () => {
  it('round-trips a fixed CSV document value-for-value', () => {
    const csv = 'name,age,note\nAda,36,"hello, world"\nGrace,85,"line1\nline2"\n';
    const grid = parseCsv(csv);
    expect(grid).toEqual([
      ['name', 'age', 'note'],
      ['Ada', '36', 'hello, world'],
      ['Grace', '85', 'line1\nline2'],
    ]);
    const written = writeCsv(grid);
    const reparsed = parseCsv(written);
    expect(reparsed).toEqual(grid);
  });

  it('escapes quotes, commas and newlines deterministically across repeated runs', () => {
    const grid = [['a"b', 'c,d', 'e\nf'], ['plain', '', '0']];
    const first = writeCsv(grid);
    const second = writeCsv(grid);
    expect(first).toBe(second);
    expect(parseCsv(first)).toEqual(grid);
  });
});
