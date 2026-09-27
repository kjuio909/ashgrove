import { Module } from '@nestjs/common';
import { APP_FILTER, RequestContextModule } from '@nestjs/core';
import { AsyncContextController } from '../../src/async-context.controller.js';
import { AsyncRecordsStore } from '../../src/async-records.store.js';
import { ContextEchoController } from '../../src/context-echo.controller.js';
import { FilteredProbeExceptionFilter } from '../../src/filtered-probe.filter.js';
import { ProbeIdentityService } from '../../src/probe-identity.service.js';

/**
 * Provider whose constructor always fails, exercising initialization failures
 * that happen while `NestFactory.create` is still instantiating dependencies
 * (before any HTTP listener could exist).
 */
export class FailingConstructorService {
  constructor() {
    throw new Error('intentional constructor failure');
  }
}

@Module({
  imports: [RequestContextModule.forRoot()],
  controllers: [AsyncContextController, ContextEchoController],
  providers: [
    AsyncRecordsStore,
    ProbeIdentityService,
    FailingConstructorService,
    {
      provide: APP_FILTER,
      useClass: FilteredProbeExceptionFilter,
    },
  ],
})
export class FailingConstructorModule {}
