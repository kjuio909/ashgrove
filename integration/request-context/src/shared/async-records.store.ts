import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { randomUUID } from 'crypto';

/**
 * Lifecycle of a single post-response continuation, as observed through
 * `/async-records`:
 *
 * - `pending`   - the continuation was registered and has not produced its
 *                 result yet (either the request is still in flight or the
 *                 continuation is parked behind its gate).
 * - `completed` - the continuation read the frozen snapshot successfully.
 * - `failed`    - the continuation threw or rejected; the error was captured.
 *
 * A settled record is reported forever as `completed`/`failed`: it can never
 * go back to `pending`.
 */
export type ContinuationStatus = 'pending' | 'completed' | 'failed';

export interface ContinuationRecord {
  id: string;
  contextId: string;
  marker: string;
  status: ContinuationStatus;
  frozenValue: string | null;
  frozenValueStable: boolean | null;
  lateWriteAccepted: boolean | null;
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
 * Application-scoped, in-memory store of continuation records. It is a
 * regular singleton provider, so every bootstrapped application gets an
 * independent store: recreating the application can never replay or inherit
 * records, and two applications coexisting in one process cannot see each
 * other's data.
 */
@Injectable()
export class AsyncRecordsStore implements OnModuleDestroy {
  private readonly records = new Map<string, ContinuationRecord>();
  private readonly order: string[] = [];
  private readonly gates = new Map<string, Gate>();

  /**
   * Opens a record for a continuation that was just registered. The record
   * starts as `pending`. Every continuation gets its own record - even
   * continuations carrying identical markers or running in the same request.
   */
  public register(contextId: string, marker: string): string {
    const id = randomUUID();
    const record: ContinuationRecord = {
      id,
      contextId,
      marker,
      status: 'pending',
      frozenValue: null,
      frozenValueStable: null,
      lateWriteAccepted: null,
      errorMessage: null,
      // Tie-break so insertion ordering is total even within one tick.
      registeredAt: Date.now() + this.order.length / 1000,
    };
    this.records.set(id, record);
    this.order.push(id);
    this.gates.set(id, createGate());
    return id;
  }

  /**
   * Parks the continuation until a test releases its gate (or shutdown
   * releases every gate). This makes the `pending` state deterministic to
   * observe from `/async-records`.
   */
  public waitForGate(id: string): Promise<void> {
    return this.gates.get(id)?.promise ?? Promise.resolve();
  }

  public releaseGate(id: string): void {
    this.gates.get(id)?.release();
  }

  public releaseAllGates(): void {
    this.gates.forEach(gate => gate.release());
  }

  public markCompleted(
    id: string,
    payload: Pick<ContinuationRecord, 'frozenValue' | 'frozenValueStable'> & {
      lateWriteAccepted: boolean;
    },
  ): void {
    const record = this.records.get(id);
    if (!record || record.status !== 'pending') {
      // A settled record is immutable: a late settlement can never rewrite a
      // completed or failed record.
      return;
    }
    Object.assign(record, payload, { status: 'completed' as const });
  }

  public markFailed(id: string, error: unknown): void {
    const record = this.records.get(id);
    if (!record || record.status !== 'pending') {
      return;
    }
    record.status = 'failed';
    record.errorMessage =
      error instanceof Error ? error.message : String(error);
  }

  /**
   * Safety net for shutdown: never let a parked gate delay application close.
   * Runs before the request-context shutdown drain that awaits the now
   * unblocked continuations.
   */
  public onModuleDestroy(): void {
    this.releaseAllGates();
  }

  public getAll(): ContinuationRecord[] {
    return this.order.map(id => this.records.get(id)!);
  }
}
