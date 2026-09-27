import { createParamDecorator } from '@nestjs/common';
import { REQUEST_CONTEXT_SNAPSHOT } from './request-context.constants.js';
import type { RequestContextSnapshot } from './request-context-snapshot.js';

/**
 * Route handler parameter decorator that injects the
 * {@link RequestContextSnapshot} of the current request.
 *
 * ```ts
 * @Get('work')
 * doWork(@RequestContext() context: RequestContextSnapshot) {
 *   context.set('marker', marker);
 *   context.registerAfterTerminated(snapshot => ...);
 * }
 * ```
 *
 * Reading the snapshot through a parameter decorator keeps the enclosing
 * controller a singleton (the snapshot travels on the request object rather
 * than through request-scoped injection) and works identically on Express
 * and Fastify. The factory only reads the snapshot off the request, so it
 * stays correct when several Nest applications coexist in one process.
 *
 * @publicApi
 */
export const RequestContext = createParamDecorator(
  (_data: unknown, executionContext): RequestContextSnapshot | undefined => {
    const request = executionContext.switchToHttp().getRequest<{
      [key: symbol]: unknown;
      raw?: { [key: symbol]: unknown };
    }>();

    const fromRequest = request?.[REQUEST_CONTEXT_SNAPSHOT];
    if (isSnapshot(fromRequest)) {
      return fromRequest;
    }
    const fromRaw = request?.raw?.[REQUEST_CONTEXT_SNAPSHOT];
    return isSnapshot(fromRaw) ? fromRaw : undefined;
  },
);

function isSnapshot(value: unknown): value is RequestContextSnapshot {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as Partial<RequestContextSnapshot>)
      .registerAfterTerminated === 'function' &&
    typeof (value as Partial<RequestContextSnapshot>).terminate === 'function'
  );
}
