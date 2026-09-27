import { Module, OnModuleInit } from '@nestjs/common';
import { APP_FILTER, RequestContextModule } from '@nestjs/core';
import { AsyncContextController } from '../../src/async-context.controller.js';
import { AsyncRecordsStore } from '../../src/async-records.store.js';
import { ContextEchoController } from '../../src/context-echo.controller.js';
import { FilteredProbeExceptionFilter } from '../../src/filtered-probe.filter.js';
import { ProbeIdentityService } from '../../src/probe-identity.service.js';

/**
 * Provider whose lifecycle hook always fails. Combined with
 * `abortOnError: false` (so the factory rejects instead of aborting the
 * process), it exercises the requirement that an initialization failure
 * never leaves a half-initialized, servable application.
 */
export class FailingInitService implements OnModuleInit {
  public onModuleInit(): never {
    throw new Error('intentional initialization failure');
  }
}

@Module({
  imports: [RequestContextModule.forRoot()],
  controllers: [AsyncContextController, ContextEchoController],
  providers: [
    AsyncRecordsStore,
    ProbeIdentityService,
    FailingInitService,
    {
      provide: APP_FILTER,
      useClass: FilteredProbeExceptionFilter,
    },
  ],
})
export class FailingInitModule {}
