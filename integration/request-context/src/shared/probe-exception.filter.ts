import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpStatus,
} from '@nestjs/common';
import { FilteredProbeError } from './filtered-probe.error.js';

/**
 * Converts {@link FilteredProbeError} into an HTTP response. Registered
 * identically in both probe applications, so the module-less control
 * application can prove that its pre-existing exception filters keep their
 * status code and body exactly when {@link RequestContextModule} is absent.
 */
@Catch(FilteredProbeError)
export class ProbeExceptionFilter implements ExceptionFilter {
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
      // Fastify reply (its `.status()` alias also exists on Express, so the
      // raw transport is used to tell the adapters apart).
      response.code(HttpStatus.UNPROCESSABLE_ENTITY).send(body);
    } else if (typeof response.status === 'function') {
      // Express response
      response.status(HttpStatus.UNPROCESSABLE_ENTITY).json(body);
    }
  }
}
