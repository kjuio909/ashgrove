/**
 * Process-wide record of probe resource identities and completed cleanups.
 *
 * The store deliberately lives outside the Nest container so that cleanup
 * results accumulated by one application instance remain readable after that
 * application is closed and a new one is created from the same module.
 */
export interface ProbeCleanupCounts {
  request: number;
  transient: number;
  singleton: number;
}

export type ProbeResourceKind = keyof ProbeCleanupCounts;

const completedCleanups: ProbeCleanupCounts = {
  request: 0,
  transient: 0,
  singleton: 0,
};

let requestSeq = 0;
let transientSeq = 0;
let singletonSeq = 0;

export const ProbeCleanupStore = {
  nextRequestId: (): string => `request-${++requestSeq}`,
  nextTransientId: (): string => `transient-${++transientSeq}`,
  nextSingletonId: (): string => `singleton-${++singletonSeq}`,
  recordCleanup(kind: ProbeResourceKind): void {
    completedCleanups[kind]++;
  },
  snapshot(): ProbeCleanupCounts {
    return { ...completedCleanups };
  },
};

/**
 * Base class for probe resources. Cleanup is idempotent per instance:
 * no matter how many times `dispose()` is invoked (repeated `close()`,
 * overlapping request-end/shutdown paths), the resource contributes to the
 * shared cleanup record exactly once.
 */
export abstract class TrackedProbeResource {
  private disposed = false;

  constructor(private readonly kind: ProbeResourceKind) {}

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    ProbeCleanupStore.recordCleanup(this.kind);
  }
}
