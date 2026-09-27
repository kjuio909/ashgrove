import { Injectable } from '@nestjs/common';

/**
 * Business service provided (and exported) by an imported module. The value
 * it returns is derived from the current request's marker only, so concurrent
 * requests never observe each other's data.
 */
@Injectable()
export class ProbeBusinessService {
  getBusinessValue(marker: string): string {
    return `business:${marker}`;
  }
}
