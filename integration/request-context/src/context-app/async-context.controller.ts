import {
  BadRequestException,
  Controller,
  Get,
  Query,
  Req,
} from '@nestjs/common';
import {
  RequestContext,
  RequestContextHost,
  type RequestContextSnapshot,
} from '@nestjs/core';
import { AsyncRecordsStore } from '../shared/async-records.store.js';
import { FilteredProbeError } from '../shared/filtered-probe.error.js';
import {
  ASYNC_CONTEXT_ROUTE,
  HEALTH_ROUTE,
  RELEASE_GATES_ROUTE,
} from '../shared/routes.js';
import { SingletonProbeService } from '../shared/singleton-probe.service.js';

/**
 * Probe controller backing the request-context integration tests.
 *
 * - `GET /async-context?marker=...` writes the marker into the request
 *   snapshot, crosses an asynchronous boundary while reading it back,
 *   registers one or more post-response continuations (each parked behind a
 *   per-continuation gate until tests release it) and completes the
 *   response.
 * - `GET /async-records` (see {@link AsyncRecordsController}) reads back
 *   every continuation with its current lifecycle state.
 * - `GET /release-gates[?id=...]` releases parked continuation gates.
 */
@Controller()
export class AsyncContextController {
  constructor(
    private readonly records: AsyncRecordsStore,
    private readonly contextHost: RequestContextHost,
    private readonly singletonProbe: SingletonProbeService,
  ) {}

  @Get(ASYNC_CONTEXT_ROUTE)
  public async probe(
    @Query('marker') marker: string | undefined,
    @Query('registrations') registrations: string | undefined,
    @Query('fail') fail: string | undefined,
    @Query('failCallbackIndex') failCallbackIndex: string | undefined,
    @Query('delayMs') delayMs: string | undefined,
    @RequestContext() context: RequestContextSnapshot | undefined,
    @Req() request: unknown,
  ): Promise<{
    contextId: string;
    marker: string;
    readConsistent: boolean;
    belongsToCurrentRequest: boolean;
    continuationIds: string[];
    aborted?: boolean;
  }> {
    if (!context) {
      throw new Error('Request context snapshot was not attached');
    }
    if (typeof marker !== 'string' || marker.length === 0) {
      throw new BadRequestException('marker query parameter is required');
    }

    // Fixed sequence: write first, then cross an async wait and read back.
    context.set('marker', marker);
    const readBeforeAwait = context.get<string>('marker');
    await Promise.resolve();
    const readAfterAwait = context.get<string>('marker');

    // After the await the async-local continuation must still resolve to
    // this snapshot, and the snapshot attached to the platform request must
    // be the very same instance.
    const currentFromContinuation = this.contextHost.current();
    const attachedToRequest = this.contextHost.getForRequest(request);
    const belongsToCurrentRequest =
      currentFromContinuation === context && attachedToRequest === context;

    const count = clampRegistrations(registrations);
    const failingIndex = parseOptionalIndex(failCallbackIndex);
    const continuationIds: string[] = [];

    for (let index = 0; index < count; index++) {
      const registrationIndex = index;
      const continuationId = this.records.register(context.id, marker);

      context.registerAfterTerminated(
        async (snapshot: RequestContextSnapshot) => {
          try {
            // The body stays parked until the test releases the gate. Until
            // then `/async-records` reports `pending`, which also covers
            // "callback registered but not finished yet".
            await this.records.waitForGate(continuationId);

            if (fail === 'continuation' || failingIndex === registrationIndex) {
              throw new Error(`intentional continuation failure: ${marker}`);
            }

            const firstRead = snapshot.get<string>('marker') ?? null;
            await Promise.resolve();
            const secondRead = snapshot.get<string>('marker') ?? null;

            // A write attempted after the freeze must be rejected and must
            // not change the value read back afterwards.
            const lateWriteAccepted = snapshot.set('lateWrite', marker);
            const thirdRead = snapshot.get<string>('marker') ?? null;

            this.records.markCompleted(continuationId, {
              frozenValue: firstRead,
              frozenValueStable:
                firstRead === marker &&
                secondRead === marker &&
                thirdRead === marker &&
                !lateWriteAccepted,
              lateWriteAccepted,
            });
          } catch (error) {
            // A failing continuation fails only its own record; sibling
            // continuations and other requests are untouched.
            this.records.markFailed(continuationId, error);
          }
        },
      );

      continuationIds.push(continuationId);
    }

    if (fail === 'request') {
      throw new BadRequestException('intentional controller failure');
    }
    if (fail === 'filtered') {
      throw new FilteredProbeError(marker);
    }

    if (delayMs !== undefined) {
      const aborted = await waitForCompletionOrAbort(
        request,
        Number.parseInt(delayMs, 10) || 0,
      );
      if (aborted) {
        return {
          contextId: context.id,
          marker,
          readConsistent:
            readBeforeAwait === marker && readAfterAwait === marker,
          belongsToCurrentRequest,
          continuationIds,
          aborted: true,
        };
      }
    }

    return {
      contextId: context.id,
      marker,
      readConsistent: readBeforeAwait === marker && readAfterAwait === marker,
      belongsToCurrentRequest,
      continuationIds,
    };
  }

  @Get(RELEASE_GATES_ROUTE)
  public releaseGates(@Query('id') id?: string) {
    if (id) {
      this.records.releaseGate(id);
    } else {
      this.records.releaseAllGates();
    }
    return { released: true };
  }

  @Get(HEALTH_ROUTE)
  public health() {
    // Exercised after a failing continuation: the application stays
    // serviceable, only the failing continuation's record is affected.
    return { status: 'ok', singletonId: this.singletonProbe.id };
  }
}

function clampRegistrations(registrations: string | undefined): number {
  const parsed = Number.parseInt(registrations ?? '1', 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return 1;
  }
  return Math.min(parsed, 10);
}

function parseOptionalIndex(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Resolves `true` when the underlying request socket closes before `ms`
 * elapses (client aborted), `false` on a normal timeout. Works with the
 * Express request (an `IncomingMessage`) and the Fastify request wrapper
 * (which exposes the raw message as `raw`).
 */
function waitForCompletionOrAbort(
  request: unknown,
  ms: number,
): Promise<boolean> {
  const rawRequest = (request as { raw?: unknown })?.raw ?? request;
  return new Promise<boolean>(resolve => {
    let settled = false;
    const onClose = () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      (rawRequest as { removeListener?: Function }).removeListener?.(
        'close',
        onClose,
      );
      resolve(false);
    }, ms);
    (rawRequest as { once?: Function }).once?.('close', onClose);
  });
}
