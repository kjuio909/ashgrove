/**
 * Lifecycle of a single snapshot registration, as observed through the
 * `/context-records` probe.
 *
 * - `open`      - the request has not terminated yet, no snapshot exists;
 * - `frozen`    - the request terminated and the snapshot was captured, but
 *                 the post-response callback has not run;
 * - `completed` - the callback has run exactly once against the frozen
 *                 snapshot.
 */
export type ProbeRecordState = 'open' | 'frozen' | 'completed';
