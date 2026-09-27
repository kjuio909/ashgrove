import { Injectable } from '@nestjs/common';
import { RequestSnapshot, RequestSnapshotHost } from './request-snapshot.js';
import type { ProbeRecordState } from './request-context.types.js';

/**
 * Symbol under which the per-request {@link RequestSnapshotHost} is attached
 * to the raw request object.
 */
export const REQUEST_SNAPSHOT_HOST = Symbol.for('requestContext.snapshotHost');

/** Options of a callback registration, as requested by the probe. */
export interface RegistrationOptions {
  marker: string;
  /** Defer the callback by that many milliseconds after termination. */
  delayMs: number;
  /** When true the callback fails on purpose. */
  shouldFail: boolean;
}

/** Read-only projection returned by `/context-records`. */
export interface ProbeRecordView {
  id: string;
  requestId: string;
  marker: string;
  state: ProbeRecordState;
  reason: RequestSnapshot['reason'] | null;
  /** Terminations that were actually performed (must stay 1). */
  finalizations: number;
  /** Termination events received, including duplicate ones. */
  finalizeAttempts: number;
  /** Callback executions (must stay 1). */
  callbackRuns: number;
  /** Snapshot values visible right now (live bag before freezing). */
  values: Record<string, string>;
  /** A write attempted after freezing must have been rejected. */
  lateWriteRejected: boolean | null;
  callbackFirstRead: CallbackRead | null;
  callbackSecondRead: CallbackRead | null;
  callbackReadsConsistent: boolean;
  callbackError: string | null;
}

interface CallbackRead {
  marker: string;
  consumer: string | undefined;
  interceptor: string | undefined;
  reason: RequestSnapshot['reason'];
}

const LATE_WRITE_KEY = '__postFreezeWrite__';

interface ProbeRecordEntry {
  seq: number;
  id: string;
  host: RequestSnapshotHost;
  marker: string;
  state: ProbeRecordState;
  reason: RequestSnapshot['reason'] | null;
  finalizations: number;
  finalizeAttempts: number;
  callbackRuns: number;
  lateWriteRejected: boolean | null;
  firstRead: CallbackRead | null;
  secondRead: CallbackRead | null;
  callbackError: string | null;
  delayMs: number;
  shouldFail: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  runPromise: Promise<void> | null;
}

/**
 * Application-scoped registry of probe registrations.
 *
 * A fresh instance is created for every Nest application, so records never
 * leak across application lifetimes: recreating the app starts a new, empty
 * generation. The registry never holds request/response objects, only frozen
 * snapshots, so reads remain safe after those objects are recycled.
 */
@Injectable()
export class RequestContextRegistry {
  private requestSeq = 0;
  private registrationSeq = 0;
  private readonly openHosts = new Set<RequestSnapshotHost>();
  private readonly entries = new Set<ProbeRecordEntry>();
  private shuttingDown = false;

  /**
   * Creates the per-request host and wires termination. `finish`, `close` and
   * `error` can all fire for a single response; finalization itself is
   * idempotent in the host.
   */
  attach(req: any, res: any): RequestSnapshotHost {
    const marker = String(req.query?.marker ?? '');
    const host = new RequestSnapshotHost(
      `request-${++this.requestSeq}`,
      marker,
    );
    this.openHosts.add(host);
    req[REQUEST_SNAPSHOT_HOST] = host;

    res.once('finish', () => this.handleTermination(host, 'finish'));
    // `close` always follows `finish` on a normal response and fires alone
    // when the client aborts. Both paths attempt finalization.
    res.once('close', () =>
      this.handleTermination(host, res.writableEnded ? 'finish' : 'aborted'),
    );
    res.once('error', () => this.handleTermination(host, 'error'));
    return host;
  }

  getHost(req: any): RequestSnapshotHost | undefined {
    return req[REQUEST_SNAPSHOT_HOST];
  }

  /**
   * Registers a post-response callback. Each call creates an independent
   * record; equal markers never merge because the record is tied to the
   * per-request host, not to the marker string.
   */
  register(
    host: RequestSnapshotHost,
    options: RegistrationOptions,
  ): ProbeRecordEntry {
    const entry: ProbeRecordEntry = {
      seq: ++this.registrationSeq,
      id: `registration-${this.registrationSeq}`,
      host,
      marker: options.marker,
      state: 'open',
      reason: null,
      finalizations: 0,
      finalizeAttempts: 0,
      callbackRuns: 0,
      lateWriteRejected: null,
      firstRead: null,
      secondRead: null,
      callbackError: null,
      delayMs: options.delayMs,
      shouldFail: options.shouldFail,
      timer: null,
      runPromise: null,
    };
    this.entries.add(entry);

    // Registration racing termination: run as soon as frozen.
    if (host.isFrozen) {
      this.markFrozen(entry, host.getSnapshot()!.reason);
      this.scheduleCallback(entry);
    }
    return entry;
  }

