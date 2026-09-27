import { Module } from '@nestjs/common';
import { RequestContextProbeModule } from './request-context-probe.module.js';

@Module({
  imports: [RequestContextProbeModule],
})
export class AppModule {}
