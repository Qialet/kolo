import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveDistrictFile } from './district.js';

describe('resolveDistrictFile', () => {
  const root = mkdtempSync(join(tmpdir(), 'kolo-district-'));
  const file = join(root, 'data', 'districts', 'belgrade-center.json');
  mkdirSync(join(root, 'data', 'districts'), { recursive: true });
  mkdirSync(join(root, 'apps', 'api', 'dist'), { recursive: true });
  writeFileSync(file, '{}');

  it('finds the district file by walking up from the working directory', () => {
    expect(resolveDistrictFile({}, join(root, 'apps', 'api', 'dist'))).toBe(file);
  });

  it('prefers DISTRICT_FILE from the environment', () => {
    expect(resolveDistrictFile({ DISTRICT_FILE: file }, tmpdir())).toBe(file);
  });

  it('fails loudly when there is no district file', () => {
    expect(() => resolveDistrictFile({}, tmpdir())).toThrow(/belgrade-center\.json/);
    expect(() => resolveDistrictFile({ DISTRICT_FILE: join(root, 'missing.json') }, root)).toThrow(/missing\.json/);
  });
});