  private handleTermination(
    host: RequestSnapshotHost,
    reason: RequestSnapshot['reason'],
  ): void {
    const { snapshot, performed } = host.finalize(reason);
    if (performed) {
      this.openHosts.delete(host);
    }
    for (const entry of this.entries) {
      if (entry.host !== host) {
        continue;
      }
      entry.finalizeAttempts++;
      if (performed) {
        this.markFrozen(entry, snapshot.reason);
        // Another consumer writing just a moment too late: the frozen
        // snapshot must not change.
        entry.lateWriteRejected = !host.setValue(LATE_WRITE_KEY, 'late');
        this.scheduleCallback(entry);
      }
    }
  }

  private markFrozen(
    entry: ProbeRecordEntry,
    reason: RequestSnapshot['reason'],
  ): void {
    if (entry.state === 'open') {
      entry.state = 'frozen';
      entry.reason = reason;
      entry.finalizations = 1;
    }
  }

  private scheduleCallback(entry: ProbeRecordEntry): void {
    if (entry.runPromise || this.shuttingDown) {
      // Shutdown is imminent; the shutdown flush runs every pending
      // callback against its frozen snapshot.
      return;
    }
    entry.timer = setTimeout(() => void this.runCallback(entry), entry.delayMs);
  }

  /**
   * Runs the registered callback exactly once. Both the deferred timer and
   * the shutdown flush await the same promise, so the callback can never run
   * twice. Failures are captured on the record; they never reject and
   * therefore cannot affect other requests' records.
   */
  runCallback(entry: ProbeRecordEntry): Promise<void> {
    entry.runPromise ??= (async () => {
      if (entry.timer) {
        clearTimeout(entry.timer);
        entry.timer = null;
      }
      try {
        entry.callbackRuns++;
        const snapshot = entry.host.getSnapshot()!;
        // Deferred, request-object-free work: reads happen across turns of
        // the event loop with only the frozen snapshot in scope.
        await new Promise(resolve => setImmediate(resolve));
        entry.firstRead = this.read(snapshot);
        await new Promise(resolve => setImmediate(resolve));
        entry.secondRead = this.read(snapshot);
        if (entry.shouldFail) {
          throw new Error(`intentional callback failure: ${entry.marker}`);
        }
      } catch (err) {
        entry.callbackError = err instanceof Error ? err.message : String(err);
      } finally {
        // A failed callback still ran to completion; it simply carries its
        // error on the record without disturbing anyone else's.
        entry.state = 'completed';
      }
    })();
    return entry.runPromise;
  }

  private read(snapshot: RequestSnapshot): CallbackRead {
    return {
      marker: snapshot.marker,
      consumer: snapshot.values.consumer,
      interceptor: snapshot.values.interceptor,
      reason: snapshot.reason,
    };
  }

  /**
   * Shutdown barrier, invoked from `OnApplicationShutdown` (after the HTTP
   * server stopped accepting connections). Requests killed by the closing
   * server finalize through their listeners first; anything still open is
   * finalized here, and every callback that had not run yet reads its frozen
   * values. Old records are neither dropped nor replayed.
   */
  async flushOnShutdown(): Promise<void> {
    this.shuttingDown = true;
    for (const host of [...this.openHosts]) {
      this.handleTermination(host, 'aborted');
    }
    const pending = [...this.entries].filter(
      entry => entry.state !== 'completed',
    );
    await Promise.all(pending.map(entry => this.runCallback(entry)));
  }

  list(): ProbeRecordView[] {
    return [...this.entries]
      .sort((a, b) => a.seq - b.seq)
      .map(entry => this.toView(entry));
  }

  private toView(entry: ProbeRecordEntry): ProbeRecordView {
    return {
      id: entry.id,
      requestId: entry.host.requestId,
      marker: entry.marker,
      state: entry.state,
      reason: entry.reason,
      finalizations: entry.finalizations,
      finalizeAttempts: entry.finalizeAttempts,
      callbackRuns: entry.callbackRuns,
      values: entry.host.getValuesCopy(),
      lateWriteRejected: entry.lateWriteRejected,
      callbackFirstRead: entry.firstRead,
      callbackSecondRead: entry.secondRead,
      callbackReadsConsistent:
        entry.firstRead !== null &&
        entry.secondRead !== null &&
        JSON.stringify(entry.firstRead) === JSON.stringify(entry.secondRead),
      callbackError: entry.callbackError,
    };
  }
}
