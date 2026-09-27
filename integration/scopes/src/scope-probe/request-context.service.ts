import { Injectable, Scope } from '@nestjs/common';
import {
  ProbeCleanupStore,
  TrackedProbeResource,
} from './probe-cleanup-store.js';
import { ProbeLifecycleService } from './probe-lifecycle.service.js';

/**
 * Request-scoped probe resource. A new instance (and therefore a new
 * identity) is created for every incoming HTTP request.
 */
@Injectable({ scope: Scope.REQUEST })
export class RequestContextService extends TrackedProbeResource {
  readonly id = ProbeCleanupStore.nextRequestId();

  constructor(lifecycle: ProbeLifecycleService) {
    super('request');
    lifecycle.track(this);
  }
}
