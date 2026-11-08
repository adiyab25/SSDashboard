import type { NestExpressApplication } from '@nestjs/platform-express';
import type { NextFunction, Request, Response } from 'express';
import { ShopifyHookVerifier, type ShopifyHookProof } from './shopify-hook-verifier.js';

/** Where every connector hook lives, before the global `/api` prefix is applied by Nest. */
const HOOKS_BASE = '/api/hooks';

/** The most raw body a hook reads (spec 0015 AC-4): 2 MB. One byte more answers 413. */
export const HOOK_BODY_LIMIT_BYTES = 2 * 1024 * 1024;

/**
 * How long a hook body may take to arrive once the pre-body checks passed (security review M1).
 * Slower answers 408 and the socket is closed.
 */
export const HOOK_BODY_DEADLINE_MS = 10_000;

/**
 * The Shopify hook path: `/api/hooks/shopify/<connection id>` with nothing after it, in any letter
 * case, because Express routes without regard to case (security review L7): a path the router
 * would send to the hook route always meets the verifier first.
 */
const SHOPIFY_PATH = /^\/api\/hooks\/shopify\/([^/?#]+)\/?$/i;

/** A hook request after the reader: its raw bytes, and the proof once verified. */
export interface HookRequest extends Request {
  /** The raw body, exactly as received (never parsed by the JSON parser). */
  rawBody?: Buffer;
  /** Set only by the verifier, read by the audience guard and the hook route. */
  hook?: ShopifyHookProof;
}

/** How reading a body ended. */
type BodyRead =
  | { readonly kind: 'body'; readonly raw: Buffer }
  | { readonly kind: 'too_large' }
  | { readonly kind: 'too_slow' }
  | { readonly kind: 'aborted' };

/**
 * Reads the whole body into one buffer, at most `limit` bytes and within `deadlineMs`. Stops
 * reading (never drains) the moment either is passed.
 */
function readBody(req: Request, limit: number, deadlineMs: number): Promise<BodyRead> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const finish = (read: BodyRead) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onAbort);
      req.off('close', onAbort);
      if (read.kind !== 'body') {
        chunks.length = 0;
        req.pause();
      }
      resolve(read);
    };
    const onData = (chunk: Buffer) => {
      total += chunk.length;
      if (total > limit) {
        finish({ kind: 'too_large' });
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => finish({ kind: 'body', raw: Buffer.concat(chunks) });
    const onAbort = () => finish({ kind: 'aborted' });
    const timer = setTimeout(() => finish({ kind: 'too_slow' }), deadlineMs);
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onAbort);
    req.on('close', onAbort);
  });
}

/**
 * How long a refused socket stays half open after the answer, so the sender can read it before
 * the socket is destroyed. Destroying at once, with request bytes still unread, makes TCP send a
 * reset that throws the answer away on the sender's side.
 */
export const HOOK_REFUSAL_LINGER_MS = 1_000;

/**
 * An empty answer that ends the exchange: a hook refusal never says why (AC-4), and the socket is
 * closed once the answer is written (security review M1): our side is shut at once, and the
 * socket destroyed after `HOOK_REFUSAL_LINGER_MS`, so a sender can keep a refused socket for at
 * most a second, never until the server's request timeout.
 */
function refuse(req: Request, res: Response, status: number): void {
  if (res.headersSent) {
    req.destroy();
    return;
  }
  res.status(status).set('Connection', 'close');
  res.end(() => {
    const socket = req.socket;
    socket.end();
    setTimeout(() => socket.destroy(), HOOK_REFUSAL_LINGER_MS).unref();
  });
}

/** A request header as text when it is one non blank value, else undefined. */
function headerOf(req: Request, name: string): string | undefined {
  const value = req.headers[name];
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/** The connection id of a Shopify hook path, or null for any other path or a bad encoding. */
function shopifyConnectionIdOf(originalUrl: string): string | null {
  let path: string;
  try {
    path = new URL(originalUrl, 'http://localhost').pathname;
  } catch {
    return null;
  }
  const match = SHOPIFY_PATH.exec(path);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1] ?? '');
  } catch {
    // A malformed percent encoding (`%E0`): refused like any other bad id (code review m7).
    return null;
  }
}

/**
 * Mounts the connector hooks' raw body reader and the Shopify signature check on `/api/hooks`
 * (spec 0015 Inbound processing item 1). Call it in `configureApp` after Better Auth (which must
 * read its own raw body) and before the JSON and form parsers, so a hook's bytes reach the
 * signature check exactly as sent; the body is consumed here, so the parsers after it skip it.
 *
 * Everything that needs no body is decided first, before a body byte is read (security review
 * M1): a method other than POST, a path other than `/api/hooks/shopify/<id>` (any letter case), an
 * id that is not a UUID, a missing `X-Shopify-Shop-Domain` or `X-Shopify-Hmac-SHA256`, or a
 * connection that is unknown, archived, or of another shop all answer the same empty 401. A
 * declared `Content-Length` above 2 MB answers an empty 413. Only then is the body read: above
 * 2 MB an empty 413, slower than 10 seconds an empty 408, and a wrong HMAC the same empty 401.
 * Every refusal reads nothing more and closes the socket (after a 1 second linger, so the sender
 * can read the answer). A pass puts the proof on
 * `request.hook`, which the audience guard reads as the `hook` audience. Never logs a header or a
 * body byte.
 */
export function mountHooks(app: NestExpressApplication): void {
  const verifier = app.get(ShopifyHookVerifier);
  const server = app.getHttpAdapter().getInstance() as {
    use: (path: string, handler: (req: Request, res: Response, next: NextFunction) => void) => void;
  };
  server.use(HOOKS_BASE, (req, res, next) => {
    const hookReq = req as HookRequest;
    const connectionId = req.method === 'POST' ? shopifyConnectionIdOf(req.originalUrl) : null;
    const shopDomain = headerOf(req, 'x-shopify-shop-domain');
    const signature = headerOf(req, 'x-shopify-hmac-sha256');
    if (connectionId === null || shopDomain === undefined || signature === undefined) {
      refuse(req, res, 401);
      return;
    }
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > HOOK_BODY_LIMIT_BYTES) {
      refuse(req, res, 413);
      return;
    }
    void (async () => {
      const target = await verifier.target({ connectionId, shopDomain });
      if (!target) {
        refuse(req, res, 401);
        return;
      }
      const read = await readBody(req, HOOK_BODY_LIMIT_BYTES, HOOK_BODY_DEADLINE_MS);
      switch (read.kind) {
        case 'too_large':
          refuse(req, res, 413);
          return;
        case 'too_slow':
          refuse(req, res, 408);
          return;
        case 'aborted':
          req.destroy();
          return;
        case 'body':
          break;
      }
      const proof = await verifier.prove(target, signature, read.raw);
      if (!proof) {
        refuse(req, res, 401);
        return;
      }
      hookReq.rawBody = read.raw;
      hookReq.hook = proof;
      next();
    })().catch((error: unknown) => next(error));
  });
}
