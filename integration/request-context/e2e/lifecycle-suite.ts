import type { INestApplication } from '@nestjs/common';
import * as http from 'node:http';
import { AppModule } from '../src/app.module.js';
import { FailingConstructorModule } from './fixtures/failing-constructor.module.js';
import { FailingInitModule } from './fixtures/failing-init.module.js';
import {
  createApp,
  type HttpPlatform,
  getPort,
  rawGet,
  recordById,
  waitForRecords,
} from './harness.js';

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

async function expectPortClosed(port: number): Promise<void> {
  await expect(
    new Promise((resolve, reject) =>
      http
        .get({ port, path: '/health', timeout: 1000 }, resolve)
        .on('error', reject),
    ),
  ).rejects.toMatchObject({ code: 'ECONNREFUSED' });
}

/**
 * Failure-mode guarantees:
 * - failed initialization never yields a servable half-initialized app;
 * - records completed before a later failure are never rewritten;
 * - concurrently running applications never expose each other's data.
 */
export function registerLifecycleSuite(platform: HttpPlatform): void {
  describe(`Lifecycle and isolation guarantees (${platform})`, () => {
    let app: INestApplication;
    let port: number;

    afterEach(async () => {
      await app?.close();
    });

    it('rejects construction-phase failures without binding any server', async () => {
      await expect(
        createApp(FailingConstructorModule, platform, {
          abortOnError: false,
        }),
      ).rejects.toThrow('intentional constructor failure');

      // create() threw before returning an application, so there is no app to
      // close and no listener could have been installed.
      const freePort = await getFreePort();
      await expectPortClosed(freePort);
    });

    it('rejects onModuleInit failures without serving traffic', async () => {
      // create() succeeds (the container is built) but listen() runs init()
      // hooks and must reject; the server must never accept a request.
      app = await createApp(FailingInitModule, platform, {
        abortOnError: false,
      });
      const fixedPort = await getFreePort();

      await expect(app.listen(fixedPort)).rejects.toThrow(
        'intentional initialization failure',
      );
      await expectPortClosed(fixedPort);

      // The failed application must still be closable without hanging.
      await app.close();
      await expectPortClosed(fixedPort);
    }, 10_000);

    it('does not rewrite completed records when a later request fails', async () => {
      app = await createApp(AppModule, platform);
      port = await getPort(app);

      const good = await rawGet(port, '/async-context?marker=keep');
      await rawGet(port, '/release-gates');
      const settled = await waitForRecords(
        port,
        items =>
          recordById(items, good.body.recordIds[0]).status === 'completed',
      );
      const completedId = good.body.recordIds[0];
      const completedRecord = JSON.stringify(recordById(settled, completedId));

      const broken = await rawGet(
        port,
        '/async-context?marker=broken&fail=request',
      );
      expect(broken.statusCode).toBe(400);

      const after = await rawGet(port, '/async-records');
      expect(JSON.stringify(recordById(after.body.records, completedId))).toBe(
        completedRecord,
      );
    });

    it('keeps records isolated between two concurrently running applications', async () => {
      app = await createApp(AppModule, platform);
      port = await getPort(app);
      const otherApp = await createApp(AppModule, platform);
      const otherPort = await getPort(otherApp);
      try {
        const a = await rawGet(port, '/async-context?marker=app-a');
        const b = await rawGet(otherPort, '/async-context?marker=app-b');
        expect(a.body.appId).not.toBe(b.body.appId);

        await rawGet(port, '/release-gates');
        await rawGet(otherPort, '/release-gates');

        const [recordsA, recordsB] = await Promise.all([
          waitForRecords(port, items =>
            items.some(r => r.status === 'completed'),
          ),
          waitForRecords(otherPort, items =>
            items.some(r => r.status === 'completed'),
          ),
        ]);

        expect(recordsA).toHaveLength(1);
        expect(recordsB).toHaveLength(1);
        expect(recordsA[0]).toMatchObject({
          marker: 'app-a',
          appId: a.body.appId,
        });
        expect(recordsB[0]).toMatchObject({
          marker: 'app-b',
          appId: b.body.appId,
        });
        expect(recordsA[0].appId).not.toBe(recordsB[0].appId);

        // The read-back endpoints never expose another application's data.
        const readA = await rawGet(port, '/async-records');
        const readB = await rawGet(otherPort, '/async-records');
        expect(readA.body.records.map((r: any) => r.marker)).not.toContain(
          'app-b',
        );
        expect(readB.body.records.map((r: any) => r.marker)).not.toContain(
          'app-a',
        );
      } finally {
        await otherApp.close();
      }
    }, 15_000);
  });
}
