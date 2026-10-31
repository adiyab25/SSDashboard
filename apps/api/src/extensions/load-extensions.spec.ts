import { Logger } from '@nestjs/common';
import * as nodePath from 'node:path';
import * as nodeUrl from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadExtensions } from './load-extensions.js';

describe('loadExtensions', () => {
  let log: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('loads nothing for the core install', async () => {
    expect(await loadExtensions([])).toEqual([]);
    expect(log).not.toHaveBeenCalled();
  });

  it('imports every listed package, in the listed order', async () => {
    const [first, second] = (await loadExtensions(['node:path', 'node:url'])) as [
      typeof nodePath,
      typeof nodeUrl,
    ];

    expect(first.join).toBe(nodePath.join);
    expect(second.fileURLToPath).toBe(nodeUrl.fileURLToPath);
  });

  it('logs each extension it loads', async () => {
    await loadExtensions(['node:path']);

    expect(log).toHaveBeenCalledWith('Loaded extension node:path');
  });

  it('fails startup when a listed package is not installed', async () => {
    await expect(loadExtensions(['@ssdashboard/no-such-extension'])).rejects.toThrow(
      /@ssdashboard\/no-such-extension/,
    );
  });

  it('stops at the first package that fails to load', async () => {
    await expect(loadExtensions(['@ssdashboard/no-such-extension', 'node:path'])).rejects.toThrow();

    expect(log).not.toHaveBeenCalled();
  });
});
