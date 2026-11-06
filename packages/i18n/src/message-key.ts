import './i18next-types.js';
import type { ParseKeys } from 'i18next';

/**
 * A key into the English catalog (plural keys by their base name). Registries such as the
 * navigation list store keys, not text, and translate them where they are shown.
 */
export type MessageKey = ParseKeys<'translation'>;
