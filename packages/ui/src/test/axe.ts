import axe from 'axe-core';
import { expect } from 'vitest';

/**
 * Fails the test when axe finds a violation in the given element. jsdom has no layout
 * or color, so this checks roles, names, and structure only; Playwright checks
 * contrast and target size. Pass `document.body` for overlays, which Radix portals
 * render outside the container.
 */
export async function expectNoAxeViolations(element: Element): Promise<void> {
  const results = await axe.run(element, {
    rules: { 'color-contrast': { enabled: false }, region: { enabled: false } },
  });
  const summary = results.violations.map(
    (violation) =>
      `${violation.id}: ${violation.help}\n  ${violation.nodes.map((node) => node.html).join('\n  ')}`,
  );
  expect(summary).toEqual([]);
}
