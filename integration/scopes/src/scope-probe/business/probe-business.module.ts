import { Module } from '@nestjs/common';
import { ProbeBusinessService } from './probe-business.service.js';

@Module({
  providers: [ProbeBusinessService],
  exports: [ProbeBusinessService],
})
export class ProbeBusinessModule {}
