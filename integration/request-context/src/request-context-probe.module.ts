import {
  type MiddlewareConsumer,
  Module,
  NestModule,
  OnApplicationShutdown,
} from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { ContextProbeController } from './probe/context-probe.controller.js';
import { ProbeHoldService } from './probe/probe-hold.service.js';
import { RequestContextRegistry } from './request-context/request-context.registry.js';
import { SnapshotConsumerInterceptor } from './request-context/snapshot-consumer.interceptor.js';
import { SnapshotContextMiddleware } from './request-context/snapshot-context.middleware.js';

/**
 * Wires the reusable request-metadata snapshot capability:
 *
 * - a wildcard middleware attaches one snapshot host per request;
 * - a global interceptor acts as a second consumer writing before
 *   termination;
 * - the registry finalizes snapshots on request end and flushes pending
 *   callbacks on application shutdown.
 */
@Module({
  controllers: [ContextProbeController],
  providers: [
    RequestContextRegistry,
    ProbeHoldService,
    SnapshotContextMiddleware,
    { provide: APP_INTERCEPTOR, useClass: SnapshotConsumerInterceptor },
  ],
})
export class RequestContextProbeModule
  implements NestModule, OnApplicationShutdown
{
  constructor(private readonly registry: RequestContextRegistry) {}

  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(SnapshotContextMiddleware).forRoutes('*');
  }

  async onApplicationShutdown(): Promise<void> {
    // The HTTP server is closed at this point (it stops accepting new probe
    // requests during `beforeClose`). Finalize whatever is still open and run
    // every callback that has not run yet, each against its frozen values.
    await this.registry.flushOnShutdown();
  }
}
