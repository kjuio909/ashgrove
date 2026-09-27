import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
} from '@nestjs/common';
import { ProbeTeapotException } from './probe-teapot.exception.js';

/**
 * Converts {@link ProbeTeapotException} into a 418 response. Because the
 * response is ended normally through the adapter, the request still
 * terminates through the usual `finish`/`close` listeners and its snapshot is
 * finalized exactly once.
 */
@Catch(ProbeTeapotException)
export class ProbeExceptionFilter implements ExceptionFilter {
  catch(exception: ProbeTeapotException, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse();
    response.status(418).json({
      statusCode: 418,
      message: 'probe teapot',
      marker: exception.marker,
      transformedBy: 'ProbeExceptionFilter',
    });
  }
}
