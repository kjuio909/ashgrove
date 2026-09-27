import { Injectable, type OnModuleInit } from '@nestjs/common';
import { APP_FILTER, RequestContextModule } from '@nestjs/core';
import { AsyncContextController } from './async-context.controller.js';
import { AsyncRecordsController } from '../shared/async-records.controller.js';
import { AsyncRecordsStore } from '../shared/async-records.store.js';
import { ProbeExceptionFilter } from '../shared/probe-exception.filter.js';
import { SingletonProbeService } from '../shared/singleton-probe.service.js';
import { Module } from '@nestjs/common';

@Injectable()
class FailingLifecycleService implements OnModuleInit {
  public onModuleInit(): never {
    throw new Error('intentional lifecycle failure');
  }
}

/**
 * Module whose initialization fails during the lifecycle-hook phase (while
 * `listen()` runs). Bootstrap must reject and the partially created HTTP
 * server must be closed, so no half-initialized application keeps serving.
 */
@Module({
  imports: [RequestContextModule.forRoot()],
  controllers: [AsyncContextController, AsyncRecordsController],
  providers: [
    AsyncRecordsStore,
    SingletonProbeService,
    FailingLifecycleService,
    {
      provide: APP_FILTER,
      useClass: ProbeExceptionFilter,
    },
  ],
})
export class FailingLifecycleModule {}
