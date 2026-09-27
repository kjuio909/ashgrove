import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';

/**
 * Plain application singleton shared by every request.
 *
 * Its identity is asserted by the tests: without the request-context module
 * the application behaves exactly as before, i.e. one provider instance
 * serves all requests for the lifetime of the application and a fresh
 * application gets a fresh instance. When the module is enabled nothing
 * changes for regular singletons either.
 */
@Injectable()
export class ProbeIdentityService {
  public readonly id = randomUUID();
  private hits = 0;

  public hit(): number {
    this.hits += 1;
    return this.hits;
  }

  public getHitCount(): number {
    return this.hits;
  }
}
