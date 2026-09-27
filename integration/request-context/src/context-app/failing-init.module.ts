import { Module } from '@nestjs/common';
import { APP_FILTER, RequestContextModule } from '@nestjs/core';
import { AsyncRecordsController } from '../shared/async-records.controller.js';
import { AsyncRecordsStore } from '../shared/async-records.store.js';
import { ProbeExceptionFilter } from '../shared/probe-exception.filter.js';
import { AsyncContextController } from '../context-app/async-context.controller.js';
import { SingletonProbeService } from '../shared/singleton-probe.service.js';

/**
 * Module that always fails during dependency instantiation. Bootstrap must
 * reject (with `abortOnError: false`) instead of leaving a half-initialized,
 * still-serviceable application behind.
 */
@Module({
  imports: [RequestContextModule.forRoot()],
  controllers: [AsyncContextController, AsyncRecordsController],
  providers: [
    AsyncRecordsStore,
    SingletonProbeService,
    {
      provide: APP_FILTER,
      useClass: ProbeExceptionFilter,
    },
    {
      provide: 'FAILING_INIT_PROVIDER',
      useFactory: () => {
        throw new Error('intentional initialization failure');
      },
    },
  ],
})
export class FailingInitModule {}
