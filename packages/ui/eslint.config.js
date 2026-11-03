import { i18n } from '@ssdashboard/config/eslint/i18n';
import { react } from '@ssdashboard/config/eslint/react';

// Components take all text through props (spec 0004): no literal text or aria labels, and
// no Intl formatting here. The formatting module lives in the web app, so nothing is exempt.
const config = [...react(import.meta.dirname), ...i18n({ formatModule: 'src/none' })];

export default config;
