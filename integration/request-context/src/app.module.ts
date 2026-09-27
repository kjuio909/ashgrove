import { Module } from '@nestjs/common';
import { APP_FILTER, RequestContextModule } from '@nestjs/core';
import { AsyncContextController } from './async-context.controller.js';
import { AsyncRecordsStore } from './async-records.store.js';
import { ContextEchoController } from './context-echo.controller.js';
import { FilteredProbeExceptionFilter } from './filtered-probe.filter.js';
import { ProbeIdentityService } from './probe-identity.service.js';

@Module({
  imports: [RequestContextModule.forRoot()],
  controllers: [AsyncContextController, ContextEchoController],
  providers: [
    AsyncRecordsStore,
    ProbeIdentityService,
    {
      provide: APP_FILTER,
      useClass: FilteredProbeExceptionFilter,
    },
  ],
})
export class AppModule {}
