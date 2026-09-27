import { AsyncLocalStorage } from 'async_hooks';
import { AbstractHttpAdapter } from '../adapters/http-adapter.js';
import { HttpAdapterHost } from '../helpers/http-adapter-host.js';
import {
  Injectable,
  OnApplicationShutdown,
  OnModuleInit,
} from '@nestjs/common';
import { REQUEST_CONTEXT_SNAPSHOT } from './request-context.constants.js';
import { RequestContextSnapshot } from './request-context-snapshot.js';

/**
 * Per-application registry that binds {@link RequestContextSnapshot}
 * instances to HTTP requests and drives their lifecycle.
 *
 * A snapshot is created at the very beginning of every request (through the
 * adapter request hook) and terminated exactly once when the underlying
 * response emits `finish` (response completed, including error responses
 * produced by exception filters) or `close` without having finished (client
 * aborted). Termination is idempotent on the snapshot itself, so framework
 * quirks that surface both events can never double-terminate it.
 *
 * The host is an application-scoped singleton provided by
 * {@link RequestContextModule}; each Nest application therefore gets its own
 * instance and its own set of snapshots. During application shutdown it
 * awaits every snapshot's post-response callbacks before the shutdown
 * sequence completes.
 *
 * @publicApi
 */
@Injectable()
export class RequestContextHost implements OnModuleInit, OnApplicationShutdown {
  private readonly asyncLocalStorage =
    new AsyncLocalStorage<RequestContextSnapshot>();

  /**
   * Snapshots that still matter to the application: either their request has
   * not terminated yet, or they still have post-response callbacks in
   * flight. Snapshots are removed as soon as they are frozen with no pending
   * work, so the set does not grow with request volume. A callback
   * registered later on a frozen snapshot re-adds its snapshot.
   */
  private readonly tracked = new Set<RequestContextSnapshot>();

  /**
   * Raw responses that already have their terminal listeners attached.
   */
  private readonly attachedResponses = new WeakSet<object>();

  constructor(private readonly httpAdapterHost: HttpAdapterHost) {}

  /**
   * Installs the request-entry hook on the underlying HTTP adapter. The hook
   * is read by the built-in adapters per incoming request, so registering it
   * during module initialization (after the adapter itself was constructed)
   * still takes effect for every request.
   */
  public onModuleInit(): void {
    const adapter = this.httpAdapterHost.httpAdapter;
    adapter?.setOnRequestHook?.(
      (request: unknown, response: unknown, done: () => void) => {
        try {
          this.attachToRequest(request, response, adapter);
        } finally {
          done();
        }
      },
    );
  }

  /**
   * Runs `callback` with `snapshot` set as the current async context, so
   * request-scoped call trees can retrieve it via {@link current}.
   */
  public runWithContext<T>(
    snapshot: RequestContextSnapshot,
    callback: () => T,
  ): T {
    return this.asyncLocalStorage.run(snapshot, callback);
  }

  /**
   * Returns the snapshot associated with the current async context, if code
   * is running (synchronously or in ALS-propagated continuations) within a
   * request handled by {@link RequestContextModule}.
   */
  public current(): RequestContextSnapshot | undefined {
    return this.asyncLocalStorage.getStore();
  }

  /**
   * Returns the snapshot previously attached to a platform request object
   * (Express request or Fastify request wrapper), checking the raw request as
   * a fallback.
   */
  public getForRequest(request: unknown): RequestContextSnapshot | undefined {
    if (!request || typeof request !== 'object') {
      return undefined;
    }
    const carrier = request as Record<symbol, unknown>;
    const fromWrapper = carrier[REQUEST_CONTEXT_SNAPSHOT];
    if (fromSnapshot(fromWrapper)) {
      return fromWrapper;
    }
    const raw = (request as { raw?: unknown }).raw;
    const fromRaw = (raw as Record<symbol, unknown> | undefined)?.[
      REQUEST_CONTEXT_SNAPSHOT
    ];
    return fromSnapshot(fromRaw) ? fromRaw : undefined;
  }

