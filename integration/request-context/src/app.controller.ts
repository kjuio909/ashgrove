import {
  BadRequestException,
  Controller,
  Get,
  Query,
  Req,
} from '@nestjs/common';
import { RequestContext, type RequestContextSnapshot } from '@nestjs/core';
import { ContextRecordsStore } from './context-records.store.js';
import { FilteredProbeError } from './filtered-probe.error.js';

/**
 * Probe controller backing the request-context snapshot integration tests.
 *
 * - `GET /context-probe?marker=...` stores the marker in the request
 *   snapshot, registers one or more post-response callbacks (each parked
 *   behind a per-registration gate until tests release it) and completes the
 *   response.
 * - `GET /context-records` reads back every registration with its current
 *   lifecycle state.
 * - `GET /release-gates[?callbackId=...]` releases pending callback gates.
 */
@Controller()
export class AppController {
  constructor(private readonly records: ContextRecordsStore) {}

  @Get('context-probe')
  public async probe(
    @Query('marker') marker: string | undefined,
    @Query('consumerValue') consumerValue: string | undefined,
    @Query('delayMs') delayMs: string | undefined,
    @Query('fail') fail: string | undefined,
    @Query('registrations') registrations: string | undefined,
    @Query('failCallbackIndex') failCallbackIndex: string | undefined,
    @RequestContext() context: RequestContextSnapshot | undefined,
    @Req() request: any,
  ): Promise<{
    contextId: string;
    callbackIds: string[];
    aborted?: boolean;
  }> {
    if (!context) {
      throw new Error('Request context snapshot was not attached');
    }
    if (typeof marker !== 'string' || marker.length === 0) {
      throw new BadRequestException('marker query parameter is required');
    }

    // Metadata extracted at the beginning of the request.
    context.set('marker', marker);

    const count = clampRegistrations(registrations);
    const callbackIds: string[] = [];
    const failingIndex = parseOptionalIndex(failCallbackIndex);

    for (let i = 0; i < count; i++) {
      const registrationIndex = i;
      const callbackId = context.registerAfterTerminated(
        async (snapshot: RequestContextSnapshot) => {
          try {
            // The callback body stays parked until the test releases the
            // gate (or shutdown releases every gate). Meanwhile the record
            // already reports "frozen", so the probe can distinguish
            // "terminated, callback waiting" from "callback completed".
            await this.records.waitForGate(callbackId);

            if (fail === 'callback' || failingIndex === registrationIndex) {
              throw new Error(`intentional callback failure: ${marker}`);
            }

            const firstRead = snapshot.get<string>('marker') ?? null;
            await Promise.resolve();
            const secondRead = snapshot.get<string>('marker') ?? null;

            const lateWriteAccepted = snapshot.set('lateWrite', marker);
            const lateWriteVisible = snapshot.has('lateWrite');
            const thirdRead = snapshot.get<string>('marker') ?? null;

            this.records.markCompleted(callbackId, {
              terminationReason: snapshot.getTerminationReason(),
              terminationCount: snapshot.getTerminationCount(),
              consumerValue: snapshot.get<string>('consumerValue') ?? null,
              frozenMarker: firstRead,
              lateWriteAccepted,
              lateWriteVisible,
              repeatedReadsConsistent:
                firstRead === marker &&
                secondRead === marker &&
                thirdRead === marker,
            });
          } catch (error) {
            // A failing callback only fails its own record; other callbacks
            // and other requests are untouched.
            this.records.markFailed(callbackId, error);
          }
        },
      );

      // Every registration is an independent record, even for repeated or
      // identical markers.
      this.records.register(context.id, callbackId, marker);
      // Freeze observer (a microtask once terminate resolves waiters) runs
      // before the callback, which is scheduled with setImmediate.
      void context.whenFrozen().then(() => {
        this.records.markFrozen(callbackId, context);
      });
      callbackIds.push(callbackId);
    }

    // A different consumer of the same request writes after the callbacks
    // were registered but still before termination: callbacks must observe
    // this value, registration order notwithstanding.
    if (consumerValue !== undefined) {
      context.set('consumerValue', consumerValue);
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
        // The client went away; the raw response 'close' listener owned by
        // RequestContextHost has already terminated the snapshot as 'abort'.
        return { contextId: context.id, callbackIds, aborted: true };
      }
    }

    return { contextId: context.id, callbackIds };
  }

  @Get('context-records')
  public list() {
    return { records: this.records.getAll() };
  }

  @Get('release-gates')
  public releaseGates(@Query('callbackId') callbackId?: string) {
    if (callbackId) {
      this.records.releaseGate(callbackId);
    } else {
      this.records.releaseAllGates();
    }
    return { released: true };
  }

  @Get('health')
  public health() {
    return { status: 'ok' };
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
function waitForCompletionOrAbort(request: any, ms: number): Promise<boolean> {
  const rawRequest = request?.raw ?? request;
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
      rawRequest.removeListener?.('close', onClose);
      resolve(false);
    }, ms);
    rawRequest.once?.('close', onClose);
  });
}
