import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(resolve(process.cwd(), 'src/styles/globals.css'), 'utf8');

/** The declarations of the first top level block that starts with the selector. */
function block(selector: string): Map<string, string> {
  const start = css.indexOf(`\n${selector} {`);
  if (start < 0) throw new Error(`No ${selector} block in globals.css`);
  const end = css.indexOf('\n}', start);
  const body = css.slice(start, end);
  const map = new Map<string, string>();
  for (const match of body.matchAll(/^\s*(--[a-z0-9-]+):\s*([^;]+);/gm)) {
    const [, name, value] = match;
    if (name && value) map.set(name, value.trim().toLowerCase());
  }
  return map;
}

const light = block(':root');
const dark = block('.dark');

/** Spec 0025, Colour tokens: role, dark, light. Roles listed together share the value. */
const TABLE: readonly (readonly [readonly string[], string, string])[] = [
  [['background'], '#0a0e14', '#f4f7fa'],
  [['sidebar'], '#0c1119', '#ebf0f5'],
  [['card'], '#111722', '#ffffff'],
  [['popover'], '#18202c', '#ffffff'],
  [['secondary', 'muted'], '#18202c', '#eef2f6'],
  [['accent', 'sidebar-accent'], '#243044', '#e9eef4'],
  [
    [
      'foreground',
      'card-foreground',
      'popover-foreground',
      'sidebar-foreground',
      'secondary-foreground',
      'accent-foreground',
      'sidebar-accent-foreground',
    ],
    '#e6e8eb',
    '#0a0e14',
  ],
  [['muted-foreground'], '#9aa6b8', '#4a5568'],
  [['primary', 'ring', 'sidebar-primary', 'sidebar-ring'], '#7dd3fc', '#0e7490'],
  [['primary-foreground', 'sidebar-primary-foreground'], '#0a0e14', '#ffffff'],
  [['border', 'sidebar-border'], '#ffffff14', '#0a0e1414'],
  [['input'], '#5f7088', '#6b7a90'],
  [['success'], '#7ee0b0', '#047857'],
  [['warning'], '#e8b86d', '#9a5b0b'],
  [['destructive'], '#ff8a8a', '#c02a2a'],
  [['success-foreground', 'warning-foreground', 'destructive-foreground'], '#0a0e14', '#ffffff'],
  [['border-strong'], '#ffffff1f', '#0a0e141f'],
  [['destructive-surface'], '#2a1a1c', '#fdecec'],
  [['primary-edge'], '#bfe6fb', '#0b5568'],
];

describe('globals.css tokens (spec 0025, AC-1)', () => {
  for (const [roles, darkValue, lightValue] of TABLE) {
    for (const role of roles) {
      it(`${role}: dark ${darkValue}, light ${lightValue}`, () => {
        expect(dark.get(`--${role}`)).toBe(darkValue);
        expect(light.get(`--${role}`)).toBe(lightValue);
      });
    }
  }

  it('maps the meaning roles onto their parents and the surfaces onto the control fill', () => {
    for (const theme of [light, dark]) {
      expect(theme.get('--confirmed')).toBe('var(--success)');
      expect(theme.get('--failed')).toBe('var(--destructive)');
      expect(theme.get('--owed')).toBe('var(--warning)');
      expect(theme.get('--provisional')).toBe('var(--muted-foreground)');
      expect(theme.get('--info')).toBe('var(--muted-foreground)');
      for (const surface of ['confirmed', 'failed', 'owed', 'info']) {
        expect(theme.get(`--${surface}-surface`)).toBe('var(--muted)');
      }
    }
  });

  it('keeps no oklch colour (no value of the old look remains)', () => {
    expect(css).not.toMatch(/oklch\(/);
  });

  it('defines the four radius tokens', () => {
    expect(css).toMatch(/--radius-chip:\s*6px/);
    expect(css).toMatch(/--radius-control:\s*8px/);
    expect(css).toMatch(/--radius-popover:\s*10px/);
    expect(css).toMatch(/--radius-card:\s*12px/);
  });

  it('maps the font stacks to Geist, Geist Mono, and Noto Sans Arabic', () => {
    expect(css).toContain('--font-sans: var(--font-geist), ui-sans-serif, system-ui, sans-serif;');
    expect(css).toContain(
      '--font-heading: var(--font-geist), ui-sans-serif, system-ui, sans-serif;',
    );
    expect(css).toContain(
      '--font-mono: var(--font-geist-mono), var(--font-noto-arabic), ui-monospace, monospace;',
    );
    expect(css).toContain(
      '--font-arabic: var(--font-noto-arabic), var(--font-geist), ui-sans-serif, system-ui, sans-serif;',
    );
    expect(css).not.toMatch(/--font-inter|--font-jetbrains/);
  });

  it('keeps the density values unchanged (AC-20)', () => {
    expect(css).toContain('--spacing-row: 2.5rem;');
    expect(css).toContain('--spacing-row-header: 2.75rem;');
    expect(css).toContain('--spacing-control: 2.5rem;');
    expect(css).toContain('--spacing-topbar: 3.5rem;');
    expect(css).toContain('--spacing-nav-item: 2rem;');
    expect(css).toContain('--text-sm: 0.9375rem;');
  });

  it('switches movement off under reduced motion instead of shortening it (AC-19)', () => {
    expect(css).toMatch(/prefers-reduced-motion: reduce\)[\s\S]*animation: none !important/);
    expect(css).not.toContain('0.01ms');
    for (const name of ['lift', 'press', 'sheen', 'enter', 'enter-children', 'pop', 'pulse-ui']) {
      const start = css.indexOf(`@utility ${name} {`);
      expect(start, name).toBeGreaterThan(-1);
      expect(css.slice(start, start + 120), name).toContain(
        'prefers-reduced-motion: no-preference',
      );
    }
  });
  it('keeps the sheen at 600ms over transition-ui, and idle buttons free of a transform (AC-18)', () => {
    const ui = css.slice(css.indexOf('@utility transition-ui {'), css.indexOf('@utility lift {'));
    expect(ui).not.toContain('background-position');
    const sheen = css.slice(css.indexOf('@utility sheen {'), css.indexOf('@utility enter {'));
    expect(sheen).toMatch(/&\.sheen \{[\s\S]*background-position[\s\S]*600ms/);
    for (const name of ['lift', 'press']) {
      const start = css.indexOf(`@utility ${name} {`);
      const body = css.slice(start, css.indexOf('}\n\n', start));
      expect(body, name).not.toMatch(/^ {4}transform:/m);
    }
  });

  it('keeps a stripe visible on a card edge and scopes the toast action rule', () => {
    const edge = css.slice(
      css.indexOf('@utility gradient-card-edge {'),
      css.indexOf('@utility gradient-secondary-edge'),
    );
    expect(edge).toContain(':where(&)');
    expect(css).toContain('[data-button]:not([data-cancel])');
  });
});

describe('section-label utility', () => {
  const start = css.indexOf('@utility section-label {');
  const body = css.slice(start, css.indexOf('\n}\n', start));

  it('keeps the gap after the slashes as an inline end margin, not a trailing space', () => {
    expect(body).toMatch(/&::before \{[^}]*margin-inline-end:\s*1ch;/);
    expect(body).toContain("content: '//' / '';");
    expect(body).not.toMatch(/content: '\/\/ '/);
    expect(body).not.toMatch(/direction:\s*ltr/);
  });

  it('puts size and weight at zero specificity so a caller class wins', () => {
    expect(body).toMatch(/:where\(&\) \{[^}]*font-size:[^}]*font-weight: 400;/);
  });
});
