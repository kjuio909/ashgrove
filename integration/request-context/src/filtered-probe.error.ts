/**
 * Domain error thrown by the probe when `fail=filtered`. It is converted to
 * an HTTP response by an application-registered exception filter, exercising
 * the requirement that snapshots terminate when a controller error is
 * transformed by an existing exception filter.
 */
export class FilteredProbeError extends Error {
  constructor(public readonly marker: string) {
    super(`filtered probe error: ${marker}`);
    this.name = 'FilteredProbeError';
  }
}
