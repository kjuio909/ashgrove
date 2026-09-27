import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import * as http from 'node:http';
import { AppModule } from '../src/app.module.js';
import { ContextRecordsStore } from '../src/context-records.store.js';
import { getPort, rawGet, recordById, waitForRecords } from './harness.js';

describe('Request context snapshots (Express, NestFactory.create)', () => {
  let app: INestApplication;
  let port: number;

  beforeEach(async () => {
    app = await NestFactory.create(AppModule, { logger: false });
    port = await getPort(app);
  });

  afterEach(async () => {
    await app?.close();
  });

  it('runs the post-response callback with the frozen marker and terminates once', async () => {
    const probe = await rawGet(port, '/context-probe?marker=m1');
    expect(probe.statusCode).toBe(200);
    const { callbackIds } = probe.body;
    expect(callbackIds).toHaveLength(1);

    // Terminated, callback parked behind its gate.
    const frozen = await waitForRecords(port, records =>
      records.some(
        record =>
          record.callbackId === callbackIds[0] && record.status === 'frozen',
      ),
    );
    const frozenRecord = recordById(frozen, callbackIds[0]);
    expect(frozenRecord.terminationReason).toBe('finish');
    expect(frozenRecord.terminationCount).toBe(1);

    await rawGet(port, '/release-gates');
    const completed = await waitForRecords(port, records =>
      records.some(
        record =>
          record.callbackId === callbackIds[0] && record.status === 'completed',
      ),
    );
    const record = recordById(completed, callbackIds[0]);
    expect(record).toMatchObject({
      marker: 'm1',
      frozenMarker: 'm1',
      terminationReason: 'finish',
      terminationCount: 1,
      consumerValue: null,
      lateWriteAccepted: false,
      lateWriteVisible: false,
      repeatedReadsConsistent: true,
    });
  });

  it('exposes the active state while the request is still in flight', async () => {
    const probePromise = rawGet(port, '/context-probe?marker=slow&delayMs=400');
    const records = await waitForRecords(port, items =>
      items.some(record => record.status === 'active'),
    );
    expect(records[0].status).toBe('active');
    expect(records[0].marker).toBe('slow');

    await probePromise;
    await rawGet(port, '/release-gates');
    await waitForRecords(port, items =>
      items.every(record => record.status === 'completed'),
    );
  });

  it('keeps independent records for identical markers and multiple registrations', async () => {
    const first = await rawGet(
      port,
      '/context-probe?marker=dup&registrations=3',
    );
    const second = await rawGet(port, '/context-probe?marker=dup');
    const ids = [...first.body.callbackIds, ...second.body.callbackIds];
    expect(new Set(ids).size).toBe(4);
    expect(first.body.contextId).not.toBe(second.body.contextId);

    await rawGet(port, '/release-gates');
    const records = await waitForRecords(
      port,
      items => items.length === 4 && items.every(r => r.status === 'completed'),
    );
    expect(records.map(r => r.marker)).toEqual(['dup', 'dup', 'dup', 'dup']);
    expect(new Set(records.map(r => r.callbackId)).size).toBe(4);
    expect(new Set(records.map(r => r.contextId)).size).toBe(2);
  });

  it('isolates concurrent requests with different markers', async () => {
    const markers = ['alpha', 'beta', 'gamma', 'delta'];
    const probes = await Promise.all(
      markers.map(marker =>
        rawGet(
          port,
          `/context-probe?marker=${marker}&registrations=2&consumerValue=cv-${marker}`,
        ),
      ),
    );
    const idToMarker = new Map<string, string>();
    probes.forEach((probe, index) =>
      probe.body.callbackIds.forEach((id: string) =>
        idToMarker.set(id, markers[index]),
      ),
    );

    await waitForRecords(
      port,
      records =>
        records.length === 8 && records.every(r => r.status === 'frozen'),
    );
    await rawGet(port, '/release-gates');
    const records = await waitForRecords(
      port,
      items => items.length === 8 && items.every(r => r.status === 'completed'),
    );

    for (const record of records) {
      const marker = idToMarker.get(record.callbackId);
      expect(record.marker).toBe(marker);
      expect(record.frozenMarker).toBe(marker);
      expect(record.consumerValue).toBe(`cv-${marker}`);
    }
  });

  it('shows values written by another consumer before termination', async () => {
    const probe = await rawGet(
      port,
      '/context-probe?marker=m2&consumerValue=written-before-freeze',
    );
    await rawGet(port, '/release-gates');
    const records = await waitForRecords(port, items =>
      items.some(
        record =>
          record.callbackId === probe.body.callbackIds[0] &&
          record.status === 'completed' &&
          record.consumerValue === 'written-before-freeze',
      ),
    );
    expect(recordById(records, probe.body.callbackIds[0]).frozenMarker).toBe(
      'm2',
    );
  });

  it('terminates snapshots for default and custom-filter error responses', async () => {
    const defaultError = await rawGet(
      port,
      '/context-probe?marker=err1&fail=request',
    );
    expect(defaultError.statusCode).toBe(400);

    const filteredError = await rawGet(
      port,
      '/context-probe?marker=err2&fail=filtered',
    );
    expect(filteredError.statusCode).toBe(422);
    expect(filteredError.body).toEqual({ filtered: true, marker: 'err2' });

    await rawGet(port, '/release-gates');
    const records = await waitForRecords(
      port,
      items => items.length === 2 && items.every(r => r.status === 'completed'),
    );
    expect(records.map(r => r.terminationReason)).toEqual(['finish', 'finish']);
    expect(records.map(r => r.terminationCount)).toEqual([1, 1]);
    expect(records.map(r => r.frozenMarker)).toEqual(['err1', 'err2']);
  });

  it('terminates the snapshot when the client aborts', async () => {
    const probe = rawGet(port, '/context-probe?marker=aborted&delayMs=3000');
    probe.req!.once('socket', () => {
      setTimeout(() => probe.req!.destroy(), 80);
    });
    probe.catch(() => {});

    const records = await waitForRecords(port, items =>
      items.some(
        record =>
          record.marker === 'aborted' &&
          record.status === 'frozen' &&
          record.terminationReason === 'abort',
      ),
    );
    const callbackId = records.find(r => r.marker === 'aborted')!.callbackId;

    await rawGet(port, '/release-gates');
    const settled = await waitForRecords(port, items =>
      items.some(
        record =>
          record.callbackId === callbackId && record.status === 'completed',
      ),
    );
    const record = recordById(settled, callbackId);
    expect(record.terminationReason).toBe('abort');
    expect(record.terminationCount).toBe(1);
    expect(record.frozenMarker).toBe('aborted');
  }, 10_000);

  it('isolates a failing callback from sibling and other-request callbacks', async () => {
    const sibling = await rawGet(
      port,
      '/context-probe?marker=group&registrations=3&failCallbackIndex=1',
    );
    const other = await rawGet(port, '/context-probe?marker=other');

    await rawGet(port, '/release-gates');
    const records = await waitForRecords(
      port,
      items =>
        items.length === 4 &&
        items.every(r => r.status !== 'active' && r.status !== 'frozen'),
    );

    const siblingRecords = sibling.body.callbackIds.map((id: string) =>
      recordById(records, id),
    );
    expect(siblingRecords[0].status).toBe('completed');
    expect(siblingRecords[1].status).toBe('failed');
    expect(siblingRecords[1].errorMessage).toContain('group');
    expect(siblingRecords[2].status).toBe('completed');

    const otherRecord = recordById(records, other.body.callbackIds[0]);
    expect(otherRecord.status).toBe('completed');
    expect(otherRecord.marker).toBe('other');
  });

  it('supports the REQUEST_CONTEXT injection token on a request-scoped controller', async () => {
    const result = await rawGet(port, '/context-echo?value=hello');
    expect(result.statusCode).toBe(200);
    expect(result.body).toMatchObject({
      attached: true,
      frozen: false,
      echoValue: 'hello',
    });
  });

  it('drains parked callbacks during shutdown and then refuses new requests', async () => {
    const probe = await rawGet(port, '/context-probe?marker=shutdown');
    await waitForRecords(port, records =>
      records.some(
        record =>
          record.callbackId === probe.body.callbackIds[0] &&
          record.status === 'frozen',
      ),
    );

    const closePromise = app.close();
    await closePromise;

    const store = app.get(ContextRecordsStore);
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
          .get({ port, path: '/context-probe?marker=rejected' }, resolve)
          .on('error', reject),
      ),
    ).rejects.toMatchObject({ code: 'ECONNREFUSED' });
  }, 15_000);

  it('does not replay records after recreating the application', async () => {
    const first = await rawGet(port, '/context-probe?marker=first-app');
    await rawGet(port, '/release-gates');
    await waitForRecords(port, records =>
      records.some(
        record =>
          record.callbackId === first.body.callbackIds[0] &&
          record.status === 'completed',
      ),
    );
    await app.close();

    app = await NestFactory.create(AppModule, { logger: false });
    port = await getPort(app);

    const second = await rawGet(port, '/context-probe?marker=second-app');
    await rawGet(port, '/release-gates');
    const records = await waitForRecords(
      port,
      items =>
        items.length === 1 &&
        items[0].marker === 'second-app' &&
        items[0].status === 'completed',
    );
    expect(records[0].contextId).not.toBe(first.body.contextId);
    expect(records.map(r => r.marker)).not.toContain('first-app');
  }, 15_000);
});
