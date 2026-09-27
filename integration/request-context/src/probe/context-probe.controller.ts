import {
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Query,
  Req,
  UseFilters,
} from '@nestjs/common';
import { RequestContextRegistry } from '../request-context/request-context.registry.js';
import { ProbeExceptionFilter } from './probe.exception-filter.js';
import { ProbeTeapotException } from './probe-teapot.exception.js';
import { ProbeHoldService } from './probe-hold.service.js';

@Controller()
export class ContextProbeController {
  constructor(
    private readonly registry: RequestContextRegistry,
    private readonly hold: ProbeHoldService,
  ) {}

  /**
   * Registers one or more post-response callbacks for the current request.
   * Every registration becomes its own record, even within one request with
   * an identical marker.
   */
  @Get('context-probe')
  @UseFilters(ProbeExceptionFilter)
  async probe(
    @Req() req: any,
    @Query('marker') marker = '',
    @Query('delay') delay = '20',
    @Query('registrations') registrations = '1',
    @Query('mode') mode: 'normal' | 'hold' | 'error' | 'fail' = 'normal',
  ) {
    const host = this.registry.getHost(req)!;
    // A second consumer of this request writes before termination; the
    // frozen snapshot must contain this value.
    host.setValue('consumer', `consumer:${marker}`);

    const delayMs = Math.max(0, Number(delay) || 0);
    const count = Math.max(1, Number(registrations) || 1);
    const ids: string[] = [];
    for (let i = 0; i < count; i++) {
      ids.push(
        this.registry.register(host, {
          marker,
          delayMs,
          shouldFail: mode === 'fail',
        }).id,
      );
    }

    if (mode === 'hold') {
      // Kept open until /release?marker=... (or aborted by the client).
      await this.hold.wait(marker);
    }
    if (mode === 'error') {
      throw new ProbeTeapotException(marker);
    }

    return { registered: ids, marker };
  }

  /** Read back every registration of this application generation. */
  @Get('context-records')
  records() {
    return { records: this.registry.list() };
  }

  /** Releases a request parked with `mode=hold`. */
  @Get('release')
  release(@Query('marker') marker = '') {
    return { released: this.hold.release(marker) };
  }

  /**
   * Ordinary route that does not use the capability: no registration happens
   * here, and existing route/error semantics must remain unchanged.
   */
  @Get('plain')
  plain(@Query('marker') marker = '') {
    return { ok: true, marker };
  }

  @Get('plain-error')
  plainError() {
    throw new HttpException('ordinary failure', HttpStatus.BAD_GATEWAY);
  }
}
