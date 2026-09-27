import { Injectable, OnModuleDestroy } from '@nestjs/common';

/**
 * Lifecycle of a single probe registration, as observed through
 * `/context-records`:
 *
 * - `active`    - the request has not terminated yet (snapshot still mutable).
 * - `frozen`    - the request terminated (snapshot frozen) but the callback
 *                 has not produced its result yet.
 * - `completed` - the callback finished reading the frozen snapshot.
 * - `failed`    - the callback failed; the error message was captured.
 */
export type ProbeRecordStatus = 'active' | 'frozen' | 'completed' | 'failed';

export interface ProbeRecord {
  contextId: string;
  callbackId: string;
  marker: string;
  status: ProbeRecordStatus;
  terminationReason: 'finish' | 'abort' | null;
  terminationCount: number | null;
  consumerValue: string | null;
  frozenMarker: string | null;
  lateWriteAccepted: boolean | null;
  lateWriteVisible: boolean | null;
  repeatedReadsConsistent: boolean | null;
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
 * Application-scoped, in-memory store of probe records. It is a regular
 * singleton provider, so every bootstrapped application gets an independent
 * store: recreating the application can never replay or inherit records.
 */
@Injectable()
export class ContextRecordsStore implements OnModuleDestroy {
  private readonly records = new Map<string, ProbeRecord>();
  private readonly order: string[] = [];
  private readonly gates = new Map<string, Gate>();

  public register(
    contextId: string,
    callbackId: string,
    marker: string,
  ): ProbeRecord {
    const record: ProbeRecord = {
      contextId,
      callbackId,
      marker,
      status: 'active',
      terminationReason: null,
      terminationCount: null,
      consumerValue: null,
      frozenMarker: null,
      lateWriteAccepted: null,
      lateWriteVisible: null,
      repeatedReadsConsistent: null,
      errorMessage: null,
      // Tie-break so insertion ordering is total even within one tick.
      registeredAt: Date.now() + this.order.length / 1000,
    };
    this.records.set(callbackId, record);
    this.order.push(callbackId);
    this.gates.set(callbackId, createGate());
    return record;
  }

  public markFrozen(
    callbackId: string,
    snapshot: {
      getTerminationReason(): ProbeRecord['terminationReason'];
      getTerminationCount(): number;
    },
  ): void {
    const record = this.records.get(callbackId);
    if (record && record.status === 'active') {
      record.status = 'frozen';
      record.terminationReason = snapshot.getTerminationReason();
      record.terminationCount = snapshot.getTerminationCount();
    }
  }

  public markCompleted(
    callbackId: string,
    payload: Pick<
      ProbeRecord,
      | 'terminationReason'
      | 'terminationCount'
      | 'consumerValue'
      | 'frozenMarker'
      | 'lateWriteAccepted'
      | 'lateWriteVisible'
      | 'repeatedReadsConsistent'
    >,
  ): void {
    const record = this.records.get(callbackId);
    if (!record) {
      return;
    }
    Object.assign(record, payload, { status: 'completed' as const });
  }

  public markFailed(callbackId: string, error: unknown): void {
    const record = this.records.get(callbackId);
    if (!record) {
      return;
    }
    record.status = 'failed';
    record.errorMessage =
      error instanceof Error ? error.message : String(error);
  }

  public waitForGate(callbackId: string): Promise<void> {
    return this.gates.get(callbackId)?.promise ?? Promise.resolve();
  }

  public releaseGate(callbackId: string): void {
    this.gates.get(callbackId)?.release();
  }

  public releaseAllGates(): void {
    this.gates.forEach(gate => gate.release());
  }

  /**
   * Safety net for shutdown: never let a parked gate delay application
   * close. Runs before the HTTP adapter is disposed, so the request-context
   * shutdown drain that follows can await the now-unblocked callbacks.
   */
  public onModuleDestroy(): void {
    this.releaseAllGates();
  }

  public getAll(): ProbeRecord[] {
    return this.order.map(id => this.records.get(id)!);
  }
}
