import {
  BadRequestException,
  Controller,
  HttpCode,
  Inject,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { Audience } from '../../platform/audience/audience.decorator.js';
import { RequiresModule } from '../../platform/modules/requires-module.decorator.js';
import type { HookRequest } from './mount-hooks.js';
import { ShopifyHooksService } from './shopify-hooks.service.js';

/** The longest topic and webhook id the inbox stores (its length checks). */
const MAX_TOPIC = 64;
const MAX_WEBHOOK_ID = 128;

/** One header as text, or undefined. */
function headerOf(req: HookRequest, name: string): string | undefined {
  const value = req.headers[name];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/**
 * The Shopify webhook hook (spec 0015 AC-4, AC-5, task 7): `POST /api/hooks/shopify/:connectionId`.
 * Audience `hook`, so no session, no permission; it proves itself only by signature and shop
 * domain, checked on the raw bytes by `mountHooks` before this handler runs (a failure there is an
 * empty 401 and never reaches here). The module gate always lets a hook route answer: module
 * state is decided by `acceptsHook` inside the service. A verified delivery is recorded in the
 * inbox with its job and answers 200 `{}`; a repeat answers 200 and adds nothing. A verified
 * delivery without a topic or webhook id, or whose body is not JSON, answers 400 with a code.
 */
@Audience('hook')
@RequiresModule('connectors')
@Controller('hooks/shopify')
export class ShopifyHooksController {
  /** Takes the service that records deliveries. */
  constructor(@Inject(ShopifyHooksService) private readonly hooks: ShopifyHooksService) {}

  /** Records one verified delivery (see the class). Never echoes a header or the body. */
  @Post(':connectionId')
  @HttpCode(200)
  async receive(@Req() req: HookRequest): Promise<Record<string, never>> {
    // The verifier sets the proof; without it the audience guard has refused already.
    const proof = req.hook;
    if (!proof || !req.rawBody) throw new UnauthorizedException();
    const topic = headerOf(req, 'x-shopify-topic');
    const webhookId = headerOf(req, 'x-shopify-webhook-id');
    if (!topic || topic.length > MAX_TOPIC || !webhookId || webhookId.length > MAX_WEBHOOK_ID) {
      throw new BadRequestException({ code: 'INVALID_HOOK', message: 'Missing hook headers' });
    }
    let body: unknown;
    try {
      body = JSON.parse(req.rawBody.toString('utf8')) as unknown;
    } catch {
      throw new BadRequestException({ code: 'INVALID_HOOK_BODY', message: 'Not JSON' });
    }
    await this.hooks.record({ connectionId: proof.connectionId, topic, webhookId, body });
    return {};
  }
}
