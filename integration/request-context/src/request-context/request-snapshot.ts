/**
 * Callback executed after the owning request terminated. It only receives the
 * frozen snapshot and must never touch the live request objects, so it stays
 * safe after those objects have been recycled.
 */
export type SnapshotCallback = (
  snapshot: RequestSnapshot,
) => void | Promise<void>;

/** Why a request terminated. */
export type TerminationReason = 'finish' | 'aborted' | 'error';

/**
 * Immutable projection of a request, captured exactly once when the request
 * terminates. Post-response work reads this object instead of the (possibly
 * recycled) request/response pair.
 */
export interface RequestSnapshot {
  /** Stable identifier of the owning request. */
  readonly requestId: string;
  /** Marker supplied by the probe request. */
  readonly marker: string;
  /**
   * Values written by consumers of the same request before termination.
   * Frozen on termination; later writes never reach this object.
   */
  readonly values: Readonly<Record<string, string>>;
  readonly reason: TerminationReason;
  readonly terminatedAt: number;
}

/**
 * Mutable per-request bag that becomes a {@link RequestSnapshot} exactly
 * once. A single instance is created per request, so every consumer of a
 * request shares one host even when marker strings collide across concurrent
 * requests. The host never stores the request/response objects.
 */
export class RequestSnapshotHost {
  private snapshot: RequestSnapshot | null = null;
  private readonly values: Record<string, string> = {};
  private readonly finalizeListeners: Array<
    (snapshot: RequestSnapshot) => void
  > = [];

  constructor(
    readonly requestId: string,
    readonly marker: string,
  ) {}

  get isFrozen(): boolean {
    return this.snapshot !== null;
  }

  /**
   * Writes a value for the owning request. Before termination every consumer
   * sees it; after termination the write is ignored so the frozen snapshot can
   * never change.
   *
   * @returns whether the write was accepted.
   */
  setValue(key: string, value: string): boolean {
    if (this.isFrozen) {
      return false;
    }
    this.values[key] = value;
    return true;
  }

  /**
   * Freezes the snapshot. Safe to invoke repeatedly (`finish`, `close` and
   * `error` can all fire for one request): only the first call terminates and
   * later calls return the same snapshot without touching it.
   *
   * @returns the frozen snapshot and whether this call performed termination.
   */
  finalize(reason: TerminationReason): {
    snapshot: RequestSnapshot;
    performed: boolean;
  } {
    if (this.snapshot) {
      return { snapshot: this.snapshot, performed: false };
    }
    // Shallow-copy and freeze: later writes (or external mutation) can never
    // reach the snapshot.
    this.snapshot = Object.freeze({
      requestId: this.requestId,
      marker: this.marker,
      values: Object.freeze({ ...this.values }),
      reason,
      terminatedAt: Date.now(),
    });
    return { snapshot: this.snapshot, performed: true };
  }

  getSnapshot(): RequestSnapshot | null {
    return this.snapshot;
  }

  /** Defensive copy of the current values, for read-only projections. */
  getValuesCopy(): Record<string, string> {
    return { ...(this.snapshot?.values ?? this.values) };
  }
}
