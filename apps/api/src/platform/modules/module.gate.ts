import {
  Inject,
  Injectable,
  InternalServerErrorException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import type { EffectiveState } from '@ssdashboard/contracts';
import { audienceOf, type AudienceName } from '../audience/audience.decorator.js';
import { ModuleOff, moduleHttpError } from './module.errors.js';
import { ModuleRegistry } from './module-registry.js';
import { ModuleStateService } from './module-state.service.js';
import { routeDeclarationOf } from './requires-module.decorator.js';

/**
 * Whether a route of `audience` and `method` answers while its module or capability is in
 * `state` (spec 0009, AC-8). Staff, partner, and public routes: `off` never, `read_only` only for
 * `GET` (the brand's data stays readable), `limited` and `on` always (a `limited` owning service
 * refuses a write on a newer record with 409 `MODULE_LIMITED`). Portal routes: new work only while
 * `on`; a `GET` keeps answering while `limited` or `read_only` (a customer's submitted request,
 * D17). Hook routes always answer: the connector records `ignored_unlicensed` itself. Pure.
 */
export function routeAnswers(
  audience: AudienceName,
  method: string,
  state: EffectiveState['state'],
): boolean {
  const read = method.toUpperCase() === 'GET' || method.toUpperCase() === 'HEAD';
  switch (audience) {
    case 'hook':
      return true;
    case 'portal':
      return state === 'on' || (read && state !== 'off');
    case 'staff':
    case 'partner':
    case 'public':
      return state === 'on' || state === 'limited' || (read && state === 'read_only');
  }
}

/**
 * The module wall (spec 0009, AC-8), the last global guard: after the session, audience, and
 * permission guards, so an anonymous or forbidden caller still gets 401 or 403. It reads the
 * route's `@RequiresModule` or `@RequiresCapability` (a handler's narrowing first) and answers
 * 404 `MODULE_OFF` where `routeAnswers` says no. A route without a declaration, or with a key the
 * registry does not list, answers 500 `MODULE_MISSING` (our bug; `requires-module.spec.ts` should
 * have caught it). A core route skips the state read. It never answers 500 because a module is
 * off, and never names a module in its answer.
 */
@Injectable()
export class ModuleGate implements CanActivate {
  /** Takes the registry and the module state service. */
  constructor(
    @Inject(ModuleRegistry) private readonly registry: ModuleRegistry,
    @Inject(ModuleStateService) private readonly states: ModuleStateService,
  ) {}

  /** Applies the rules above. */
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const declaration = routeDeclarationOf(context.getHandler(), context.getClass());
    const known =
      declaration &&
      (declaration.kind === 'module'
        ? this.registry.module(declaration.key)
        : this.registry.capability(declaration.key));
    if (!declaration || !known) {
      throw new InternalServerErrorException({
        code: 'MODULE_MISSING',
        message: 'This route declares no module.',
      });
    }
    if (this.registry.alwaysOn(declaration.key)) return true;
    const audience = audienceOf(context.getClass()) ?? 'staff';
    const method = context.switchToHttp().getRequest<{ method: string }>().method;
    const state = await this.states.stateOf(declaration.key);
    if (routeAnswers(audience, method, state.state)) return true;
    throw moduleHttpError(new ModuleOff(declaration.key)) as Error;
  }
}
