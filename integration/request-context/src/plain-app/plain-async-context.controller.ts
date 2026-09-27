import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import { RequestContext, type RequestContextSnapshot } from '@nestjs/core';
import { FilteredProbeError } from '../shared/filtered-probe.error.js';
import { ASYNC_CONTEXT_ROUTE, HEALTH_ROUTE } from '../shared/routes.js';
import { SingletonProbeService } from '../shared/singleton-probe.service.js';

/**
 * Probe controller on the very same `/async-context` route, used by the
 * application that does NOT import `RequestContextModule`.
 *
 * It proves an application built without the module keeps working exactly as
 * before:
 * - the `@RequestContext()` parameter decorator resolves to `undefined`
 *   instead of throwing, so code written against the decorator fails safe;
 * - ordinary singletons keep one identity for the whole application
 *   lifetime;
 * - the pre-existing exception filter keeps its status code and body;
 * - no continuation records are ever produced (the records store of this
 *   application always reads back empty).
 */
@Controller()
export class PlainAsyncContextController {
  constructor(private readonly singletonProbe: SingletonProbeService) {}

  @Get(ASYNC_CONTEXT_ROUTE)
  public async probe(
    @Query('marker') marker: string | undefined,
    @Query('fail') fail: string | undefined,
    @RequestContext() context: RequestContextSnapshot | undefined,
  ) {
    if (typeof marker !== 'string' || marker.length === 0) {
      throw new BadRequestException('marker query parameter is required');
    }

    // Cross an async boundary just like the context-enabled controller; with
    // no module installed the decorator result stays undefined throughout.
    await Promise.resolve();

    if (fail === 'request') {
      throw new BadRequestException('intentional controller failure');
    }
    if (fail === 'filtered') {
      throw new FilteredProbeError(marker);
    }

    return {
      marker,
      contextAttached: context !== undefined,
      singletonId: this.singletonProbe.id,
    };
  }

  @Get(HEALTH_ROUTE)
  public health() {
    return { status: 'ok', singletonId: this.singletonProbe.id };
  }
}
