import { Module } from '@nestjs/common';
import { ProbeBusinessModule } from './business/probe-business.module.js';
import { ProbeLifecycleService } from './probe-lifecycle.service.js';
import { RequestContextService } from './request-context.service.js';
import { ScopeProbeController } from './scope-probe.controller.js';
import { SingletonProbeService } from './singleton-probe.service.js';
import { TransientConsumerService } from './transient-consumer.service.js';
import { TransientProbeService } from './transient-probe.service.js';

@Module({
  imports: [ProbeBusinessModule],
  controllers: [ScopeProbeController],
  providers: [
    ProbeLifecycleService,
    RequestContextService,
    TransientProbeService,
    TransientConsumerService,
    SingletonProbeService,
  ],
})
export class ScopeProbeModule {}
