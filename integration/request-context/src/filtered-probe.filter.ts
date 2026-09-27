import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpStatus,
} from '@nestjs/common';
import { FilteredProbeError } from './filtered-probe.error.js';

/**
 * Converts {@link FilteredProbeError} into an HTTP response. It is
 * registered in both the context-enabled and the control application, so the
 * tests can prove that an application-registered exception filter keeps the
 * same status code and body whether or not the request-context module is
 * present (and that error responses terminate snapshots when it is).
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
