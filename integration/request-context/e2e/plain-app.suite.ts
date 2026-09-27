import { type INestApplication, type Type } from '@nestjs/common';
import {
  PlainAppModule,
  PlainAppModuleReversed,
} from '../src/plain-app/plain-app.module.js';
import { getPort, rawGet } from './harness.js';
import type { NestAppFactory } from './context-app.suite.js';

/**
 * Defines the suite for the ordinary application that does NOT import
 * `RequestContextModule`, for one HTTP platform.
 */
export function definePlainAppSuites(
  platform: string,
  createApp: NestAppFactory,
): void {
  defineSuite(PlainAppModule, platform, createApp);
  defineSuite(
    PlainAppModuleReversed,
    `${platform} (reversed registration order)`,
    createApp,
  );
}

function defineSuite(
  module: Type<any>,
  label: string,
  createApp: NestAppFactory,
): void {
  describe(`${label}: application without RequestContextModule`, () => {
    let app: INestApplication;
    let port: number;

    beforeEach(async () => {
      app = await createApp(module);
      port = await getPort(app);
    });

    afterEach(async () => {
      await app?.close();
    });

    it('handles the same route without a context and without failing', async () => {
      const first = await rawGet(
        port,
        `/async-context?marker=${encodeURIComponent('文本')}`,
      );
      expect(first.statusCode).toBe(200);
      expect(first.body).toMatchObject({
        marker: '文本',
        contextAttached: false,
        singletonId: expect.any(String),
      });

      // Concurrent requests still get a normal response each.
      const markers = ['a', 'b', 'c'];
      const results = await Promise.all(
        markers.map(marker => rawGet(port, `/async-context?marker=${marker}`)),
      );
      for (const [index, result] of results.entries()) {
        expect(result.statusCode).toBe(200);
        expect(result.body.marker).toBe(markers[index]);
        expect(result.body.contextAttached).toBe(false);
      }
    });

    it('keeps the singleton identity stable for the whole application lifetime', async () => {
      const first = await rawGet(port, '/async-context?marker=one');
      const second = await rawGet(port, '/async-context?marker=two');
      const third = await rawGet(port, '/health');

      expect(second.body.singletonId).toBe(first.body.singletonId);
      expect(third.body.singletonId).toBe(first.body.singletonId);
    });

    it('preserves the existing default exception filter behavior', async () => {
      const missing = await rawGet(port, '/async-context');
      expect(missing.statusCode).toBe(400);
      expect(missing.body.statusCode).toBe(400);
      expect(missing.body.message).toContain('marker');

      const failing = await rawGet(
        port,
        '/async-context?marker=x&fail=request',
      );
      expect(failing.statusCode).toBe(400);
      expect(failing.body.statusCode).toBe(400);
      expect(failing.body.message).toContain('intentional');
    });

    it('preserves the registered custom exception filter status and body', async () => {
      const filtered = await rawGet(
        port,
        `/async-context?marker=${encodeURIComponent('过滤')}&fail=filtered`,
      );
      expect(filtered.statusCode).toBe(422);
      expect(filtered.body).toEqual({ filtered: true, marker: '过滤' });
    });

    it('never produces continuation records', async () => {
      await Promise.all([
        rawGet(port, '/async-context?marker=r1'),
        rawGet(port, '/async-context?marker=r2'),
        rawGet(port, '/async-context?marker=r3&fail=filtered'),
      ]);
      // Give any (incorrectly) scheduled continuation a chance to run.
      await new Promise(resolve => setTimeout(resolve, 30));
      const records = await rawGet(port, '/async-records');
      expect(records.statusCode).toBe(200);
      expect(records.body.records).toEqual([]);
    });

    it('gets a fresh singleton identity after the application is recreated', async () => {
      const first = await rawGet(port, '/async-context?marker=before');
      const oldId = first.body.singletonId;
      await app.close();

      app = await createApp(module);
      port = await getPort(app);
      const second = await rawGet(port, '/async-context?marker=after');
      expect(second.body.singletonId).not.toBe(oldId);
      expect((await rawGet(port, '/async-records')).body.records).toEqual([]);
    }, 15_000);
  });
}
