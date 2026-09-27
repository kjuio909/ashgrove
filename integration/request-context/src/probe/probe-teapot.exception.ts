import { HttpException } from '@nestjs/common';

/**
 * Domain error of the probe. Converted into a structured 418 response by
 * {@link ProbeExceptionFilter}, demonstrating that snapshot termination also
 * runs when a controller error passes through an exception filter.
 */
export class ProbeTeapotException extends HttpException {
  constructor(readonly marker: string) {
    super(
      {
        statusCode: 418,
        message: 'probe teapot',
        marker,
      },
      418,
    );
  }
}
