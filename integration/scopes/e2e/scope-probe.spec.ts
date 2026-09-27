import { INestApplication, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import request from 'supertest';
import { AppModule } from '../src/scope-probe/app.module.js';
import { ProbeBusinessModule } from '../src/scope-probe/business/probe-business.module.js';
import { MissingExportAppModule } from '../src/scope-probe/failures/missing-export.module.js';
import { MissingProviderAppModule } from '../src/scope-probe/failures/missing-provider.module.js';
import { UnknownTokenAppModule } from '../src/scope-probe/failures/unknown-token.module.js';
import { ProbeCleanupStore } from '../src/scope-probe/probe-cleanup-store.js';
import { ProbeLifecycleService } from '../src/scope-probe/probe-lifecycle.service.js';
import { RequestContextService } from '../src/scope-probe/request-context.service.js';
import { ScopeProbeController } from '../src/scope-probe/scope-probe.controller.js';
import { SingletonProbeService } from '../src/scope-probe/singleton-probe.service.js';
import { TransientConsumerService } from '../src/scope-probe/transient-consumer.service.js';
import { TransientProbeService } from '../src/scope-probe/transient-probe.service.js';

const createApp = async (module: unknown = AppModule) => {
  const app = await NestFactory.create(module as any, { logger: false });
  await app.listen(0);
  return app;
};

describe('Scope probe (HTTP)', () => {
  let app: INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    app = await createApp();
    baseUrl = await app.getUrl();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('when a single request is handled', () => {
    it('should echo the marker and expose scope identities and the business value', async () => {
      const response = await request(baseUrl)
        .get('/scope-probe')
        .query({ marker: '文本' })
        .expect(200);

      expect(response.body.marker).toBe('文本');
      expect(response.body.requestId).toEqual(expect.any(String));
      expect(response.body.transientId).toEqual(expect.any(String));
      expect(response.body.singletonId).toEqual(expect.any(String));
      expect(response.body.sameConsumerTransientEqual).toBe(true);
      expect(response.body.crossConsumerTransientEqual).toBe(false);
      expect(response.body.businessValue).toBe('business:文本');
      expect(response.body.cleanup).toEqual({
        request: expect.any(Number),
        transient: expect.any(Number),
        singleton: expect.any(Number),
      });
    });
  });

  describe('when concurrent requests carry different markers', () => {
    const MARKER_COUNT = 25;
    let responses: request.Response[];

    beforeAll(async () => {
      responses = await Promise.all(
        Array.from({ length: MARKER_COUNT }, (_, index) =>
          request(baseUrl)
            .get('/scope-probe')
            .query({ marker: `marker-${index}-文本` }),
        ),
      );
    });

    it('should complete every request successfully', () => {
      expect(responses.map(response => response.status)).toEqual(
        Array.from({ length: MARKER_COUNT }, () => 200),
      );
    });

    it('should echo only the own marker and business value in each response', () => {
      const markers = responses.map(response => response.body.marker);
      expect(new Set(markers).size).toBe(MARKER_COUNT);
      responses.forEach(response => {
        expect(response.body.businessValue).toBe(
          `business:${response.body.marker}`,
        );
      });
    });

    it('should not reuse the request identity across requests', () => {
      const requestIds = responses.map(response => response.body.requestId);
      expect(new Set(requestIds).size).toBe(MARKER_COUNT);
    });

    it('should not reuse the transient identity across requests', () => {
      const transientIds = responses.map(response => response.body.transientId);
      expect(new Set(transientIds).size).toBe(MARKER_COUNT);
    });

    it('should keep the singleton identity stable across requests', () => {
      const singletonIds = responses.map(response => response.body.singletonId);
      expect(new Set(singletonIds).size).toBe(1);
    });

    it('should keep transient retrievals stable per consumer and distinguishable across consumers', () => {
      responses.forEach(response => {
        expect(response.body.sameConsumerTransientEqual).toBe(true);
        expect(response.body.crossConsumerTransientEqual).toBe(false);
      });
    });
  });

  describe('when providers and controllers are registered in a different order', () => {
    @Module({
      imports: [ProbeBusinessModule],
      controllers: [ScopeProbeController],
      providers: [
        SingletonProbeService,
        TransientConsumerService,
        TransientProbeService,
        RequestContextService,
        ProbeLifecycleService,
      ],
    })
    class ReorderedModule {}

    let reorderedApp: INestApplication;

    afterAll(async () => {
      await reorderedApp?.close();
    });

    it('should produce the same results', async () => {
      reorderedApp = await createApp(ReorderedModule);
      const response = await request(await reorderedApp.getUrl())
        .get('/scope-probe')
        .query({ marker: 'order' })
        .expect(200);

      expect(response.body.marker).toBe('order');
      expect(response.body.businessValue).toBe('business:order');
      expect(response.body.sameConsumerTransientEqual).toBe(true);
      expect(response.body.crossConsumerTransientEqual).toBe(false);
    });
  });
});

describe('Scope probe cleanup', () => {
  it('should clean up every created resource exactly once and read the results back after recreating the app', async () => {
    const before = ProbeCleanupStore.snapshot();

    const firstApp = await createApp();
    const firstUrl = await firstApp.getUrl();

    const firstResponses = await Promise.all([
      request(firstUrl).get('/scope-probe').query({ marker: 'one' }),
      request(firstUrl).get('/scope-probe').query({ marker: 'two' }),
      request(firstUrl).get('/scope-probe').query({ marker: 'three' }),
    ]);
    const firstSingletonId = firstResponses[0].body.singletonId;

    // A request racing the shutdown must not change the per-resource counts.
    let racedRequestCompleted = false;
    const inFlight = request(firstUrl)
      .get('/scope-probe')
      .query({ marker: 'race' })
      .then(() => {
        racedRequestCompleted = true;
      })
      .catch(() => undefined);

    await firstApp.close();
    await inFlight;
    // Repeated close must not clean any resource twice.
    await firstApp.close();

    const completedRequests = 3 + (racedRequestCompleted ? 1 : 0);
    const afterClose = ProbeCleanupStore.snapshot();
    expect(afterClose.request - before.request).toBe(completedRequests);
    expect(afterClose.transient - before.transient).toBe(completedRequests * 2);
    expect(afterClose.singleton - before.singleton).toBe(1);

    // The closed application must not serve the probe anymore.
    await expect(
      fetch(`${firstUrl}/scope-probe?marker=closed`),
    ).rejects.toThrow();

    // A recreated application reads back exactly the completed cleanups
    // through the same path, and receives a new singleton identity.
    const secondApp = await createApp();
    try {
      const response = await request(await secondApp.getUrl())
        .get('/scope-probe')
        .query({ marker: 'readback' })
        .expect(200);

      expect(response.body.cleanup).toEqual(afterClose);
      expect(response.body.singletonId).not.toBe(firstSingletonId);
    } finally {
      await secondApp.close();
    }
  });
});

describe('Scope probe failure boundaries', () => {
  describe.each([
    ['a missing export', MissingExportAppModule],
    ['a missing provider', MissingProviderAppModule],
    ['an unknown token', UnknownTokenAppModule],
  ])('when the module has %s', (_label, brokenModule) => {
    it('should fail creation with a dependency resolution exception', async () => {
      await expect(
        NestFactory.create(brokenModule, {
          logger: false,
          abortOnError: false,
        }),
      ).rejects.toThrow(/can't resolve dependencies/i);
    });

    it('should leave the container usable for a valid module', async () => {
      await expect(
        NestFactory.create(brokenModule, {
          logger: false,
          abortOnError: false,
        }),
      ).rejects.toThrow();

      const app = await createApp();
      try {
        const response = await request(await app.getUrl())
          .get('/scope-probe')
          .query({ marker: 'after-failure' })
          .expect(200);
        expect(response.body.marker).toBe('after-failure');
      } finally {
        await app.close();
      }
    });
  });
});
