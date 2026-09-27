import { Injectable, OnModuleDestroy } from '@nestjs/common';
import {
  ProbeCleanupStore,
  TrackedProbeResource,
} from './probe-cleanup-store.js';

/**
 * Application-level (singleton) probe resource. One instance per
 * application; its identity stays stable for the whole application lifetime
 * and changes when a new application is created.
 */
@Injectable()
export class SingletonProbeService
  extends TrackedProbeResource
  implements OnModuleDestroy
{
  readonly id = ProbeCleanupStore.nextSingletonId();

  constructor() {
    super('singleton');
  }

  onModuleDestroy(): void {
    this.dispose();
  }
}
