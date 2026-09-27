import { Controller, Get, Query, Scope } from '@nestjs/common';
import { ProbeBusinessService } from './business/probe-business.service.js';
import { ProbeCleanupStore } from './probe-cleanup-store.js';
import { RequestContextService } from './request-context.service.js';
import { SingletonProbeService } from './singleton-probe.service.js';
import { TransientConsumerService } from './transient-consumer.service.js';
import { TransientProbeService } from './transient-probe.service.js';

/**
 * Request-scoped probe controller. Every request gets a fresh controller
 * instance, hence a fresh request-scoped context and fresh transient probes,
 * while the singleton probe is shared for the whole application lifetime.
 */
@Controller({ path: 'scope-probe', scope: Scope.REQUEST })
export class ScopeProbeController {
  constructor(
    private readonly requestContext: RequestContextService,
    private readonly transientProbe: TransientProbeService,
    private readonly singletonProbe: SingletonProbeService,
    private readonly transientConsumer: TransientConsumerService,
    private readonly business: ProbeBusinessService,
  ) {}

  @Get()
  probe(@Query('marker') marker = '') {
    // The same consumer observes the same transient instance every time it
    // reads it; a different consumer receives a distinguishable instance.
    const firstTransientRead = this.transientProbe.id;
    const secondTransientRead = this.transientProbe.id;

    return {
      marker,
      requestId: this.requestContext.id,
      transientId: firstTransientRead,
      singletonId: this.singletonProbe.id,
      sameConsumerTransientEqual: firstTransientRead === secondTransientRead,
      crossConsumerTransientEqual:
        firstTransientRead === this.transientConsumer.transientProbe.id,
      businessValue: this.business.getBusinessValue(marker),
      cleanup: ProbeCleanupStore.snapshot(),
    };
  }
}
