import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import * as http from 'node:http';
import { AppModule } from '../src/app.module.js';
import { ContextRecordsStore } from '../src/context-records.store.js';
import { getPort, rawGet, recordById, waitForRecords } from './harness.js';

describe('Request context snapshots (Fastify adapter)', () => {
  let app: NestFastifyApplication;
  let port: number;

  beforeEach(async () => {
    app = await NestFactory.create<NestFastifyApplication>(
      AppModule,
      new FastifyAdapter(),
      { logger: false },
    );
    port = await getPort(app);
  });

  afterEach(async () => {
    await app?.close();
  });

  it('runs the post-response callback with the frozen marker and terminates once', async () => {
    const probe = await rawGet(port, '/context-probe?marker=fastify-m1');
    expect(probe.statusCode).toBe(200);
    const [callbackId] = probe.body.callbackIds;

    const frozen = await waitForRecords(port, records =>
      records.some(
        record =>
          record.callbackId === callbackId && record.status === 'frozen',
      ),
    );
    expect(recordById(frozen, callbackId).terminationReason).toBe('finish');

    await rawGet(port, '/release-gates');
    const records = await waitForRecords(port, items =>
      items.some(
        record =>
          record.callbackId === callbackId &&
          record.status === 'completed' &&
          record.repeatedReadsConsistent === true &&
          record.lateWriteAccepted === false,
      ),
    );
    expect(recordById(records, callbackId).frozenMarker).toBe('fastify-m1');
  });

  it('isolates concurrent requests with different markers', async () => {
    const markers = ['one', 'two', 'three'];
    const probes = await Promise.all(
      markers.map(marker =>
        rawGet(port, `/context-probe?marker=${marker}&consumerValue=${marker}`),
      ),
    );
    const idToMarker = new Map<string, string>();
    probes.forEach((probe, index) =>
      idToMarker.set(probe.body.callbackIds[0], markers[index]),
    );

    await rawGet(port, '/release-gates');
    const records = await waitForRecords(
      port,
      items => items.length === 3 && items.every(r => r.status === 'completed'),
    );
    for (const record of records) {
      const marker = idToMarker.get(record.callbackId);
      expect(record.frozenMarker).toBe(marker);
      expect(record.consumerValue).toBe(marker);
      expect(record.terminationCount).toBe(1);
    }
  });

  it('terminates snapshots for default and custom-filter error responses', async () => {
    const defaultError = await rawGet(
      port,
      '/context-probe?marker=ferr0&fail=request',
    );
    expect(defaultError.statusCode).toBe(400);

    const filtered = await rawGet(
      port,
      '/context-probe?marker=ferr&fail=filtered',
    );
    expect(filtered.statusCode).toBe(422);
    expect(filtered.body).toEqual({ filtered: true, marker: 'ferr' });

    await rawGet(port, '/release-gates');
    const records = await waitForRecords(
      port,
      items => items.length === 2 && items.every(r => r.status === 'completed'),
    );
    expect(records.map(r => r.terminationReason)).toEqual(['finish', 'finish']);
    expect(records.map(r => r.terminationCount)).toEqual([1, 1]);
    expect(records.map(r => r.frozenMarker)).toEqual(['ferr0', 'ferr']);
  });

  it('terminates the snapshot when the client aborts', async () => {
    const probe = rawGet(port, '/context-probe?marker=fabort&delayMs=3000');
    probe.catch(() => {});
    setTimeout(() => probe.req!.destroy(), 80);

    const records = await waitForRecords(port, items =>
      items.some(
        record =>
          record.marker === 'fabort' &&
          record.status === 'frozen' &&
          record.terminationReason === 'abort',
      ),
    );
    const callbackId = records.find(r => r.marker === 'fabort')!.callbackId;

    await rawGet(port, '/release-gates');
    const settled = await waitForRecords(port, items =>
      items.some(
        record =>
          record.callbackId === callbackId && record.status === 'completed',
      ),
    );
    expect(recordById(settled, callbackId)).toMatchObject({
      terminationReason: 'abort',
      terminationCount: 1,
      frozenMarker: 'fabort',
    });
  }, 10_000);

  it('drains parked callbacks during shutdown and then refuses new requests', async () => {
    const probe = await rawGet(port, '/context-probe?marker=fshutdown');
    await waitForRecords(port, records =>
      records.some(
        record =>
          record.callbackId === probe.body.callbackIds[0] &&
          record.status === 'frozen',
      ),
    );

    await app.close();

    const store = app.get(ContextRecordsStore);
    const [record] = store.getAll();
    expect(record).toMatchObject({
      marker: 'fshutdown',
      frozenMarker: 'fshutdown',
      status: 'completed',
    });

    await expect(
      new Promise((resolve, reject) =>
        http.get({ port, path: '/health' }, resolve).on('error', reject),
      ),
    ).rejects.toMatchObject({ code: 'ECONNREFUSED' });
  }, 15_000);
});
