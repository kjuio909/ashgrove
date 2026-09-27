/**
 * Domain error turned into an HTTP response by {@link ProbeExceptionFilter}.
 * The same filter is registered in both probe applications, so the tests can
 * assert that an application without the request-context module still runs
 * its existing exception filters with unchanged status and body.
 */
export class FilteredProbeError extends Error {
  constructor(public readonly marker: string) {
    super(`filtered probe error: ${marker}`);
    this.name = 'FilteredProbeError';
  }
}
