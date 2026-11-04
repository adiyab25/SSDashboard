import { base } from './eslint/base.js';

export default [
  // Planted violations for the logical CSS check's own tests.
  { ignores: ['scripts/fixtures/**'] },
  ...base(import.meta.dirname),
];
