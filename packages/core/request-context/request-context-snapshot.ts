import { randomUUID } from 'crypto';

/**
 * Describes why a request context was terminated.
 *
 * - `finish` - the response was sent to completion (normal response or an
 *   error response produced by an exception filter).
 * - `abort`  - the request was aborted by the client before it completed.
 */
export type RequestContextTerminationReason = 'finish' | 'abort';

/**
 * Lifecycle state of a single post-response callback registered with
 * {@link RequestContextSnapshot.registerAfterTerminated}.
 *
 * - `pending`   - the owning context has been terminated and the callback is
 *                 waiting to run, or the context has not been terminated yet.
 * - `running`   - the callback invocation has started.
 * - `completed` - the callback (including a returned promise) resolved.
 * - `failed`    - the callback threw or rejected; the error was captured and
 *                 never propagated to other requests.
 */
export type RequestContextCallbackState =
  'pending' | 'running' | 'completed' | 'failed';

/**
 * Callback executed after the owning request context has been terminated. It
 * receives the frozen snapshot, so it never needs access to the underlying
 * request/response objects (which may already have been garbage-collected).
 */
export type AfterTerminatedCallback = (
  snapshot: RequestContextSnapshot,
) => void | Promise<void>;

interface CallbackEntry {
  id: string;
  state: RequestContextCallbackState;
  error?: unknown;
  callback: AfterTerminatedCallback;
}

/**
 * Reusable, per-request snapshot of request metadata.
 *
 * Consumers within the same request share one snapshot and may write metadata
 * into it until the request terminates. At termination the snapshot is
 * frozen: all subsequent writes are ignored and every registered callback is
 * invoked exactly once, receiving the immutable contents. Callbacks can still
 * be registered after termination (e.g. during shutdown) and will receive the
 * same frozen values.
 *
 * The snapshot intentionally holds no references to the platform request or
 * response objects: values must be copied out of them before termination so
 * post-response work remains safe after those objects are recycled.
 *
 * @publicApi
 */
export class RequestContextSnapshot {
  /**
   * Unique identifier of this snapshot, also used to correlate records
   * produced by post-response callbacks.
   */
  public readonly id = randomUUID();

  /**
   * Mutable metadata store, replaced by a frozen copy on termination. Never
   * expose the map itself; all access goes through the accessors below.
   */
  private data: ReadonlyMap<string, unknown> | Map<string, unknown> = new Map();

  private readonly callbacks: CallbackEntry[] = [];
  private frozen = false;
  private terminatedAt: Date | null = null;
  private terminationReason: RequestContextTerminationReason | null = null;
  private terminationCount = 0;

  private frozenWaiters: Array<() => void> = [];
  private readonly settledWaiters: Array<() => void> = [];

  /**
   * Listeners notified when the set of in-flight (not yet settled) callbacks
   * transitions to non-empty or back to empty. Used by `RequestContextHost`
   * to track only snapshots that still have work pending.
   */
  private readonly pendingListeners = new Set<(pending: boolean) => void>();

  private hasInFlightCallbacks(): boolean {
    return this.callbacks.some(
      entry => entry.state !== 'completed' && entry.state !== 'failed',
    );
  }

  /**
   * Reports whether at least one registered callback is still waiting to
   * run or currently running (`pending`/`running`).
   */
  public hasPendingCallbacks(): boolean {
    return this.hasInFlightCallbacks();
  }

  /**
   * Subscribes to in-flight callback transitions: invoked with `true` when
   * work becomes pending and `false` once every callback has settled. A
   * callback registered after a previous settlement re-triggers `true`.
   */
  public addPendingStateListener(listener: (pending: boolean) => void): void {
    this.pendingListeners.add(listener);
  }

  public removePendingStateListener(
    listener: (pending: boolean) => void,
  ): void {
    this.pendingListeners.delete(listener);
  }

  private emitPendingState(): void {
    const pending = this.hasInFlightCallbacks();
    this.pendingListeners.forEach(listener => listener(pending));
  }

  /**
   * Writes a metadata value while the request is still in flight. Writes made
   * before termination are visible to every later reader of the same
   * request, including post-response callbacks. Writes attempted after
   * termination are ignored and return `false`, so late consumers can never
   * mutate frozen contents.
   *
   * @returns `true` when the value was stored, `false` when the snapshot was
   * already frozen.
   */
  public set(key: string, value: unknown): boolean {
    if (this.frozen) {
      return false;
    }
    (this.data as Map<string, unknown>).set(key, value);
    return true;
  }

  /**
   * Reads a metadata value. Reads are consistent before and after freezing;
   * repeated reads from a post-response callback always return the same value.
   */
  public get<T = unknown>(key: string): T | undefined {
    return this.data.get(key) as T | undefined;
  }

  /**
   * Reports whether the snapshot currently contains `key`.
   */
  public has(key: string): boolean {
    return this.data.has(key);
  }

  /**
   * Returns the metadata keys currently visible to readers.
   */
  public keys(): string[] {
    return [...this.data.keys()];
  }

  /**
   * Reports whether the snapshot has been frozen.
   */
  public isFrozen(): boolean {
    return this.frozen;
  }

  /**
   * Reports why the request terminated, or `null` while it is still in flight.
   */
  public getTerminationReason(): RequestContextTerminationReason | null {
    return this.terminationReason;
  }

