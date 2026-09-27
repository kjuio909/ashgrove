import type { INestApplication } from '@nestjs/common';
import * as http from 'node:http';
import { AppModule } from '../src/app.module.js';
import { AsyncRecordsStore } from '../src/async-records.store.js';
import { ReorderedModule } from './fixtures/reordered.module.js';
import {
  createApp,
  type HttpPlatform,
  getPort,
  rawGet,
  recordById,
  waitForRecords,
} from './harness.js';

/**
 * Shared behavioral suite for the context-enabled application. Registered
 * once per platform, so every guarantee is proven on both Express and
 * Fastify.
 */
export function registerContextSuite(platform: HttpPlatform): void {
  describe(`Async request context (${platform})`, () => {
    let app: INestApplication;
    let port: number;

    beforeEach(async () => {
      app = await createApp(AppModule, platform);
      port = await getPort(app);
    });

    afterEach(async () => {
      await app?.close();
    });

    it('writes the marker, survives an async wait and stays bound to the request', async () => {
      const marker = '文本';
      const probe = await rawGet(
        port,
        `/async-context?marker=${encodeURIComponent(marker)}`,
      );
      expect(probe.statusCode).toBe(200);
      expect(probe.body).toMatchObject({
        contextEnabled: true,
        marker,
        asyncReadsConsistent: true,
        stillCurrentRequest: true,
      });
      expect(probe.body.contextId).toEqual(expect.any(String));
      expect(probe.body.recordIds).toHaveLength(1);

      await rawGet(port, '/release-gates');
      const records = await waitForRecords(
        port,
        items => items.length === 1 && items[0].status === 'completed',
      );
      expect(records[0]).toMatchObject({
        contextId: probe.body.contextId,
        appId: probe.body.appId,
        marker,
        frozenMarker: marker,
        status: 'completed',
        terminationReason: 'finish',
        terminationCount: 1,
        lateWriteAccepted: false,
        lateWriteVisible: false,
        readsStable: true,
        errorMessage: null,
      });
    });

    it('injects the snapshot through the REQUEST_CONTEXT token', async () => {
      const result = await rawGet(port, '/context-echo?value=hello');
      expect(result.statusCode).toBe(200);
      expect(result.body).toMatchObject({
        attached: true,
        frozen: false,
        echoValue: 'hello',
      });
    });

    it('isolates concurrent requests carrying different markers', async () => {
      const markers = ['alpha', 'beta', 'gamma', 'delta'];
      const probes = await Promise.all(
        markers.map(marker =>
          rawGet(
            port,
            `/async-context?marker=${marker}&registrations=2&consumerValue=cv-${marker}`,
          ),
        ),
      );

      const idToMarker = new Map<string, string>();
      probes.forEach((probe, index) => {
        expect(probe.body.marker).toBe(markers[index]);
        expect(probe.body.stillCurrentRequest).toBe(true);
        probe.body.recordIds.forEach((id: string) =>
          idToMarker.set(id, markers[index]),
        );
      });

      // While parked, every record must already report pending.
      const pending = await rawGet(port, '/async-records');
      expect(pending.body.records).toHaveLength(8);
      expect(pending.body.records.map((r: any) => r.status)).toEqual(
        Array(8).fill('pending'),
      );

      await rawGet(port, '/release-gates');
      const records = await waitForRecords(
        port,
        items => items.length === 8 && items.every(r => r.status !== 'pending'),
      );
      for (const record of records) {
        const marker = idToMarker.get(record.recordId);
        expect(record.marker).toBe(marker);
        expect(record.frozenMarker).toBe(marker);
        expect(record.consumerValue).toBe(`cv-${marker}`);
        // No record may leak another request's context.
        const owner = probes.find(p =>
          p.body.recordIds.includes(record.recordId),
        )!;
        expect(record.contextId).toBe(owner.body.contextId);
      }
    });

    it('never merges records for identical markers or repeated requests', async () => {
      const first = await rawGet(
        port,
        '/async-context?marker=dup&registrations=3',
      );
      const second = await rawGet(port, '/async-context?marker=dup');
      const ids = [...first.body.recordIds, ...second.body.recordIds];
      expect(new Set(ids).size).toBe(4);
      expect(first.body.contextId).not.toBe(second.body.contextId);

      await rawGet(port, '/release-gates');
      const records = await waitForRecords(
        port,
        items =>
          items.length === 4 && items.every(r => r.status === 'completed'),
      );
      expect(records.map(r => r.marker)).toEqual(['dup', 'dup', 'dup', 'dup']);
      expect(new Set(records.map(r => r.recordId)).size).toBe(4);
      expect(new Set(records.map(r => r.contextId)).size).toBe(2);
    });

    it('reports pending while a continuation is running and only completed/failed after', async () => {
      const probe = await rawGet(
        port,
        '/async-context?marker=states&registrations=2&failContinuationIndex=1',
      );
      const [okId, failingId] = probe.body.recordIds;

      const parked = await waitForRecords(
        port,
        items => items.length === 2 && items.every(r => r.status === 'pending'),
      );
      expect(parked.every(r => r.frozenMarker === null)).toBe(true);

      await rawGet(port, `/release-gates?recordId=${okId}`);
      await waitForRecords(
        port,
        items => recordById(items, okId).status === 'completed',
      );
      // The not-yet-released sibling stays pending; nothing settles early.
      const halfWay = await rawGet(port, '/async-records');
      expect(recordById(halfWay.body.records, failingId).status).toBe(
        'pending',
      );

      await rawGet(port, `/release-gates?recordId=${failingId}`);
      const records = await waitForRecords(port, items =>
        items.every(r => r.status !== 'pending'),
      );
      expect(recordById(records, okId).status).toBe('completed');
      const failed = recordById(records, failingId);
      expect(failed.status).toBe('failed');
      expect(failed.errorMessage).toContain('states');
      expect(failed.frozenMarker).toBeNull();
    });

    it('freezes the marker at termination and ignores later writes', async () => {
      const probe = await rawGet(
        port,
        '/async-context?marker=frozen&consumerValue=written-before-freeze',
      );
      await rawGet(port, '/release-gates');
      const records = await waitForRecords(
        port,
        items =>
          recordById(items, probe.body.recordIds[0]).status === 'completed',
      );
      const record = recordById(records, probe.body.recordIds[0]);
      expect(record.frozenMarker).toBe('frozen');
      expect(record.consumerValue).toBe('written-before-freeze');
      expect(record.lateWriteAccepted).toBe(false);
      expect(record.lateWriteVisible).toBe(false);
      expect(record.readsStable).toBe(true);
    });

    it('terminates snapshots for default and custom-filter error responses', async () => {
      const defaultError = await rawGet(
        port,
        '/async-context?marker=err1&fail=request',
      );
      expect(defaultError.statusCode).toBe(400);
      expect(defaultError.body.statusCode).toBe(400);

      const filteredError = await rawGet(
        port,
        '/async-context?marker=err2&fail=filtered',
      );
      expect(filteredError.statusCode).toBe(422);
      expect(filteredError.body).toEqual({ filtered: true, marker: 'err2' });

      await rawGet(port, '/release-gates');
      const records = await waitForRecords(
        port,
        items =>
          items.length === 2 && items.every(r => r.status === 'completed'),
      );
      expect(records.map(r => r.terminationReason)).toEqual([
        'finish',
        'finish',
      ]);
      expect(records.map(r => r.terminationCount)).toEqual([1, 1]);
      expect(records.map(r => r.frozenMarker)).toEqual(['err1', 'err2']);
    });

    it('terminates the snapshot when the client aborts', async () => {
      const probe = rawGet(port, '/async-context?marker=aborted&delayMs=3000');
      probe.catch(() => {});
      setTimeout(() => probe.req!.destroy(), 80);

      const records = await waitForRecords(port, items =>
        items.some(r => r.marker === 'aborted' && r.status === 'pending'),
      );
      const recordId = records.find(r => r.marker === 'aborted')!.recordId;

      await rawGet(port, '/release-gates');
      const settled = await waitForRecords(
        port,
        items => recordById(items, recordId).status === 'completed',
      );
      expect(recordById(settled, recordId)).toMatchObject({
        terminationReason: 'abort',
        terminationCount: 1,
        frozenMarker: 'aborted',
      });
    }, 10_000);

    it('keeps serving after a continuation failure and never rewrites settled records', async () => {
      const broken = await rawGet(
        port,
        '/async-context?marker=boom&registrations=2&failContinuationIndex=0',
      );
      await rawGet(port, '/release-gates');
      const settled = await waitForRecords(port, items =>
        items.every(r => r.status !== 'pending'),
      );
      const [failed, completed] = broken.body.recordIds.map((id: string) =>
        recordById(settled, id),
      );
      expect(failed.status).toBe('failed');
      expect(completed.status).toBe('completed');

      // A later failure report for the already-completed id must not rewrite
      // it, and the application is still fully serviceable.
      const store = app.get(AsyncRecordsStore);
      store.markFailed(completed.recordId, new Error('late failure'));
      const after = await rawGet(port, '/async-records');
      expect(recordById(after.body.records, completed.recordId).status).toBe(
        'completed',
      );

      const next = await rawGet(port, '/async-context?marker=after-boom');
      expect(next.statusCode).toBe(200);
      expect(next.body.marker).toBe('after-boom');
    });

    it('drains parked continuations during shutdown and then refuses requests', async () => {
      const probe = await rawGet(port, '/async-context?marker=shutdown');
      await waitForRecords(port, items =>
        items.some(
          r => r.recordId === probe.body.recordIds[0] && r.status === 'pending',
        ),
      );

      await app.close();

      const store = app.get(AsyncRecordsStore);
      const [record] = store.getAll();
      expect(record).toMatchObject({
        marker: 'shutdown',
        frozenMarker: 'shutdown',
        status: 'completed',
        terminationCount: 1,
      });

      await expect(
        new Promise((resolve, reject) =>
          http
            .get({ port, path: '/async-context?marker=rejected' }, resolve)
            .on('error', reject),
        ),
      ).rejects.toMatchObject({ code: 'ECONNREFUSED' });
    }, 15_000);

    it('drains a failing continuation during shutdown as failed, without hanging', async () => {
      const probe = await rawGet(
        port,
        '/async-context?marker=shutdown-fail&fail=continuation',
      );
      await waitForRecords(port, items =>
        items.some(
          r => r.recordId === probe.body.recordIds[0] && r.status === 'pending',
        ),
      );

      // Gates are released by the store during destroy; the failing
      // continuation must settle as "failed" while close still resolves.
      await app.close();

      const store = app.get(AsyncRecordsStore);
      const [record] = store.getAll();
      // The failing continuation throws before reading the snapshot, so its
      // frozenMarker stays null; what matters is the captured "failed" state
      // and that close() resolved instead of hanging or leaving it pending.
      expect(record).toMatchObject({
        marker: 'shutdown-fail',
        status: 'failed',
        frozenMarker: null,
      });
      expect(record.errorMessage).toContain('shutdown-fail');
    }, 15_000);

    it('does not replay records after closing and recreating the application', async () => {
      const first = await rawGet(port, '/async-context?marker=first-app');
      await rawGet(port, '/release-gates');
      await waitForRecords(port, items =>
        items.some(
          r =>
            r.recordId === first.body.recordIds[0] && r.status === 'completed',
        ),
      );
      await app.close();

      app = await createApp(AppModule, platform);
      port = await getPort(app);

      const second = await rawGet(port, '/async-context?marker=second-app');
      expect(second.body.appId).not.toBe(first.body.appId);
      await rawGet(port, '/release-gates');
      const records = await waitForRecords(
        port,
        items =>
          items.length === 1 &&
          items[0].marker === 'second-app' &&
          items[0].status === 'completed',
      );
      expect(records[0].contextId).not.toBe(first.body.contextId);
      expect(records[0].appId).toBe(second.body.appId);
      expect(records.map(r => r.marker)).not.toContain('first-app');
    }, 15_000);

    it('is insensitive to module and controller registration order', async () => {
      await app.close();
      app = await createApp(ReorderedModule, platform);
      port = await getPort(app);

      const probe = await rawGet(port, '/async-context?marker=reordered');
      expect(probe.body).toMatchObject({
        contextEnabled: true,
        marker: 'reordered',
        asyncReadsConsistent: true,
        stillCurrentRequest: true,
      });
      const echo = await rawGet(port, '/context-echo?value=ok');
      expect(echo.body).toMatchObject({ attached: true, echoValue: 'ok' });

      await rawGet(port, '/release-gates');
      const records = await waitForRecords(port, items =>
        items.some(r => r.status === 'completed'),
      );
      expect(records[0].frozenMarker).toBe('reordered');
    });
  });
}
