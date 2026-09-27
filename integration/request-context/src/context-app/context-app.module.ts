import { Module } from '@nestjs/common';
import { APP_FILTER, RequestContextModule } from '@nestjs/core';
import { AsyncRecordsController } from '../shared/async-records.controller.js';
import { AsyncRecordsStore } from '../shared/async-records.store.js';
import { ProbeExceptionFilter } from '../shared/probe-exception.filter.js';
import { SingletonProbeService } from '../shared/singleton-probe.service.js';
import { AsyncContextController } from './async-context.controller.js';
import { ContextEchoController } from './context-echo.controller.js';
import { RequestContextConsumer } from './request-context.consumer.js';

const sharedProviders = [
  AsyncRecordsStore,
  SingletonProbeService,
  RequestContextConsumer,
  {
    provide: APP_FILTER,
    useClass: ProbeExceptionFilter,
  },
];

/**
 * Application that registers `RequestContextModule.forRoot()`. Bootstrapped
 * once with Express and once with Fastify by the e2e specs.
 */
@Module({
  imports: [RequestContextModule.forRoot()],
  controllers: [
    AsyncContextController,
    AsyncRecordsController,
    ContextEchoController,
  ],
  providers: sharedProviders,
})
export class ContextAppModule {}

/**
 * Same application with module/controller/provider registration order
 * reversed, used to prove that registration order cannot change any result.
 */
@Module({
  controllers: [
    ContextEchoController,
    AsyncRecordsController,
    AsyncContextController,
  ],
  providers: [
    {
      provide: APP_FILTER,
      useClass: ProbeExceptionFilter,
    },
    RequestContextConsumer,
    SingletonProbeService,
    AsyncRecordsStore,
  ],
  imports: [RequestContextModule.forRoot()],
})
export class ContextAppModuleReversed {}
