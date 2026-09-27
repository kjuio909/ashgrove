import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import { defer, type Observable } from 'rxjs';
import { RequestContextHost } from './request-context.host.js';

/**
 * Global interceptor installed by {@link RequestContextModule}. It locates
 * the snapshot that the request hook attached to the platform request and
 * subscribes to the handler chain inside that snapshot's async-local
 * context, so `RequestContextHost.current()` stays available in
 * continuations even when the request object is not passed around.
 *
 * `defer` re-enters the async context when the router subscribes: the
 * handler observable is both created and subscribed within the `run`
 * callback, so the framework's `AsyncResource.bind` inside the handler chain
 * captures the snapshot context. The factory must return the handler
 * observable directly - `defer` already subscribes to it, and a flattening
 * operator would wrongly treat the handler's emitted values as streams.
 */
@Injectable()
export class RequestContextInterceptor implements NestInterceptor {
  constructor(private readonly contextHost: RequestContextHost) {}

  public intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Observable<unknown> {
    const snapshot = this.contextHost.getForRequest(
      context.switchToHttp().getRequest(),
    );

    if (!snapshot) {
      // Snapshot missing (e.g. unsupported custom adapter): pass through.
      return next.handle();
    }
    return defer(() =>
      this.contextHost.runWithContext(snapshot, () => next.handle()),
    );
  }
}
