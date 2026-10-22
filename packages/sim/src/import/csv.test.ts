import { describe, expect, it } from 'vitest';
import { eachCsvRow, eachRecord } from './csv.js';

describe('eachCsvRow', () => {
  it('handles BOM, CRLF, quoted fields and stray quotes inside a field', () => {
    const rows: string[][] = [];
    eachCsvRow('﻿a,b,c\r\n"x, y","say ""hi""",z\nŽeleznička "BGD",,\n"multi\nline",2,3', (r) => rows.push([...r]));
    expect(rows).toEqual([
      ['a', 'b', 'c'],
      ['x, y', 'say "hi"', 'z'],
      ['Železnička "BGD"', '', ''],
      ['multi\nline', '2', '3'],
    ]);
  });
});

describe('eachRecord', () => {
  it('reads values by header column, trimmed, empty for unknown columns and missing files', () => {
    const out: string[][] = [];
    eachRecord('id,name\n1, Slavija \n2,"Trg, republike"\n', (get) => out.push([get('id'), get('name'), get('nope')]));
    expect(out).toEqual([
      ['1', 'Slavija', ''],
      ['2', 'Trg, republike', ''],
    ]);
    eachRecord(undefined, () => out.push([]));
    expect(out).toHaveLength(2);
  });
});
