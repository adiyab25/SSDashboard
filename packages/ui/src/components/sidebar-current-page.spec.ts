import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(process.cwd(), 'src/components/sidebar.tsx'), 'utf8');

describe('sidebar current page (spec 0025, AC-13)', () => {
  it('tints the current page with the current page gradient, never the hover tint', () => {
    expect(source).not.toContain('data-active:tint-nav');
    expect(source.match(/data-active:gradient-current-page/g)?.length).toBe(2);
    expect(source).toContain('hover:tint-nav');
  });
});
