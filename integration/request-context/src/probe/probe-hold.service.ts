import { Injectable } from '@nestjs/common';

/**
 * Allows a probe request to be held open deliberately, so tests can observe
 * the `open` (not yet terminated) state through `/context-records`.
 */
@Injectable()
export class ProbeHoldService {
  private readonly waiters = new Map<string, () => void>();

  wait(marker: string): Promise<void> {
    return new Promise(resolve => {
      this.waiters.set(marker, resolve);
    });
  }

  release(marker: string): boolean {
    const resolve = this.waiters.get(marker);
    if (!resolve) {
      return false;
    }
    this.waiters.delete(marker);
    resolve();
    return true;
  }
}
