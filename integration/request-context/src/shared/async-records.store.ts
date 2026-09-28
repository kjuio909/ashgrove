import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { randomUUID } from 'crypto';

/**
 * Lifecycle of a single post-response continuation, as observed through
 * `/async-records`:
 *
 * - `pending`   - the continuation was registered while the request was
 *                 still in flight; the snapshot has not been frozen yet and
 *                 no frozen value is available.
 * - `running`   - the response ended (normally, through an exception filter
 *                 or by a client abort), the snapshot was frozen and the
 *                 continuation has been scheduled; its frozen value was
 *                 captured. The continuation itself has not settled yet.
 * - `completed` - the continuation read the frozen snapshot successfully.
 * - `failed`    - the continuation threw synchronously or rejected
 *                 asynchronously; the error was captured while the frozen
 *                 marker was retained.
 *
 * A settled record (`completed`/`failed`) is reported forever in the same
 * terminal state: it can never go back to `pending`/`running`, never settle
 * twice and never be overwritten by a late callback.
 */
export type ContinuationStatus = 'pending' | 'running' | 'completed' | 'failed';

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
   * releases every gate). This makes the `running` state deterministic to
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

  /**
   * Transitions a record from `pending` to `running` once its snapshot has
   * been frozen, capturing the marker read out of the frozen snapshot. The
   * capture happens independently of the continuation body (which may fail
   * before reading anything), so even a failing continuation keeps its
   * frozen marker. Idempotent: a late notification can never move a settled
   * record backwards.
   */
  public markRunning(id: string, frozenValue: string | null): void {
    const record = this.records.get(id);
    if (!record || record.status !== 'pending') {
      return;
    }
    record.frozenValue = frozenValue;
    record.status = 'running';
  }

  /**
   * Settles a record as `completed`. Allowed from `pending` or `running`;
   * the frozen value captured at freeze time is authoritative and is never
   * overwritten with a different value. A settled record is immutable.
   */
  public markCompleted(
    id: string,
    payload: Pick<ContinuationRecord, 'frozenValue' | 'frozenValueStable'> & {
      lateWriteAccepted: boolean;
    },
  ): void {
    const record = this.records.get(id);
    if (
      !record ||
      record.status === 'completed' ||
      record.status === 'failed'
    ) {
      // A settled record is immutable: a late settlement can never rewrite a
      // completed or failed record.
      return;
    }
    record.frozenValue = record.frozenValue ?? payload.frozenValue;
    record.frozenValueStable = payload.frozenValueStable;
    record.lateWriteAccepted = payload.lateWriteAccepted;
    record.status = 'completed';
  }

  /**
   * Settles a record as `failed`, storing a decidable error message while
   * preserving every previously captured field (marker and frozen value).
   * `frozenFallback` fills the frozen value if the freeze watcher has not
   * reported yet, so the marker is retained regardless of scheduling order.
   * Allowed from `pending` or `running`; terminal and idempotent, so a
   * failing continuation can never double-fail or overwrite a completed
   * sibling record.
   */
  public markFailed(
    id: string,
    error: unknown,
    frozenFallback?: string | null,
  ): void {
    const record = this.records.get(id);
    if (
      !record ||
      record.status === 'completed' ||
      record.status === 'failed'
    ) {
      return;
    }
    if (record.frozenValue === null && frozenFallback !== undefined) {
      record.frozenValue = frozenFallback;
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
