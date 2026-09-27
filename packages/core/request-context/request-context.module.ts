import { type DynamicModule, Global, Module, Scope } from '@nestjs/common';
import { APP_INTERCEPTOR } from '../constants.js';
import { REQUEST } from '../router/request/request-constants.js';
import {
  REQUEST_CONTEXT,
  REQUEST_CONTEXT_SNAPSHOT,
} from './request-context.constants.js';
import { RequestContextInterceptor } from './request-context.interceptor.js';
import { RequestContextHost } from './request-context.host.js';
import type { RequestContextSnapshot } from './request-context-snapshot.js';

type SnapshotCarrier = {
  [REQUEST_CONTEXT_SNAPSHOT]?: unknown;
  raw?: { [REQUEST_CONTEXT_SNAPSHOT]?: unknown };
};

function readSnapshot(request: unknown): RequestContextSnapshot | undefined {
  const carrier = request as SnapshotCarrier | undefined;
  if (!carrier) {
    return undefined;
  }
  if (isSnapshot(carrier[REQUEST_CONTEXT_SNAPSHOT])) {
    return carrier[REQUEST_CONTEXT_SNAPSHOT];
  }
  if (isSnapshot(carrier.raw?.[REQUEST_CONTEXT_SNAPSHOT])) {
    return carrier.raw?.[REQUEST_CONTEXT_SNAPSHOT];
  }
  return undefined;
}

function isSnapshot(value: unknown): value is RequestContextSnapshot {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as Partial<RequestContextSnapshot>).terminate === 'function'
  );
}

/**
 * Request-scoped factory backing the {@link REQUEST_CONTEXT} token. The
 * decorator form (`@RequestContext()`) is preferred for controllers, since
 * request-scoped injection makes the injecting provider request-scoped.
 */
const requestContextProvider = {
  provide: REQUEST_CONTEXT,
  scope: Scope.REQUEST,
  inject: [REQUEST],
  useFactory: (request: unknown): RequestContextSnapshot | undefined =>
    readSnapshot(request),
};

/**
 * Enables reusable request metadata snapshots for an HTTP application.
 *
 * Import once, typically in the root module:
 *
 * ```ts
 * @Module({
 *   imports: [RequestContextModule.forRoot()],
 *   controllers: [AppController],
 * })
 * export class AppModule {}
 * ```
 *
 * The module is global: it installs the per-request interceptor and the
 * adapter lifecycle hooks that freeze snapshots on response completion,
 * error responses and client aborts, and drains pending post-response
 * callbacks on application shutdown. When the module is not imported, none of
 * these mechanisms are registered and the application keeps its original
 * behavior.
 *
 * @publicApi
 */
@Global()
@Module({
  providers: [
    RequestContextHost,
    RequestContextInterceptor,
    {
      provide: APP_INTERCEPTOR,
      useExisting: RequestContextInterceptor,
    },
    requestContextProvider,
  ],
  exports: [RequestContextHost, REQUEST_CONTEXT],
})
export class RequestContextModule {
  /**
   * Registers the module. Provided for discoverability and future
   * configuration options; currently takes no options.
   */
  public static forRoot(): DynamicModule {
    return {
      module: RequestContextModule,
    };
  }
}

export { REQUEST_CONTEXT };
export type { RequestContextSnapshot };
