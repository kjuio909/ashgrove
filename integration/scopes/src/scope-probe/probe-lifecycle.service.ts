import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { TrackedProbeResource } from './probe-cleanup-store.js';

/**
 * Application-level (singleton) service that owns the cleanup of every
 * tracked probe resource created while its application is alive.
 *
 * Request- and transient-scoped instances do not receive Nest lifecycle
 * hooks (their dependency trees are non-static), so they register themselves
 * here at construction time and are disposed exactly once when the
 * application shuts down. The hook itself is idempotent, so repeated
 * `close()` calls cannot clean the same resource twice.
 */
@Injectable()
export class ProbeLifecycleService implements OnModuleDestroy {
  private disposed = false;
  private readonly resources = new Set<TrackedProbeResource>();

  track<T extends TrackedProbeResource>(resource: T): T {
    if (!this.disposed) {
      this.resources.add(resource);
    }
    return resource;
  }

  async onModuleDestroy(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const resource of this.resources) {
      resource.dispose();
    }
    this.resources.clear();
  }
}
