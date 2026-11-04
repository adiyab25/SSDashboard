import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// An HTTP route must validate bodies with PostingRequest / ReverseRequest (no postedBy) and add
// postedBy from the signed in user. PostingInput / ReverseInput are service-level: they live in
// the ledger (inventory/ledger/) and its specs, and nowhere else under apps/api/src. Matching the
// bare token, not just a named import, also catches `import * as contracts`, re-exports through
// a local module, and a pipe built in a non-controller file.
const SERVICE_SCHEMAS = /\b(PostingInput|ReverseInput)\b/;

const API_SRC = fileURLToPath(new URL('..', import.meta.url));
const LEDGER_DIR = `inventory${sep}ledger${sep}`;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === 'node_modules' || name === 'dist') return [];
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return name.endsWith('.ts') ? [path] : [];
  });
}

/** Whether the file may mention the service-level schemas. */
function mayUseServiceSchemas(path: string): boolean {
  if (path.endsWith('.controller.ts')) return false;
  return path.endsWith('.spec.ts') || path.startsWith(LEDGER_DIR);
}

function usesServiceSchema(source: string): boolean {
  return SERVICE_SCHEMAS.test(source);
}

describe('controllers and posting schemas', () => {
  it('never name PostingInput or ReverseInput outside the ledger', () => {
    const offenders = sourceFiles(API_SRC)
      .map((path) => ({ path: relative(API_SRC, path), source: readFileSync(path, 'utf8') }))
      .filter(({ path }) => !mayUseServiceSchemas(path))
      .filter(({ source }) => usesServiceSchema(source))
      .map(({ path }) => path);

    expect(
      offenders,
      'Controllers must validate bodies with PostingRequest / ReverseRequest (no postedBy) and ' +
        'add postedBy from the signed in user; PostingInput / ReverseInput are service-level only.',
    ).toEqual([]);
  });

  it('would catch every way of reaching the service schemas', () => {
    for (const source of [
      `import { PostingInput } from '@ssdashboard/contracts';`,
      `import {\n  type ReverseInput,\n  X } from "@ssdashboard/contracts";`,
      `import * as contracts from '@ssdashboard/contracts';\nconst pipe = contracts.PostingInput;`,
      `export { ReverseInput } from '@ssdashboard/contracts';`,
      `export const body = new ZodPipe(PostingInput);`,
    ]) {
      expect(usesServiceSchema(source), source).toBe(true);
    }
    expect(usesServiceSchema(`import { PostingRequest } from '@ssdashboard/contracts';`)).toBe(
      false,
    );
    expect(usesServiceSchema(`const x = MyPostingInputs;`)).toBe(false);
  });

  it('allows only the ledger folder and specs', () => {
    expect(mayUseServiceSchemas(`${LEDGER_DIR}ledger.service.ts`)).toBe(true);
    expect(mayUseServiceSchemas(`inventory${sep}x.service.spec.ts`)).toBe(true);
    expect(mayUseServiceSchemas(`inventory${sep}stock.controller.ts`)).toBe(false);
    expect(mayUseServiceSchemas(`${LEDGER_DIR}ledger.controller.ts`)).toBe(false);
    expect(mayUseServiceSchemas(`inventory${sep}pipes.ts`)).toBe(false);
  });
});
