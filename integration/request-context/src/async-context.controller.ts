import {
  BadRequestException,
  Controller,
  Get,
  Optional,
  Query,
  Req,
} from '@nestjs/common';
import {
  RequestContext,
  RequestContextHost,
  type RequestContextSnapshot,
} from '@nestjs/core';
import { AsyncRecordsStore } from './async-records.store.js';
import { FilteredProbeError } from './filtered-probe.error.js';
import { ProbeIdentityService } from './probe-identity.service.js';

/**
 * Probe controller backing the request-context integration tests.
 *
 * The very same controller class is registered in two applications:
 *
 * - the context-enabled application (imports `RequestContextModule.forRoot()`),
 *   where `RequestContextHost` is injectable and every request carries a
 *   snapshot;
 * - the plain control application (does not import the module), where the host
 *   is absent and the optional snapshot is `undefined`. In that mode the route
 *   keeps working and simply reports `contextEnabled: false`, proving the
 *   feature is opt-in and existing behavior is untouched.
 *
 * Context-enabled endpoints:
 *
 * - `GET /async-context?marker=文本` writes the marker into the request
 *   snapshot, reads it back across an async wait and responds with the context
 *   id, the marker, whether the reads stayed consistent and whether the
 *   continuation still belongs to the current request. It also registers one
 *   or more post-response continuations, each forming an independent record on
 *   `/async-records`.
 * - `GET /async-records` provides the independent read-back of every
 *   continuation (pending / completed / failed).
 * - `GET /release-gates` is test-only infrastructure: continuations park
 *   behind per-record gates until released (or until shutdown releases all).
 */
@Controller()
export class AsyncContextController {
  constructor(
    private readonly records: AsyncRecordsStore,
    private readonly identity: ProbeIdentityService,
    @Optional() private readonly contextHost?: RequestContextHost,
  ) {}

  @Get('async-context')
  public async probe(
    @Query('marker') marker: string | undefined,
    @Query('consumerValue') consumerValue: string | undefined,
    @Query('delayMs') delayMs: string | undefined,
    @Query('fail') fail: string | undefined,
    @Query('registrations') registrations: string | undefined,
    @Query('failContinuationIndex') failContinuationIndex: string | undefined,
    @RequestContext() context: RequestContextSnapshot | undefined,
    @Req() request: any,
  ): Promise<AsyncContextProbeResponse | ControlProbeResponse> {
    // Every request, in both kinds of applications, is served by the same
    // singleton instance.
    const singletonHit = this.identity.hit();
    const singletonId = this.identity.id;

    if (!this.contextHost || !context) {
      // Control application: the feature is absent and that must be a normal
      // condition, not an error.
      if (fail === 'filtered') {
        if (typeof marker === 'string') {
          throw new FilteredProbeError(marker);
        }
      }
      if (fail === 'request') {
        throw new BadRequestException('intentional controller failure');
      }
      return {
        contextEnabled: false,
        appId: this.records.appId,
        singletonId,
        singletonHit,
        marker: marker ?? null,
      };
    }

    if (typeof marker !== 'string' || marker.length === 0) {
      throw new BadRequestException('marker query parameter is required');
    }

    // 1. Write the marker, then cross an async wait and read the snapshot
    //    again: request-scoped state must survive the continuation and the
    //    async-local context must still resolve to this very request.
    context.set('marker', marker);
    const readBefore = context.get<string>('marker');
    await Promise.resolve();
    await new Promise(resolve => setImmediate(resolve));
    const readAfter = context.get<string>('marker');
    const stillCurrentRequest = this.contextHost.current()?.id === context.id;

    const count = clampRegistrations(registrations);
    const recordIds: string[] = [];
    const failingIndex = parseOptionalIndex(failContinuationIndex);

    for (let i = 0; i < count; i++) {
      const registrationIndex = i;
      const recordId = context.registerAfterTerminated(
        async (snapshot: RequestContextSnapshot) => {
          try {
            // The continuation body stays parked until the test releases the
            // gate (or shutdown releases every gate). Meanwhile the record
            // already reports "pending", which is exactly what callers of
            // /async-records must observe before the continuation settles.
            await this.records.waitForGate(recordId);

            if (fail === 'continuation' || failingIndex === registrationIndex) {
              throw new Error(`intentional continuation failure: ${marker}`);
            }

            const firstRead = snapshot.get<string>('marker') ?? null;
            await Promise.resolve();
            await new Promise(resolve => setImmediate(resolve));
            const secondRead = snapshot.get<string>('marker') ?? null;

            // Frozen snapshots reject writes, and rejected writes can never
            // change the read-back value.
            const lateWriteAccepted = snapshot.set('lateWrite', marker);
            const lateWriteVisible = snapshot.has('lateWrite');
            const thirdRead = snapshot.get<string>('marker') ?? null;

            this.records.markCompleted(recordId, {
              consumerValue: snapshot.get<string>('consumerValue') ?? null,
              frozenMarker: firstRead,
              terminationReason: snapshot.getTerminationReason(),
              terminationCount: snapshot.getTerminationCount(),
              lateWriteAccepted,
              lateWriteVisible,
              readsStable:
                firstRead === marker &&
                secondRead === marker &&
                thirdRead === marker,
            });
          } catch (error) {
            // A failing continuation only fails its own record; sibling
            // continuations and other requests are untouched.
            this.records.markFailed(recordId, error);
          }
        },
      );

      // Every registration is an independent record, even for repeated or
      // identical markers across distinct requests.
      this.records.register(context.id, recordId, marker);
      recordIds.push(recordId);
    }

    // A different consumer of the same request writes after the continuations
    // were registered but still before termination: they must observe this
    // value, registration order notwithstanding.
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
        // The raw response 'close' listener owned by RequestContextHost has
        // already terminated the snapshot as 'abort'.
        return {
          contextEnabled: true,
          contextId: context.id,
          appId: this.records.appId,
          singletonId,
          singletonHit,
          marker,
          asyncReadsConsistent: readBefore === readAfter,
          stillCurrentRequest,
          recordIds,
          aborted: true,
        };
      }
    }

    return {
      contextEnabled: true,
      contextId: context.id,
      appId: this.records.appId,
      singletonId,
      singletonHit,
      marker,
      asyncReadsConsistent: readBefore === readAfter && readAfter === marker,
      stillCurrentRequest,
      recordIds,
    };
  }

  @Get('async-records')
  public list() {
    return { appId: this.records.appId, records: this.records.getAll() };
  }

  @Get('release-gates')
  public releaseGates(@Query('recordId') recordId?: string) {
    if (recordId) {
      this.records.releaseGate(recordId);
    } else {
      this.records.releaseAllGates();
    }
    return { released: true };
  }

  @Get('health')
  public health() {
    return { status: 'ok', singletonId: this.identity.id };
  }
}

interface ControlProbeResponse {
  contextEnabled: false;
  appId: string;
  singletonId: string;
  singletonHit: number;
  marker: string | null;
}

interface AsyncContextProbeResponse {
  contextEnabled: true;
  contextId: string;
  appId: string;
  singletonId: string;
  singletonHit: number;
  marker: string;
  asyncReadsConsistent: boolean;
  stillCurrentRequest: boolean;
  recordIds: string[];
  aborted?: boolean;
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
