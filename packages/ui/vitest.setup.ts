import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

/** Adds the browser APIs Radix and cmdk reach for that jsdom lacks. */
function stubMissing(target: object, stubs: Record<string, unknown>) {
  for (const [name, value] of Object.entries(stubs)) {
    if (!(name in target)) {
      Object.defineProperty(target, name, { value, configurable: true, writable: true });
    }
  }
}

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

stubMissing(globalThis, { ResizeObserver: ResizeObserverStub });
stubMissing(window, {
  matchMedia: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: () => false,
  }),
});
stubMissing(Element.prototype, {
  scrollIntoView: vi.fn(),
  hasPointerCapture: () => false,
  setPointerCapture: vi.fn(),
  releasePointerCapture: vi.fn(),
});

afterEach(() => {
  cleanup();
});
