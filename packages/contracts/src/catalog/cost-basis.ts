import { z } from 'zod';

/** Where a style's cost came from. A margin that rests on an `estimate` is labelled so (spec 0002, A12). */
export const CostBasis = z.enum([
  'factory_invoice',
  'production_run',
  'purchase_landed',
  'estimate',
]);
/** The validated shape of `CostBasis`, as the api and web see it after parsing. */
export type CostBasis = z.infer<typeof CostBasis>;
