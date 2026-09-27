import { EventEmitter } from 'events';
import { HttpAdapterHost } from '../../helpers/http-adapter-host.js';
import { REQUEST_CONTEXT_SNAPSHOT } from '../request-context.constants.js';
import { RequestContextHost } from '../request-context.host.js';
import { RequestContextSnapshot } from '../request-context-snapshot.js';

interface FakeResponse extends EventEmitter {
  writableEnded: boolean;
}

function createResponse(): FakeResponse {
  const response = new EventEmitter() as FakeResponse;
  response.writableEnded = false;
  return response;
}

function createHost(type: 'express' | 'fastify' = 'express') {
  let hook:
    | ((request: unknown, response: unknown, done: () => void) => void)
    | undefined;
  const adapter = {
    getType: () => type,
    setOnRequestHook: (
      onRequestHook: (
        request: unknown,
        response: unknown,
        done: () => void,
      ) => void,
    ) => {
      hook = onRequestHook;
    },
  };
  const adapterHost = { httpAdapter: adapter } as unknown as HttpAdapterHost;
  const host = new RequestContextHost(adapterHost);
  host.onModuleInit();
  return { host, adapter, runHook: hook! };
}

/**
 * Waits for all `setImmediate`-scheduled snapshot callbacks to run.
 */
function flushCallbacks(): Promise<void> {
  return new Promise(resolve => setImmediate(() => setImmediate(resolve)));
}

describe('RequestContextHost', () => {
  it('attaches one snapshot per request and invokes the hook callback', () => {
    const { host, runHook } = createHost();
    const request: any = {};
    const response = createResponse();
    let doneCount = 0;

    runHook(request, response, () => (doneCount += 1));

    expect(doneCount).toBe(1);
    expect(request[REQUEST_CONTEXT_SNAPSHOT]).toBeInstanceOf(
      RequestContextSnapshot,
    );
    expect(host.getForRequest(request)).toBe(request[REQUEST_CONTEXT_SNAPSHOT]);
  });

  it('resolves fastify snapshots through the raw request fallback', () => {
    const { host, runHook } = createHost('fastify');
    const rawRequest: any = {};
    const request: any = { raw: rawRequest };
    const reply: any = { raw: createResponse() };

    runHook(request, reply, () => {});

    expect(host.getForRequest(request)).toBe(
      rawRequest[REQUEST_CONTEXT_SNAPSHOT],
    );
    expect(request[REQUEST_CONTEXT_SNAPSHOT]).toBe(
      rawRequest[REQUEST_CONTEXT_SNAPSHOT],
    );
  });

  it('terminates with "finish" exactly once even when close follows', () => {
    const { host, runHook } = createHost();
    const request: any = {};
    const response = createResponse();
    runHook(request, response, () => {});
    const snapshot = host.getForRequest(request)!;

    response.writableEnded = true;
    response.emit('finish');
    response.emit('close');

    expect(snapshot.getTerminationReason()).toBe('finish');
    expect(snapshot.getTerminationCount()).toBe(1);
  });

  it('terminates with "abort" when close fires before the response ended', () => {
    const { host, runHook } = createHost();
    const request: any = {};
    const response = createResponse();
    runHook(request, response, () => {});
    const snapshot = host.getForRequest(request)!;

    response.emit('close');

    expect(snapshot.getTerminationReason()).toBe('abort');
    expect(snapshot.getTerminationCount()).toBe(1);
  });

  it('terminates immediately when the response already ended', () => {
    const { host, runHook } = createHost();
    const request: any = {};
    const response = createResponse();
    response.writableEnded = true;

    runHook(request, response, () => {});

    const snapshot = host.getForRequest(request)!;
    expect(snapshot.isFrozen()).toBe(true);
    expect(snapshot.getTerminationReason()).toBe('finish');
  });

  it('exposes the snapshot through the async-local context', async () => {
    const { host, runHook } = createHost();
    const request: any = {};
    runHook(request, createResponse(), () => {});
    const snapshot = host.getForRequest(request)!;

    const seen = await host.runWithContext(snapshot, async () => {
      await Promise.resolve();
      await new Promise(resolve => setImmediate(resolve));
      return host.current();
    });

    expect(seen).toBe(snapshot);
    expect(host.current()).toBeUndefined();
  });

  it('tracks live snapshots and releases them once work settles', async () => {
    const { host, runHook } = createHost();
    const request: any = {};
    const response = createResponse();
    runHook(request, response, () => {});
    const snapshot = host.getForRequest(request)!;

    let releaseContinuation: () => void = () => {};
    let started: () => void = () => {};
    const startedPromise = new Promise<void>(resolve => (started = resolve));
    snapshot.registerAfterTerminated(
      () =>
        new Promise<void>(resolve => {
          started();
          releaseContinuation = resolve;
        }),
    );

    response.writableEnded = true;
    response.emit('finish');
    expect(snapshot.hasPendingCallbacks()).toBe(true);

    await startedPromise;
    releaseContinuation();
    await flushCallbacks();
    expect(snapshot.hasPendingCallbacks()).toBe(false);
  });

  it('drains pending continuations during application shutdown', async () => {
    const { host, runHook } = createHost();
    const request: any = {};
    const response = createResponse();
    runHook(request, response, () => {});
    const snapshot = host.getForRequest(request)!;

    let releaseContinuation: () => void = () => {};
    let started: () => void = () => {};
    const startedPromise = new Promise<void>(resolve => (started = resolve));
    let continuationRan = false;
    snapshot.registerAfterTerminated(async () => {
      await new Promise<void>(resolve => {
        started();
        releaseContinuation = resolve;
      });
      continuationRan = true;
    });
    response.writableEnded = true;
    response.emit('finish');
    await startedPromise;

    // Shutdown blocks while the continuation is parked, then completes once
    // the gate (released by the store's onModuleDestroy in real usage) opens.
    let shutdownSettled = false;
    const shutdown = host
      .onApplicationShutdown()
      .then(() => (shutdownSettled = true));
    await Promise.resolve();
    expect(shutdownSettled).toBe(false);

    releaseContinuation();
    await flushCallbacks();
    await shutdown;
    expect(continuationRan).toBe(true);
    expect(shutdownSettled).toBe(true);
  });
});
