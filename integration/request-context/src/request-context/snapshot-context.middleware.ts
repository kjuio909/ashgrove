import { Injectable, type NestMiddleware } from '@nestjs/common';
import { RequestContextRegistry } from './request-context.registry.js';

/**
 * Attaches a per-request snapshot host and wires its termination. Runs for
 * every route so the capability is available to any consumer, but only
 * explicit registrations create records.
 */
@Injectable()
export class SnapshotContextMiddleware implements NestMiddleware {
  constructor(private readonly registry: RequestContextRegistry) {}

  use(req: any, res: any, next: () => void): void {
    this.registry.attach(req, res);
    next();
  }
}
