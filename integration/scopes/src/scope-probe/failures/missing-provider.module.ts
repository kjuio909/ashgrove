import { Controller, Get, Injectable, Module } from '@nestjs/common';

/**
 * Failure boundary fixture: a provider depends on a class that was never
 * registered in any module. `NestFactory.create` must reject with the
 * standard dependency resolution exception.
 */
@Injectable()
export class UnregisteredDependency {}

@Injectable()
export class DependentProbeService {
  constructor(private readonly missing: UnregisteredDependency) {}
}

@Controller('scope-probe')
export class MissingProviderController {
  constructor(private readonly dependent: DependentProbeService) {}

  @Get()
  probe() {
    return { marker: 'unreachable' };
  }
}

@Module({
  controllers: [MissingProviderController],
  providers: [DependentProbeService],
})
export class MissingProviderAppModule {}