  /**
   * Drains all registered post-response callbacks during shutdown.
   *
   * This hook runs after the HTTP server has been closed and awaited, so the
   * server no longer accepts new requests and every in-flight request has
   * already terminated its snapshot. Every tracked snapshot is awaited until
   * frozen and until its callbacks settle. Callbacks that fail are captured
   * by the snapshot and do not abort the shutdown.
   */
  public async onApplicationShutdown(): Promise<void> {
    await Promise.all(
      [...this.tracked].map(async snapshot => {
        await snapshot.whenFrozen();
        await snapshot.whenAllCallbacksSettled();
      }),
    );
  }

  private attachToRequest(
    request: unknown,
    response: unknown,
    adapter: AbstractHttpAdapter,
  ): void {
    if (!request || typeof request !== 'object') {
      return;
    }

    const { platformRequest, rawRequest, rawResponse } = this.resolveTransport(
      request,
      response,
      adapter,
    );

    if (!rawResponse || typeof rawResponse !== 'object') {
      return;
    }

    const existing = this.getForRequest(platformRequest);
    const snapshot = existing ?? new RequestContextSnapshot();

    if (!existing) {
      defineSnapshot(platformRequest, snapshot);
      if (rawRequest && rawRequest !== platformRequest) {
        defineSnapshot(rawRequest, snapshot);
      }
      this.trackSnapshot(snapshot);
    }

    if (this.attachedResponses.has(rawResponse)) {
      return;
    }
    this.attachedResponses.add(rawResponse);

    const carrier = rawResponse as {
      once(event: string, listener: () => void): unknown;
      removeListener(event: string, listener: () => void): unknown;
      writableEnded?: boolean;
      writableFinished?: boolean;
    };

    // Defensive: a custom adapter or static-asset shortcut could in theory
    // end a response before the request chain reached our hook. Terminate
    // immediately instead of waiting for events that will never fire.
    if (carrier.writableEnded || carrier.writableFinished) {
      snapshot.terminate('finish');
      return;
    }

    const onFinish = () => {
      carrier.removeListener('close', onClose);
      snapshot.terminate('finish');
    };
    const onClose = () => {
      carrier.removeListener('finish', onFinish);
      // `finish` is always emitted before `close` for completed responses.
      // A `close` without `writableEnded` means the client went away first.
      if (!carrier.writableEnded) {
        snapshot.terminate('abort');
      } else {
        snapshot.terminate('finish');
      }
    };

    carrier.once('finish', onFinish);
    carrier.once('close', onClose);
  }

  /**
   * Tracks a snapshot until it no longer has any in-flight work. The listener
   * re-adds the snapshot if a late callback makes it pending again, and
   * releases it once everything settles, so memory usage is bounded by live
   * work rather than total request count.
   */
  private trackSnapshot(snapshot: RequestContextSnapshot): void {
    this.tracked.add(snapshot);
    snapshot.addPendingStateListener(pending => {
      if (pending) {
        this.tracked.add(snapshot);
      } else if (snapshot.isFrozen()) {
        // Requests still in flight (not frozen) remain tracked regardless of
        // callback state: their termination may schedule callbacks later.
        this.tracked.delete(snapshot);
      }
    });
  }

  private resolveTransport(
    request: unknown,
    response: unknown,
    adapter: AbstractHttpAdapter,
  ): {
    platformRequest: object;
    rawRequest: object | undefined;
    rawResponse: object | undefined;
  } {
    const platformRequest = request as object;
    if (adapter.getType() === 'fastify') {
      const fastifyRequest = request as {
        raw?: object;
      };
      const fastifyReply = response as { raw?: object };
      return {
        platformRequest,
        rawRequest: fastifyRequest.raw,
        rawResponse: fastifyReply.raw,
      };
    }
    return {
      platformRequest,
      rawRequest: platformRequest,
      rawResponse: response as object,
    };
  }
}

function defineSnapshot(
  target: object,
  snapshot: RequestContextSnapshot,
): void {
  Object.defineProperty(target, REQUEST_CONTEXT_SNAPSHOT, {
    value: snapshot,
    writable: false,
    configurable: true,
    enumerable: false,
  });
}

function fromSnapshot(value: unknown): value is RequestContextSnapshot {
  return value instanceof RequestContextSnapshot;
}
