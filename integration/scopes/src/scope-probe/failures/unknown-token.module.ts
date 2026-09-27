import { Controller, Get, Inject, Module } from '@nestjs/common';

export const UNKNOWN_PROBE_TOKEN = 'UNKNOWN_PROBE_TOKEN';

/**
 * Failure boundary fixture: a controller injects a token that no module
 * provides. `NestFactory.create` must reject with the standard dependency
 * resolution exception.
 */
@Controller('scope-probe')
export class UnknownTokenController {
  constructor(
    @Inject(UNKNOWN_PROBE_TOKEN) private readonly unknown: unknown,
  ) {}

  @Get()
  probe() {
    return { marker: 'unreachable' };
  }
}

@Module({
  controllers: [UnknownTokenController],
})
export class UnknownTokenAppModule {}
