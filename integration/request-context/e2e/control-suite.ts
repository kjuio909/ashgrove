import type { INestApplication } from '@nestjs/common';
import { ControlAppModule } from '../src/control-app.module.js';
import { createApp, type HttpPlatform, getPort, rawGet } from './harness.js';

/**
 * Behavioral suite for the plain control application that does NOT import
 * `RequestContextModule`. It proves the feature is opt-in and existing
 * behavior is untouched, on both platforms.
 */
export function registerControlSuite(platform: HttpPlatform): void {
  describe(`Control application without request context (${platform})`, () => {
    let app: INestApplication;
    let port: number;

    beforeEach(async () => {
      app = await createApp(ControlAppModule, platform);
      port = await getPort(app);
    });

    afterEach(async () => {
      await app?.close();
    });

    it('reuses the same routes and reports the feature as disabled', async () => {
      const first = await rawGet(port, '/async-context?marker=plain');
      const second = await rawGet(port, '/async-context?marker=plain-2');

      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(200);
      for (const result of [first, second]) {
        expect(result.body).toMatchObject({ contextEnabled: false });
        expect(result.body.contextId).toBeUndefined();
        expect(result.body.recordIds).toBeUndefined();
      }
    });

    it('keeps the original singleton identity stable for the app lifetime', async () => {
      const responses: any[] = [];
      for (let i = 0; i < 5; i++) {
        responses.push(
          (await rawGet(port, `/async-context?marker=s${i}`)).body,
        );
      }
      const ids = new Set(responses.map(r => r.singletonId));
      expect(ids.size).toBe(1);
      expect(responses.map(r => r.singletonHit)).toEqual([1, 2, 3, 4, 5]);

      const health = await rawGet(port, '/health');
      expect(health.body.singletonId).toBe(responses[0].singletonId);
    });

    it('produces no context records and does not fail on the read-back route', async () => {
      await rawGet(port, '/async-context?marker=plain');
      await rawGet(port, '/async-context?marker=plain-2');
      const records = await rawGet(port, '/async-records');
      expect(records.statusCode).toBe(200);
      expect(records.body.records).toEqual([]);
      expect(records.body.appId).toEqual(expect.any(String));
    });

    it('keeps the existing exception filter status and body unchanged', async () => {
      const filtered = await rawGet(
        port,
        '/async-context?marker=ferr&fail=filtered',
      );
      expect(filtered.statusCode).toBe(422);
      expect(filtered.body).toEqual({ filtered: true, marker: 'ferr' });

      const standard = await rawGet(port, '/async-context?fail=request');
      expect(standard.statusCode).toBe(400);
      expect(standard.body).toMatchObject({
        statusCode: 400,
        message: 'intentional controller failure',
        error: 'Bad Request',
      });

      // No records even after error responses.
      const records = await rawGet(port, '/async-records');
      expect(records.body.records).toEqual([]);
    });

    it('gets a fresh singleton when the application is recreated', async () => {
      const first = await rawGet(port, '/async-context?marker=old');
      await app.close();

      app = await createApp(ControlAppModule, platform);
      port = await getPort(app);
      const second = await rawGet(port, '/async-context?marker=new');

      expect(second.body.singletonId).not.toBe(first.body.singletonId);
      expect(second.body.singletonHit).toBe(1);
      expect(second.body.appId).not.toBe(first.body.appId);
    }, 15_000);
  });
}