  /**
   * Returns the time at which the snapshot was frozen, or `null` beforehand.
   */
  public getTerminatedAt(): Date | null {
    return this.terminationAt;
  }

  /**
   * Number of times termination actually took place for this snapshot.
   * Termination is idempotent, so this value is either `0` or `1`.
   */
  public getTerminationCount(): number {
    return this.terminationCount;
  }

  /**
   * Registers a callback to run after the request terminates.
   *
   * Each registration is an independent entry: registering the same callback
   * several times (or callbacks carrying the same marker value) never merges
   * or de-duplicates them. When registered before termination the callback is
   * queued; when registered afterwards it is scheduled immediately. Every
   * callback runs at most once and a failing callback is captured as a
   * `failed` entry without affecting the others.
   *
   * @returns The identifier of the callback entry.
   */
  public registerAfterTerminated(callback: AfterTerminatedCallback): string {
    const entry: CallbackEntry = {
      id: randomUUID(),
      state: 'pending',
      callback,
    };
    this.callbacks.push(entry);

    if (this.frozen) {
      // A fresh registration on an already-settled snapshot makes work
      // pending again before the new callback is scheduled.
      this.emitPendingState();
      this.scheduleCallback(entry);
    }
    return entry.id;
  }
  /**
   * Snapshot of the callback-lifecycle states, keyed by callback id. Useful
   * for probes that need to report progress without exposing internals.
   */
  public getCallbackStates(): Record<string, RequestContextCallbackState> {
    return Object.fromEntries(
      this.callbacks.map(entry => [entry.id, entry.state]),
    );
  }

  /**
   * Read-only view of every registered callback entry. Each entry is reported
   * exactly once; entries are never removed even after completion.
   */
  public getCallbackRecords(): Array<{
    id: string;
    state: RequestContextCallbackState;
    error?: unknown;
  }> {
    return this.callbacks.map(({ id, state, error }) => ({
      id,
      state,
      ...(error === undefined ? {} : { error }),
    }));
  }

  /**
   * Resolves once the snapshot has been frozen.
   */
  public whenFrozen(): Promise<void> {
    if (this.frozen) {
      return Promise.resolve();
    }
    return new Promise<void>(resolve => this.frozenWaiters.push(resolve));
  }

  /**
   * Resolves once every registered callback has settled (completed or
   * failed). Callbacks registered after this resolves settle independently;
   * during shutdown this is awaited only after the registration window has
   * effectively closed.
   */
  public whenAllCallbacksSettled(): Promise<void> {
    if (this.areAllCallbacksSettled()) {
      return Promise.resolve();
    }
    return new Promise<void>(resolve => this.settledWaiters.push(resolve));
  }

  private areAllCallbacksSettled(): boolean {
    return this.callbacks.every(
      entry => entry.state === 'completed' || entry.state === 'failed',
    );
  }

  /**
   * Freezes the snapshot and schedules the registered callbacks. Idempotent:
   * duplicate invocations (finish and close racing, framework quirks,
   * shutdown) do not increment the termination count, re-freeze the data or
   * run any callback twice.
   */
  public terminate(reason: RequestContextTerminationReason): void {
    if (this.frozen) {
      return;
    }

    this.terminationCount++;
    this.terminationReason = reason;
    this.terminatedAt = new Date();

    // Copy the current metadata into a frozen map: the old map is never read
    // again, and dropped `set` calls cannot mutate the frozen copy. The map is
    // shallowly immutable; nested values remain application-owned data.
    this.data = Object.freeze(
      new Map<string, unknown>(this.data as Map<string, unknown>),
    );
    this.frozen = true;

    const waiters = this.frozenWaiters;
    this.frozenWaiters = [];
    waiters.forEach(resolve => resolve());

    for (const entry of this.callbacks) {
      this.scheduleCallback(entry);
    }
    // Recompute in-flight state after scheduling: snapshots without
    // callbacks settle immediately and can be released by their host.
    this.emitPendingState();
  }

  /**
   * Schedules one callback on the next phase of the event loop, ensuring the
   * response has fully finished (including the framework `close` event)
   * before post-response work starts. Errors are captured per callback.
   */
  private scheduleCallback(entry: CallbackEntry): void {
    if (entry.state !== 'pending') {
      return;
    }
    entry.state = 'running';
    setImmediate(() => {
      let result: unknown;
      try {
        result = entry.callback(this);
      } catch (error) {
        entry.state = 'failed';
        entry.error = error;
        this.onCallbackSettled();
        return;
      }
      if (isPromiseLike(result)) {
        Promise.resolve(result).then(
          () => {
            entry.state = 'completed';
            this.onCallbackSettled();
          },
          error => {
            entry.state = 'failed';
            entry.error = error;
            this.onCallbackSettled();
          },
        );
      } else {
        entry.state = 'completed';
        this.onCallbackSettled();
      }
    });
  }

  private onCallbackSettled(): void {
    if (this.areAllCallbacksSettled()) {
      const waiters = this.settledWaiters.splice(0);
      waiters.forEach(resolve => resolve());
    }
    this.emitPendingState();
  }
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    !!value &&
    (typeof value === 'object' || typeof value === 'function') &&
    typeof (value as PromiseLike<unknown>).then === 'function'
  );
}
