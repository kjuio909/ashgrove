import { Injectable, Scope } from '@nestjs/common';
import { TransientProbeService } from './transient-probe.service.js';

/**
 * Second, independent consumer of the transient probe. Being request-scoped
 * itself, it is created once per request and receives a transient instance
 * that is distinct from the one injected into the controller.
 */
@Injectable({ scope: Scope.REQUEST })
export class TransientConsumerService {
  constructor(readonly transientProbe: TransientProbeService) {}
}
