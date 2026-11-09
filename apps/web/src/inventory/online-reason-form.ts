import { MakeLocationOnlineRequest } from '@ssdashboard/contracts';
import { z } from 'zod';

/**
 * The reason form of the online dialogs: the contract's reason rules (trimmed, up to 500) made
 * required, because the contract keeps the field optional so a blank one reaches the api's own 422.
 * The form blocks a blank reason before it is sent.
 */
export const OnlineReasonForm = z.object({
  reason: MakeLocationOnlineRequest.shape.reason.unwrap().min(1),
});
/** What the reason form holds while it is typed. */
export type OnlineReasonForm = z.input<typeof OnlineReasonForm>;
