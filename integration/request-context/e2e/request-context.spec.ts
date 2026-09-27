import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import http from 'node:http';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { RequestContextRegistry } from '../src/request-context/request-context.registry.js';
import type { ProbeRecordView } from '../src/request-context/request-context.registry.js';

const createApp = async (): Promise<{
  app: INestApplication;
  baseUrl: string;
}> => {
  const app = await NestFactory.create(AppModule, {
    logger: false,
    // Held-open requests (mode=hold) must not prevent the HTTP server from
    // closing: their sockets are destroyed, finalizing the snapshots.
    forceCloseConnections: true,
  });
  await app.listen(0);
  return { app, baseUrl: await app.getUrl() };
};

const getRecords = async (baseUrl: string): Promise<ProbeRecordView[]> => {
  const response = await request(baseUrl).get('/context-records').expect(200);
  return response.body.records;
};

const waitFor = async (
  predicate: () => Promise<boolean> | boolean,
  description: string,
  timeoutMs = 5000,
): Promise<void> => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 15));
  }
  throw new Error(`Timed out waiting for: ${description}`);
};

const waitForRecords = async (
  baseUrl: string,
  predicate: (records: ProbeRecordView[]) => boolean,
  description: string,
): Promise<ProbeRecordView[]> => {
  let records: ProbeRecordView[] = [];
  await waitFor(async () => {
    records = await getRecords(baseUrl);
    return predicate(records);
  }, description);
  return records;
};

const byMarker = (records: ProbeRecordView[], marker: string) =>
  records.filter(record => record.marker === marker);

// Post-response work must never surface an unhandled error, including after
// request objects are torn down or when callbacks intentionally fail.
const unhandledErrors: unknown[] = [];
const onUnhandledRejection = (reason: unknown) => unhandledErrors.push(reason);
const onUncaughtException = (error: unknown) => unhandledErrors.push(error);

beforeAll(() => {
  process.on('unhandledRejection', onUnhandledRejection);
  process.on('uncaughtException', onUncaughtException);
});

afterAll(() => {
  process.removeListener('unhandledRejection', onUnhandledRejection);
  process.removeListener('uncaughtException', onUncaughtException);
  expect(unhandledErrors).toEqual([]);
});

