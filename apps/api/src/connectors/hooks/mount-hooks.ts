import type { NestExpressApplication } from '@nestjs/platform-express';
import type { NextFunction, Request, Response } from 'express';
import { ShopifyHookVerifier, type ShopifyHookProof } from './shopify-hook-verifier.js';

/** Where every connector hook lives, before the global `/api` prefix is applied by Nest. */
const HOOKS_BASE = '/api/hooks';

/** The most raw body a hook reads (spec 0015 AC-4): 2 MB. One byte more answers 413. */
export const HOOK_BODY_LIMIT_BYTES = 2 * 1024 * 1024;

/** The Shopify hook path: `/api/hooks/shopify/<connection id>` with nothing after it. */
const SHOPIFY_PATH = /^\/api\/hooks\/shopify\/([^/?#]+)\/?$/;

/** A hook request after the reader: its raw bytes, and the proof once verified. */
export interface HookRequest extends Request {
  /** The raw body, exactly as received (never parsed by the JSON parser). */
  rawBody?: Buffer;
  /** Set only by the verifier, read by the audience guard and the hook route. */
  hook?: ShopifyHookProof;
}

/** Reads the whole body into one buffer; resolves null once it passes the cap. */
function readCapped(req: Request, limit: number): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let over = false;
    req.on('data', (chunk: Buffer) => {
      if (over) return;
      total += chunk.length;
      if (total > limit) {
        over = true;
        chunks.length = 0;
        resolve(null);
        // Keep reading (and dropping) so the 413 answer reaches the sender.
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!over) resolve(Buffer.concat(chunks));
    });
    req.on('error', reject);
  });
}

/** An empty answer: a hook refusal never says why (AC-4). */
function refuse(res: Response, status: number): void {
  res.status(status).end();
}

/**
 * Mounts the connector hooks' raw body reader and the Shopify signature check on `/api/hooks`
 * (spec 0015 Inbound processing item 1). Call it in `configureApp` after Better Auth (which must
 * read its own raw body) and before the JSON and form parsers, so a hook's bytes reach the
 * signature check exactly as sent. The reader takes at most 2 MB (413, empty, above, by
 * `Content-Length` or while reading); the body is consumed, so the parsers after it skip it.
 *
 * On `POST /api/hooks/shopify/:connectionId` the verifier checks the shop header and the HMAC
 * before anything is parsed; a failure of any kind answers the same empty 401, and a pass puts
 * the proof on `request.hook`, which the audience guard reads as the `hook` audience. Other hook
 * paths get their bytes read and nothing else (the router answers 404). Never logs a header or a
 * body byte.
 */
export function mountHooks(app: NestExpressApplication): void {
  const verifier = app.get(ShopifyHookVerifier);
  const server = app.getHttpAdapter().getInstance() as {
    use: (path: string, handler: (req: Request, res: Response, next: NextFunction) => void) => void;
  };
  server.use(HOOKS_BASE, (req, res, next) => {
    const hookReq = req as HookRequest;
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > HOOK_BODY_LIMIT_BYTES) {
      refuse(res, 413);
      req.resume();
      return;
    }
    readCapped(req, HOOK_BODY_LIMIT_BYTES)
      .then(async (raw) => {
        if (raw === null) {
          refuse(res, 413);
          return;
        }
        hookReq.rawBody = raw;
        const path = new URL(req.originalUrl, 'http://localhost').pathname;
        const match = SHOPIFY_PATH.exec(path);
        if (!match) {
          next();
          return;
        }
        if (req.method !== 'POST') {
          refuse(res, 401);
          return;
        }
        const header = (name: string): string | undefined => {
          const value = req.headers[name];
          return typeof value === 'string' ? value : undefined;
        };
        const proof = await verifier.verify({
          connectionId: decodeURIComponent(match[1] ?? ''),
          signature: header('x-shopify-hmac-sha256'),
          shopDomain: header('x-shopify-shop-domain'),
          rawBody: raw,
        });
        if (!proof) {
          refuse(res, 401);
          return;
        }
        hookReq.hook = proof;
        next();
      })
      .catch((error: unknown) => next(error));
  });
}
