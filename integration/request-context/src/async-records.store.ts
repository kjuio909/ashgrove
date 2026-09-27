import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { randomUUID } from 'crypto';

/**
 * Lifecycle of a single post-response ("async") continuation, as observed
 * through `/async-records`:
 *
 * - `pending`   - the continuation has not finished yet. This covers both the
 *                 in-flight request (the response may still be streaming) and
 *                 the window after the response terminated while the
 *                 continuation is parked behind its gate.
 * - `completed` - the continuation ran and read the frozen snapshot.
 * - `failed`    - the continuation threw; the error message was captured and
 *                 only this record is affected.
 */
export type ContinuationStatus = 'pending' | 'completed' | 'failed';

export interface ContinuationRecord {
  recordId: string;
  contextId: string;
  appId: string;
  marker: string;
  consumerValue: string | null;
  frozenMarker: string | null;
  status: ContinuationStatus;
  terminationReason: 'finish' | 'abort' | null;
  terminationCount: number | null;
  lateWriteAccepted: boolean | null;
  lateWriteVisible: boolean | null;
  readsStable: boolean | null;
  errorMessage: string | null;
  registeredAt: number;
}

interface Gate {
  promise: Promise<void>;
  release: () => void;
}

function createGate(): Gate {
  let release: () => void = () => {};
  const promise = new Promise<void>(resolve => {
    release = resolve;
  });
  return { promise, release };
}

/**
 * Application-scoped, in-memory store of continuation records.
 *
 * Every bootstrapped Nest application builds its own instance (identified by
 * `appId`), so records can never leak between concurrently running
 * applications or be replayed after an application is recreated. The store is
 * a plain singleton provider: it has no dependency on the request-context
 * module and the control application uses an analogous, always-empty store.
 */
@Injectable()
export class AsyncRecordsStore implements OnModuleDestroy {
  public readonly appId = randomUUID();

  private readonly records = new Map<string, ContinuationRecord>();
  private readonly order: string[] = [];
  private readonly gates = new Map<string, Gate>();

  public register(
    contextId: string,
    recordId: string,
    marker: string,
  ): ContinuationRecord {
    const record: ContinuationRecord = {
      recordId,
      contextId,
      appId: this.appId,
      marker,
      consumerValue: null,
      frozenMarker: null,
      status: 'pending',
      terminationReason: null,
      terminationCount: null,
      lateWriteAccepted: null,
      lateWriteVisible: null,
      readsStable: null,
      errorMessage: null,
      // Tie-break so insertion ordering is total even within one tick.
      registeredAt: Date.now() + this.order.length / 1000,
    };
    this.records.set(recordId, record);
    this.order.push(recordId);
    this.gates.set(recordId, createGate());
    return record;
  }

  public markCompleted(
    recordId: string,
    payload: Pick<
      ContinuationRecord,
      | 'consumerValue'
      | 'frozenMarker'
      | 'terminationReason'
      | 'terminationCount'
      | 'lateWriteAccepted'
      | 'lateWriteVisible'
      | 'readsStable'
    >,
  ): void {
    const record = this.records.get(recordId);
    if (!record || record.status !== 'pending') {
      // A settled record is immutable: late settlements can never rewrite it.
      return;
    }
    Object.assign(record, payload, { status: 'completed' as const });
  }

  public markFailed(recordId: string, error: unknown): void {
    const record = this.records.get(recordId);
    if (!record || record.status !== 'pending') {
      return;
    }
    record.status = 'failed';
    record.errorMessage =
      error instanceof Error ? error.message : String(error);
  }

  public waitForGate(recordId: string): Promise<void> {
    return this.gates.get(recordId)?.promise ?? Promise.resolve();
  }

  public releaseGate(recordId: string): void {
    this.gates.get(recordId)?.release();
  }

  public releaseAllGates(): void {
    this.gates.forEach(gate => gate.release());
  }

  /**
   * Safety net for shutdown: never let a parked gate delay application close.
   * Runs before the HTTP adapter is disposed, so the request-context shutdown
   * drain that follows can await the now-unblocked continuations.
   */
  public onModuleDestroy(): void {
    this.releaseAllGates();
  }

  public getAll(): ContinuationRecord[] {
    return this.order.map(id => this.records.get(id)!);
  }
}
