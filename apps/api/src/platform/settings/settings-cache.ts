import { Injectable } from '@nestjs/common';

/** How long a cached setting is trusted without a notification (spec 0009, AC-4): 30 seconds. */
export const SETTINGS_CACHE_LIFETIME_MS = 30_000;

/**
 * One setting as the database holds it, already checked against its registry schema: `value` is
 * the parsed value, or the default when there is no row (`hasRow: false`) or the row fails its
 * schema (`invalid: true`). `raw` is the stored JSON, kept only to compare a write against.
 */
export interface StoredSetting {
  key: string;
  value: unknown;
  raw: unknown;
  hasRow: boolean;
  invalid: boolean;
  /** `settings.updated_at` in UTC with microseconds, or null without a row. */
  updatedAt: string | null;
  updatedBy: string | null;
}

interface CachedSetting {
  setting: StoredSetting;
  expiresAt: number;
}

/**
 * The per process cache of settings reads that pass no transaction (spec 0009, AC-2, AC-4). An
 * entry lives 30 seconds; `PlatformChangesListener` drops entries on every
 * `NOTIFY ssd_platform_changed` and drops everything after it reconnects. A load that started
 * before a drop is never stored (`generation`), so a value read just before a change cannot
 * outlive the notification of that change. It holds values only in memory and never logs them.
 */
@Injectable()
export class SettingsCache {
  private readonly entries = new Map<string, CachedSetting>();
  private currentGeneration = 0;

  /** The cached setting, or undefined when absent or older than the lifetime. */
  get(key: string): StoredSetting | undefined {
    const cached = this.entries.get(key);
    if (!cached) return undefined;
    if (cached.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return cached.setting;
  }

  /** A token to take before loading from the database and pass to `store`. */
  generation(): number {
    return this.currentGeneration;
  }

  /**
   * Keeps a loaded setting for the lifetime, unless the cache was dropped since `generation` was
   * taken (a change landed while the load ran).
   */
  store(setting: StoredSetting, generation: number): void {
    if (generation !== this.currentGeneration) return;
    this.entries.set(setting.key, {
      setting,
      expiresAt: Date.now() + SETTINGS_CACHE_LIFETIME_MS,
    });
  }

  /** Drops one key, or every key when none is given. Any load in flight is not stored. */
  drop(key?: string): void {
    this.currentGeneration += 1;
    if (key === undefined) this.entries.clear();
    else this.entries.delete(key);
  }
}
