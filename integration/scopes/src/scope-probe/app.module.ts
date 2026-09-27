import { Module } from '@nestjs/common';
import { ScopeProbeModule } from './scope-probe.module.js';

@Module({
  imports: [ScopeProbeModule],
})
export class AppModule {}
