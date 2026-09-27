import { Injectable, Scope } from '@nestjs/common';
import {
  ProbeCleanupStore,
  TrackedProbeResource,
} from './probe-cleanup-store.js';
import { ProbeLifecycleService } from './probe-lifecycle.service.js';

/**
 * Transient probe resource. Every consumer receives its own dedicated
 * instance; a single consumer keeps observing the same instance for as long
 * as it holds it.
 */
@Injectable({ scope: Scope.TRANSIENT })
export class TransientProbeService extends TrackedProbeResource {
  readonly id = ProbeCleanupStore.nextTransientId();

  constructor(lifecycle: ProbeLifecycleService) {
    super('transient');
    lifecycle.track(this);
  }
}
