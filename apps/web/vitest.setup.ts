import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

/** Adds the browser APIs next-themes, Radix, and cmdk reach for that jsdom lacks. */
function stubMissing(target: object, stubs: Record<string, unknown>) {
  for (const [name, value] of Object.entries(stubs)) {
    if ((target as Record<string, unknown>)[name] === undefined) {
      Object.defineProperty(target, name, { value, configurable: true, writable: true });
    }
  }
}

/** A plain in-memory Storage, for when the global one is missing or unusable. */
class MemoryStorage implements Storage {
  private readonly items = new Map<string, string>();
  get length() {
    return this.items.size;
  }
  clear() {
    this.items.clear();
  }
  getItem(key: string) {
    return this.items.get(key) ?? null;
  }
  key(index: number) {
    return [...this.items.keys()][index] ?? null;
  }
  removeItem(key: string) {
    this.items.delete(key);
  }
  setItem(key: string, value: string) {
    this.items.set(key, String(value));
  }
}

// Node 25 and later ship their own `localStorage` and `sessionStorage` globals, which
// shadow jsdom's and are empty or throw without `--localstorage-file`. Replace them.
for (const name of ['localStorage', 'sessionStorage'] as const) {
  let usable = false;
  try {
    usable = typeof globalThis[name]?.getItem === 'function';
  } catch {
    usable = false;
  }
  if (!usable) {
    Object.defineProperty(globalThis, name, {
      value: new MemoryStorage(),
      configurable: true,
      writable: true,
    });
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
