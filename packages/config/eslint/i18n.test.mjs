import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import tseslint from 'typescript-eslint';
import { i18n } from './i18n.js';

// Spec 0004 AC-5 and AC-8: planted violations must fail lint, allowed code must pass.
const eslint = new ESLint({
  cwd: fileURLToPath(new URL('..', import.meta.url)),
  overrideConfigFile: true,
  overrideConfig: [
    { files: ['**/*.{ts,tsx}'], languageOptions: { parser: tseslint.parser } },
    ...i18n(),
  ],
});

async function rulesFlagged(code, filePath) {
  const [result] = await eslint.lintText(code, { filePath });
  return result.messages.map((message) => message.ruleId);
}

const LITERAL = 'i18next/no-literal-string';
const RESTRICTED = 'no-restricted-syntax';

describe('raw text in markup (AC-5)', () => {
  it('fails on JSX text', async () => {
    const code = 'export function A() { return <p>Save changes</p>; }';
    assert.deepEqual(await rulesFlagged(code, 'src/shell/a.tsx'), [LITERAL]);
  });

  it('fails on aria-label, title, placeholder, and alt', async () => {
    for (const attribute of ['aria-label', 'title', 'placeholder', 'alt']) {
      const code = `export function A() { return <input ${attribute}="Search" />; }`;
      assert.deepEqual(await rulesFlagged(code, 'src/shell/a.tsx'), [LITERAL], attribute);
    }
  });

  it('allows text that comes from the catalog, and attributes that are not text', async () => {
    const code = `export function A({ t }) {
      return <a href="/orders" className="p-2 text-sm" lang="ar" dir="rtl" data-slot="x">{t('a.b')}</a>;
    }`;
    assert.deepEqual(await rulesFlagged(code, 'src/shell/a.tsx'), []);
  });

  it('exempts the development only /design specimens, test specs, and e2e files', async () => {
    const code = 'export function A() { return <p aria-label="Label">Specimen</p>; }';
    assert.deepEqual(await rulesFlagged(code, 'src/design/gallery.tsx'), []);
    assert.deepEqual(await rulesFlagged(code, 'src/shell/a.spec.tsx'), []);
    assert.deepEqual(await rulesFlagged(code, 'src/i18n/language-test-utils.tsx'), []);
    assert.deepEqual(await rulesFlagged(code, 'e2e/shell.tsx'), []);
  });
});

describe('formatting outside the shared module (AC-8)', () => {
  it('fails on toLocaleString, toLocaleDateString, and toLocaleTimeString', async () => {
    for (const method of ['toLocaleString', 'toLocaleDateString', 'toLocaleTimeString']) {
      const code = `export const x = (n) => n.${method}();`;
      assert.deepEqual(await rulesFlagged(code, 'src/shell/a.ts'), [RESTRICTED], method);
    }
  });

  it('fails on new Intl.* and on calling Intl.NumberFormat without new', async () => {
    assert.deepEqual(
      await rulesFlagged("export const f = new Intl.NumberFormat('en');", 'src/shell/a.ts'),
      [RESTRICTED],
    );
    assert.deepEqual(
      await rulesFlagged("export const f = Intl.NumberFormat('en');", 'src/shell/a.ts'),
      [RESTRICTED],
    );
  });

  it('allows the static Intl helpers', async () => {
    const code = "export const tags = Intl.getCanonicalLocales('en-gb');";
    assert.deepEqual(await rulesFlagged(code, 'src/shell/a.ts'), []);
  });

  it('allows the formatting module itself, test specs, and e2e files', async () => {
    const code =
      "export const f = new Intl.NumberFormat('en'); export const s = (n) => n.toLocaleString();";
    assert.deepEqual(await rulesFlagged(code, 'src/i18n/format.ts'), []);
    assert.deepEqual(await rulesFlagged(code, 'src/i18n/format.spec.ts'), []);
    assert.deepEqual(await rulesFlagged(code, 'e2e/home.spec.ts'), []);
  });

  it('still catches it in App Router special files, which may default export', async () => {
    const code = 'export default function Page() { return (5).toLocaleString(); }';
    assert.deepEqual(await rulesFlagged(code, 'src/app/page.tsx'), [RESTRICTED]);
    assert.deepEqual(
      await rulesFlagged('export default function Page() { return null; }', 'src/app/page.tsx'),
      [],
    );
  });

  it('keeps the named export rule elsewhere', async () => {
    const code = 'export default function A() { return null; }';
    assert.deepEqual(await rulesFlagged(code, 'src/shell/a.tsx'), [RESTRICTED]);
  });
});