describe('Request metadata snapshot (HTTP)', () => {
  let app: INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    ({ app, baseUrl } = await createApp());
  });

  afterAll(async () => {
    await app.close();
  });

  describe('lifecycle states', () => {
    const MARKER = 'held-lifecycle';

    it('exposes the open state while the request is in flight', async () => {
      const held = request(baseUrl)
        .get('/context-probe')
        .query({ marker: MARKER, mode: 'hold', delay: 250 })
        .catch(() => undefined);

      const open = await waitForRecords(
        baseUrl,
        records => byMarker(records, MARKER).some(r => r.state === 'open'),
        'registration to become visible while open',
      );
      const record = byMarker(open, MARKER)[0];
      expect(record.state).toBe('open');
      expect(record.finalizations).toBe(0);
      expect(record.finalizeAttempts).toBe(0);
      expect(record.callbackRuns).toBe(0);
      // Values written by other consumers before termination are visible.
      expect(record.values.consumer).toBe(`consumer:${MARKER}`);
      expect(record.values.interceptor).toBe('saw-request');

      await request(baseUrl)
        .get('/release')
        .query({ marker: MARKER })
        .expect(200);
      await held;
    });

    it('freezes the snapshot at termination before the callback runs', async () => {
      const frozen = await waitForRecords(
        baseUrl,
        records => byMarker(records, MARKER).some(r => r.state === 'frozen'),
        'snapshot to freeze',
      );
      const record = byMarker(frozen, MARKER)[0];
      expect(record.state).toBe('frozen');
      expect(record.finalizations).toBe(1);
      expect(record.callbackRuns).toBe(0);
      expect(record.callbackFirstRead).toBeNull();
      // The snapshot contains the pre-termination values only.
      expect(record.values.consumer).toBe(`consumer:${MARKER}`);
      expect(record.values).not.toHaveProperty('__postFreezeWrite__');
      // A write that races termination was rejected.
      expect(record.lateWriteRejected).toBe(true);
    });

    it('completes the callback once with consistent frozen reads', async () => {
      const done = await waitForRecords(
        baseUrl,
        records => byMarker(records, MARKER).some(r => r.state === 'completed'),
        'callback to complete',
      );
      const record = byMarker(done, MARKER)[0];
      expect(record.state).toBe('completed');
      expect(record.reason).toBe('finish');
      expect(record.finalizations).toBe(1);
      expect(record.callbackRuns).toBe(1);
      expect(record.callbackError).toBeNull();
      expect(record.callbackReadsConsistent).toBe(true);
      expect(record.callbackFirstRead).toEqual(record.callbackSecondRead);
      expect(record.callbackFirstRead).toMatchObject({
        marker: MARKER,
        consumer: `consumer:${MARKER}`,
        interceptor: 'saw-request',
        reason: 'finish',
      });
    });
  });

  describe('independent registrations', () => {
    it('never merges records even when markers are identical', async () => {
      await Promise.all([
        request(baseUrl)
          .get('/context-probe')
          .query({ marker: 'dup', delay: 0 })
          .expect(200),
        request(baseUrl)
          .get('/context-probe')
          .query({ marker: 'dup', delay: 0 })
          .expect(200),
        request(baseUrl)
          .get('/context-probe')
          .query({ marker: 'dup', delay: 0, registrations: 3 })
          .expect(200),
      ]);

      const records = await waitForRecords(
        baseUrl,
        all =>
          byMarker(all, 'dup').length === 5 &&
          byMarker(all, 'dup').every(r => r.state === 'completed'),
        'all duplicate-marker registrations to complete',
      );
      const dup = byMarker(records, 'dup');
      expect(new Set(dup.map(r => r.id)).size).toBe(5);
      // Three requests: two single registrations and one triple.
      expect(new Set(dup.map(r => r.requestId)).size).toBe(3);
      expect(dup.every(r => r.callbackFirstRead?.marker === 'dup')).toBe(true);
    });

    it('isolates concurrent requests carrying different markers', async () => {
      const COUNT = 25;
      await Promise.all(
        Array.from({ length: COUNT }, (_, index) =>
          request(baseUrl)
            .get('/context-probe')
            .query({ marker: `concurrent-${index}`, delay: index % 5 })
            .expect(200),
        ),
      );

      const records = await waitForRecords(
        baseUrl,
        all => {
          const matched = all.filter(r => r.marker.startsWith('concurrent-'));
          return (
            matched.length === COUNT &&
            matched.every(r => r.state === 'completed')
          );
        },
        'concurrent callbacks to complete',
      );
      const concurrent = records.filter(r =>
        r.marker.startsWith('concurrent-'),
      );
      expect(new Set(concurrent.map(r => r.marker)).size).toBe(COUNT);
      expect(new Set(concurrent.map(r => r.requestId)).size).toBe(COUNT);
      for (const record of concurrent) {
        expect(record.callbackFirstRead?.marker).toBe(record.marker);
        expect(record.callbackFirstRead?.consumer).toBe(
          `consumer:${record.marker}`,
        );
        expect(record.callbackSecondRead?.marker).toBe(record.marker);
        expect(record.finalizations).toBe(1);
        expect(record.callbackRuns).toBe(1);
      }
    });
  });

  describe('termination paths', () => {
    it('finalizes exactly once despite finish + close events', async () => {
      await request(baseUrl)
        .get('/context-probe')
        .query({ marker: 'multi-event', delay: 0 })
        .expect(200);

      const records = await waitForRecords(
        baseUrl,
        all => byMarker(all, 'multi-event').some(r => r.state === 'completed'),
        'multi-event callback',
      );
      const record = byMarker(records, 'multi-event')[0];
      // `finish` and `close` both arrive; only one finalization is performed.
      expect(record.finalizeAttempts).toBeGreaterThanOrEqual(2);
      expect(record.finalizations).toBe(1);
      expect(record.callbackRuns).toBe(1);
    });

    it('finalizes when a controller error is converted by an exception filter', async () => {
      const response = await request(baseUrl)
        .get('/context-probe')
        .query({ marker: 'filtered', mode: 'error', delay: 0 });
      expect(response.status).toBe(418);
      expect(response.body.transformedBy).toBe('ProbeExceptionFilter');
      expect(response.body.marker).toBe('filtered');

      const records = await waitForRecords(
        baseUrl,
        all => byMarker(all, 'filtered').some(r => r.state === 'completed'),
        'filtered-error callback',
      );
      const record = byMarker(records, 'filtered')[0];
      expect(record.reason).toBe('finish');
      expect(record.finalizations).toBe(1);
      expect(record.callbackRuns).toBe(1);
      expect(record.callbackFirstRead?.marker).toBe('filtered');
    });

    it('finalizes when the client aborts the request', async () => {
      const abortedRequest = http.get(
        `${baseUrl}/context-probe?marker=aborted&mode=hold&delay=0`,
      );
      abortedRequest.on('error', () => undefined);

      await waitForRecords(
        baseUrl,
        all => byMarker(all, 'aborted').some(r => r.state === 'open'),
        'aborted request to register',
      );

      abortedRequest.destroy();

      const records = await waitForRecords(
        baseUrl,
        all => byMarker(all, 'aborted').some(r => r.state === 'completed'),
        'aborted request to finalize',
      );
      const record = byMarker(records, 'aborted')[0];
      expect(record.reason).toBe('aborted');
      expect(record.finalizations).toBe(1);
      expect(record.callbackRuns).toBe(1);
      expect(record.callbackFirstRead).toMatchObject({
        marker: 'aborted',
        reason: 'aborted',
      });
    });
  });

  describe('failure boundaries', () => {
    it('keeps a failing callback isolated from other records', async () => {
      await Promise.all([
        request(baseUrl)
          .get('/context-probe')
          .query({ marker: 'boom', mode: 'fail', delay: 0 })
          .expect(200),
        request(baseUrl)
          .get('/context-probe')
          .query({ marker: 'healthy', delay: 0 })
          .expect(200),
      ]);

      const records = await waitForRecords(
        baseUrl,
        all =>
          ['boom', 'healthy'].every(marker =>
            byMarker(all, marker).some(r => r.state === 'completed'),
          ),
        'both callbacks to settle',
      );
      const failed = byMarker(records, 'boom')[0];
      const healthy = byMarker(records, 'healthy')[0];

      expect(failed.callbackError).toMatch(/intentional callback failure/);
      expect(failed.callbackError).toContain('boom');
      // The failing callback still ran once and its frozen reads happened.
      expect(failed.callbackRuns).toBe(1);
      expect(failed.callbackReadsConsistent).toBe(true);
      expect(failed.callbackFirstRead?.marker).toBe('boom');

      expect(healthy.callbackError).toBeNull();
      expect(healthy.callbackRuns).toBe(1);
      expect(healthy.callbackFirstRead?.marker).toBe('healthy');
    });
  });

  describe('routes that do not use the capability', () => {
    it('keeps ordinary routes and error propagation unchanged', async () => {
      const plain = await request(baseUrl)
        .get('/plain')
        .query({ marker: 'ordinary' })
        .expect(200);
      expect(plain.body).toEqual({ ok: true, marker: 'ordinary' });

      const failed = await request(baseUrl).get('/plain-error');
      expect(failed.status).toBe(502);
      expect(failed.body.message).toBe('ordinary failure');

      const records = await getRecords(baseUrl);
      // Ordinary traffic registered nothing.
      expect(records.some(r => r.marker === 'ordinary')).toBe(false);
    });
  });
});

