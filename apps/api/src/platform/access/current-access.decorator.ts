import { createParamDecorator, ForbiddenException, type ExecutionContext } from '@nestjs/common';
import { Access } from './access.js';

/**
 * The caller's `Access`, read from `request.access`, which identity's session guard sets on every
 * `staff` and `partner` request (spec 0008). A handler uses it for checks a declaration cannot
 * express (the `status=archived` rule of `GET /api/locations`) and to pass to a cost serializer.
 * Throws 403 `FORBIDDEN` when there is none, so a route that should not have it fails closed.
 */
export const CurrentAccess = createParamDecorator((_data: unknown, context: ExecutionContext) => {
  const access = context.switchToHttp().getRequest<{ access?: unknown }>().access;
  if (!(access instanceof Access)) {
    throw new ForbiddenException({ code: 'FORBIDDEN', message: 'You do not have access to this.' });
  }
  return access;
});
