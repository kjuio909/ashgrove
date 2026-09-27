import { Module } from '@nestjs/common';
import { APP_FILTER, RequestContextModule } from '@nestjs/core';
import { AsyncContextController } from '../../src/async-context.controller.js';
import { AsyncRecordsStore } from '../../src/async-records.store.js';
import { ContextEchoController } from '../../src/context-echo.controller.js';
import { FilteredProbeExceptionFilter } from '../../src/filtered-probe.filter.js';
import { ProbeIdentityService } from '../../src/probe-identity.service.js';
import { FeaturePlaceholderModule } from './feature-placeholder.module.js';

/**
 * Same composition as {@link AppModule} but with deliberately different
 * registration order: an unrelated module is imported first and the
 * controllers/providers are listed in reversed order. Behavior must be
 * identical.
 */
@Module({
  imports: [FeaturePlaceholderModule, RequestContextModule.forRoot()],
  controllers: [ContextEchoController, AsyncContextController],
  providers: [
    {
      provide: APP_FILTER,
      useClass: FilteredProbeExceptionFilter,
    },
    ProbeIdentityService,
    AsyncRecordsStore,
  ],
})
export class ReorderedModule {}
