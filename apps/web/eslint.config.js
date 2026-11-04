import { i18n } from '@ssdashboard/config/eslint/i18n';
import { next } from '@ssdashboard/config/eslint/next';

const config = [...next(import.meta.dirname), ...i18n()];

export default config;