describe('Request metadata snapshot shutdown', () => {
  it('flushes pending callbacks on close, rejects new requests, and isolates generations', async () => {
    const { app: firstApp, baseUrl: firstUrl } = await createApp();

    // Frozen, but its callback is scheduled far in the future.
    await request(firstUrl)
      .get('/context-probe')
      .query({ marker: 'pending-at-close', delay: 60_000 })
      .expect(200);

    // Still open when shutdown starts, with a callback scheduled far away.
    const held = request(firstUrl)
      .get('/context-probe')
      .query({ marker: 'open-at-close', mode: 'hold', delay: 60_000 })
      .catch(() => undefined);

    await waitForRecords(
      firstUrl,
      records =>
        byMarker(records, 'open-at-close').some(r => r.state === 'open'),
      'held request to register',
    );
    await waitForRecords(
      firstUrl,
      records =>
        byMarker(records, 'pending-at-close').some(r => r.state === 'frozen'),
      'pending registration to freeze',
    );

    const firstRegistry = firstApp.get(RequestContextRegistry);
    await firstApp.close();
    await held;

    const firstRecords = firstRegistry.list();
    const pending = byMarker(firstRecords, 'pending-at-close')[0];
    const open = byMarker(firstRecords, 'open-at-close')[0];

    // Both callbacks ran during shutdown against their frozen snapshots.
    expect(pending.state).toBe('completed');
    expect(pending.callbackRuns).toBe(1);
    expect(pending.finalizations).toBe(1);
    expect(pending.callbackFirstRead?.marker).toBe('pending-at-close');
    expect(open.state).toBe('completed');
    expect(open.callbackRuns).toBe(1);
    expect(open.finalizations).toBe(1);
    expect(open.reason).toBe('aborted');
    expect(open.callbackFirstRead?.marker).toBe('open-at-close');

    // Repeated shutdown must not replay callbacks or finalize twice.
    await firstApp.close();
    const reclosed = firstRegistry
      .list()
      .filter(r => ['pending-at-close', 'open-at-close'].includes(r.marker));
    expect(reclosed.every(r => r.callbackRuns === 1)).toBe(true);
    expect(reclosed.every(r => r.finalizations === 1)).toBe(true);

    // The closed application cannot receive new probe requests.
    await expect(
      fetch(`${firstUrl}/context-probe?marker=after-close`),
    ).rejects.toThrow();

    // A freshly created application starts a new generation: none of the
    // first generation's records are visible or replayed.
    const { app: secondApp, baseUrl: secondUrl } = await createApp();
    try {
      const response = await request(secondUrl)
        .get('/context-records')
        .expect(200);
      expect(response.body.records).toEqual([]);

      await request(secondUrl)
        .get('/context-probe')
        .query({ marker: 'second-generation', delay: 0 })
        .expect(200);
      const records = await waitForRecords(
        secondUrl,
        all =>
          byMarker(all, 'second-generation').some(r => r.state === 'completed'),
        'second-generation callback',
      );
      expect(records.map(r => r.marker)).toEqual(['second-generation']);
    } finally {
      await secondApp.close();
    }
  }, 30_000);
});
