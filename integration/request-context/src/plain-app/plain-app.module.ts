import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { AsyncRecordsController } from '../shared/async-records.controller.js';
import { AsyncRecordsStore } from '../shared/async-records.store.js';
import { ProbeExceptionFilter } from '../shared/probe-exception.filter.js';
import { SingletonProbeService } from '../shared/singleton-probe.service.js';
import { PlainAsyncContextController } from './plain-async-context.controller.js';

/**
 * Ordinary Nest application that deliberately does NOT import
 * `RequestContextModule`. It reuses the same `/async-context` and
 * `/async-records` routes (and the same exception filter) as the
 * context-enabled application to prove that applications which never opt in
 * are completely unaffected.
 */
@Module({
  controllers: [PlainAsyncContextController, AsyncRecordsController],
  providers: [
    AsyncRecordsStore,
    SingletonProbeService,
    {
      provide: APP_FILTER,
      useClass: ProbeExceptionFilter,
    },
  ],
})
export class PlainAppModule {}

/**
 * Same module-less application with reversed registration order, used to
 * prove order-independence outside of `RequestContextModule` as well.
 */
@Module({
  controllers: [AsyncRecordsController, PlainAsyncContextController],
  providers: [
    {
      provide: APP_FILTER,
      useClass: ProbeExceptionFilter,
    },
    SingletonProbeService,
    AsyncRecordsStore,
  ],
})
export class PlainAppModuleReversed {}
