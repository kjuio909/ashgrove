import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpStatus,
  Module,
} from '@nestjs/common';
import { APP_FILTER, RequestContextModule } from '@nestjs/core';
import { AppController } from './app.controller.js';
import { ContextEchoController } from './context-echo.controller.js';
import { ContextRecordsStore } from './context-records.store.js';
import { FilteredProbeError } from './filtered-probe.error.js';

/**
 * Converts {@link FilteredProbeError} into an HTTP response, exercising the
 * requirement that snapshots terminate when a controller error is
 * transformed by an existing (application-registered) exception filter.
 */
@Catch(FilteredProbeError)
export class FilteredProbeExceptionFilter implements ExceptionFilter {
  public catch(exception: FilteredProbeError, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<{
      raw?: unknown;
      code?: (status: number) => { send: (body: unknown) => void };
      status?: (code: number) => { json: (body: unknown) => void };
    }>();

    const body = {
      filtered: true,
      marker: exception.marker,
    };

    if (response.raw && typeof response.code === 'function') {
      // Fastify reply (detected via its raw transport; note that Fastify's
      // reply also exposes `.status()`, so that cannot be used to tell the
      // adapters apart).
      response.code(HttpStatus.UNPROCESSABLE_ENTITY).send(body);
    } else if (typeof response.status === 'function') {
      // Express response
      response.status(HttpStatus.UNPROCESSABLE_ENTITY).json(body);
    }
  }
}

@Module({
  imports: [RequestContextModule.forRoot()],
  controllers: [AppController, ContextEchoController],
  providers: [
    ContextRecordsStore,
    {
      provide: APP_FILTER,
      useClass: FilteredProbeExceptionFilter,
    },
  ],
})
export class AppModule {}
