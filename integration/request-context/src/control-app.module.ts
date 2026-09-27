import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { AsyncContextController } from './async-context.controller.js';
import { AsyncRecordsStore } from './async-records.store.js';
import { FilteredProbeExceptionFilter } from './filtered-probe.filter.js';
import { ProbeIdentityService } from './probe-identity.service.js';

/**
 * Plain control application: it deliberately does NOT import
 * `RequestContextModule`, yet it reuses the exact same controller, store and
 * identity provider as the context-enabled application.
 *
 * Its purpose is to prove the feature is strictly opt-in:
 *
 * - regular singleton providers keep one stable identity for the whole
 *   application lifetime;
 * - existing exception filters keep their status codes and bodies;
 * - no request-context records are produced and no request fails because a
 *   context is missing (the shared controller reports `contextEnabled:false`
 *   and `/async-records` stays empty).
 */
@Module({
  controllers: [AsyncContextController],
  providers: [
    AsyncRecordsStore,
    ProbeIdentityService,
    {
      provide: APP_FILTER,
      useClass: FilteredProbeExceptionFilter,
    },
  ],
})
export class ControlAppModule {}
