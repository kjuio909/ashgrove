import { Controller, Get, Injectable, Module } from '@nestjs/common';

/**
 * Failure boundary fixture: the inner module provides a service but forgets
 * to export it, so the controller in the outer module cannot resolve it.
 * `NestFactory.create` must reject with the standard dependency resolution
 * exception before anything starts listening.
 */
@Injectable()
export class ConcealedBusinessService {}

@Module({
  providers: [ConcealedBusinessService],
})
export class ConcealedBusinessModule {}

@Controller('scope-probe')
export class MissingExportController {
  constructor(private readonly concealed: ConcealedBusinessService) {}

  @Get()
  probe() {
    return { marker: 'unreachable' };
  }
}

@Module({
  imports: [ConcealedBusinessModule],
  controllers: [MissingExportController],
})
export class MissingExportAppModule {}
