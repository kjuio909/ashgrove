import { type INestApplication, type Type } from '@nestjs/common';
import * as http from 'node:http';
import {
  ContextAppModule,
  ContextAppModuleReversed,
} from '../src/context-app/context-app.module.js';
import { FailingInitModule } from '../src/context-app/failing-init.module.js';
import { FailingLifecycleModule } from '../src/context-app/failing-lifecycle.module.js';
import { AsyncRecordsStore } from '../src/shared/async-records.store.js';
import {
  getPort,
  rawGet,
  recordById,
  waitForConnectionRefused,
  waitForRecords,
} from './harness.js';

export type NestAppFactory = (module: Type<any>) => Promise<INestApplication>;

/**
 * Defines the full context-enabled application suite for one HTTP platform.
 * The factory hides Express/Fastify bootstrap differences.
 */
export function defineContextAppSuites(
  platform: string,
  createApp: NestAppFactory,
): void {
  defineSuite(ContextAppModule, platform, createApp);
  defineSuite(
    ContextAppModuleReversed,
    `${platform} (reversed registration order)`,
    createApp,
  );

  describe(`${platform}: initialization failures leave no serviceable app`, () => {
    it('rejects bootstrap and a fresh application afterwards starts clean', async () => {
      await expect(createApp(FailingInitModule)).rejects.toThrow(
        /intentional initialization failure/,
      );

      const app = await createApp(ContextAppModule);
      const port = await getPort(app);
      try {
        const probe = await rawGet(
          port,
          `/async-context?marker=${encodeURIComponent('after-failure')}`,
        );
        expect(probe.statusCode).toBe(200);
        expect(probe.body.marker).toBe('after-failure');

        // The fresh application started from an empty record set: the failed
        // bootstrap left no records behind.
        await rawGet(port, '/release-gates');
        const records = await waitForRecords(
          port,
          items => items.length === 1 && items[0].status === 'completed',
        );
        expect(records[0].marker).toBe('after-failure');
      } finally {
        await app.close();
      }
    }, 15_000);

    it('closes the partially created server when a lifecycle hook fails on listen', async () => {
      const app = await createApp(FailingLifecycleModule);
      await expect(app.listen(0)).rejects.toThrow(
        /intentional lifecycle failure/,
      );

      // The HTTP server created by the failed bootstrap is already closed:
      // it no longer reports a bound address and the instance can be
      // disposed without leaving a listening socket behind.
      const server = app.getHttpServer() as import('node:http').Server;
      expect(server.address()).toBeNull();
      await app.close();

      const fresh = await createApp(ContextAppModule);
      const freshPort = await getPort(fresh);
      try {
        const probe = await rawGet(freshPort, '/async-context?marker=clean');
        expect(probe.statusCode).toBe(200);
        await rawGet(freshPort, '/release-gates');
        await waitForRecords(
          freshPort,
          items => items.length === 1 && items[0].status === 'completed',
        );
      } finally {
        await fresh.close();
      }
    }, 15_000);
  });
}

function defineSuite(
  module: Type<any>,
  label: string,
  createApp: NestAppFactory,
): void {
  describe(`${label}: request context snapshots`, () => {
    let app: INestApplication | undefined;
    let port: number;

    beforeEach(async () => {
      app = await createApp(module);
      port = await getPort(app);
    });

    afterEach(async () => {
      if (app) {
        await app.close();
        app = undefined;
      }
    });

    it('writes the marker, reads it across an await and stays on the current request', async () => {
      const probe = await rawGet(
        port,
        `/async-context?marker=${encodeURIComponent('文本')}`,
      );
      expect(probe.statusCode).toBe(200);
      expect(probe.body).toMatchObject({
        contextId: expect.any(String),
        marker: '文本',
        readConsistent: true,
        belongsToCurrentRequest: true,
      });
      expect(probe.body.continuationIds).toHaveLength(1);

      await rawGet(port, '/release-gates');
      const records = await waitForRecords(
        port,
        items => items.length === 1 && items[0].status === 'completed',
      );
      expect(records[0]).toMatchObject({
        contextId: probe.body.contextId,
        marker: '文本',
        frozenValue: '文本',
        frozenValueStable: true,
        lateWriteAccepted: false,
        errorMessage: null,
      });
    });

    it('reports pending while the continuation has not ended', async () => {
      const probe = await rawGet(port, '/async-context?marker=pending-marker');
      expect(probe.statusCode).toBe(200);

      // Response already finished, continuation parked behind its gate: the
      // readback must report pending rather than a terminal state.
      const pending = await waitForRecords(
        port,
        items => items.length === 1 && items[0].status === 'pending',
      );
      expect(pending[0]).toMatchObject({
        marker: 'pending-marker',
        frozenValue: null,
        errorMessage: null,
      });

      await rawGet(port, '/release-gates');
      const settled = await waitForRecords(
        port,
        items => items.length === 1 && items[0].status !== 'pending',
      );
      expect(settled[0].status).toBe('completed');
    });

    it('isolates concurrent requests carrying different markers', async () => {
      const markers = ['alpha', 'beta', 'gamma', 'δ', '最后'];
      const probes = await Promise.all(
        markers.map(marker =>
          rawGet(
            port,
            `/async-context?marker=${encodeURIComponent(marker)}&registrations=2`,
          ),
        ),
      );

      probes.forEach((probe, index) => {
        expect(probe.statusCode).toBe(200);
        expect(probe.body.marker).toBe(markers[index]);
        expect(probe.body.belongsToCurrentRequest).toBe(true);
        // No response may leak another request's context id.
        probes.forEach(other => {
          if (other !== probe) {
            expect(other.body.contextId).not.toBe(probe.body.contextId);
          }
        });
      });

      const idToMarker = new Map<string, string>();
      probes.forEach((probe, index) =>
        probe.body.continuationIds.forEach((id: string) =>
          idToMarker.set(id, markers[index]),
        ),
      );

      await rawGet(port, '/release-gates');
      const records = await waitForRecords(
        port,
        items =>
          items.length === markers.length * 2 &&
          items.every(item => item.status === 'completed'),
      );
      for (const record of records) {
        expect(record.marker).toBe(idToMarker.get(record.id));
        expect(record.frozenValue).toBe(idToMarker.get(record.id));
      }
    });

    it('never merges identical markers, repeated requests or multiple registrations', async () => {
      const first = await rawGet(
        port,
        '/async-context?marker=dup&registrations=3',
      );
      const second = await rawGet(port, '/async-context?marker=dup');
      const ids = [
        ...first.body.continuationIds,
        ...second.body.continuationIds,
      ];
      expect(new Set(ids).size).toBe(4);
      expect(first.body.contextId).not.toBe(second.body.contextId);

      await rawGet(port, '/release-gates');
      const records = await waitForRecords(
        port,
        items =>
          items.length === 4 && items.every(r => r.status === 'completed'),
      );
      expect(records.map(r => r.marker)).toEqual(['dup', 'dup', 'dup', 'dup']);
      expect(new Set(records.map(r => r.id)).size).toBe(4);
      expect(new Set(records.map(r => r.contextId)).size).toBe(2);
    });

    it('freezes the marker at termination and rejects later writes', async () => {
      const probe = await rawGet(port, '/async-context?marker=frozen');
      const [id] = probe.body.continuationIds;

      await rawGet(port, '/release-gates');
      const records = await waitForRecords(port, items =>
        items.some(r => r.id === id && r.status === 'completed'),
      );
      const record = recordById(records, id);
      expect(record.frozenValue).toBe('frozen');
      expect(record.frozenValueStable).toBe(true);
      expect(record.lateWriteAccepted).toBe(false);
    });

    it('keeps a failing continuation limited to its own record', async () => {
      const group = await rawGet(
        port,
        '/async-context?marker=group&registrations=3&failCallbackIndex=1',
      );
      const other = await rawGet(port, '/async-context?marker=other');

      // The failing continuation does not take the application down.
      const health = await rawGet(port, '/health');
      expect(health.statusCode).toBe(200);

      await rawGet(port, '/release-gates');
      const records = await waitForRecords(
        port,
        items => items.length === 4 && items.every(r => r.status !== 'pending'),
      );

      const groupRecords = group.body.continuationIds.map((id: string) =>
        recordById(records, id),
      );
      expect(groupRecords[0].status).toBe('completed');
      expect(groupRecords[1].status).toBe('failed');
      expect(groupRecords[1].errorMessage).toContain('group');
      expect(groupRecords[1].frozenValue).toBeNull();
      expect(groupRecords[2].status).toBe('completed');

      const otherRecord = recordById(records, other.body.continuationIds[0]);
      expect(otherRecord.status).toBe('completed');
      expect(otherRecord.marker).toBe('other');
      expect(otherRecord.errorMessage).toBeNull();

      // Settled records are terminal: waiting longer and re-reading never
      // rewrites a completed record, and the failed one stays failed.
      await rawGet(port, '/release-gates');
      await new Promise(resolve => setTimeout(resolve, 30));
      const reread = (await rawGet(port, '/async-records')).body.records;
      expect(recordById(reread, group.body.continuationIds[0]).status).toBe(
        'completed',
      );
      expect(recordById(reread, group.body.continuationIds[1]).status).toBe(
        'failed',
      );
      expect(recordById(reread, other.body.continuationIds[0]).status).toBe(
        'completed',
      );
    });

    it('never exposes records of another application running in the same process', async () => {
      const otherApp = await createApp(module);
      const otherPort = await getPort(otherApp);
      try {
        const probe = await rawGet(port, '/async-context?marker=app-a');
        expect(probe.statusCode).toBe(200);

        // While app A's continuation is pending, app B's readback is empty.
        await waitForRecords(
          port,
          items => items.length === 1 && items[0].status === 'pending',
        );
        const otherEmpty = await rawGet(otherPort, '/async-records');
        expect(otherEmpty.body.records).toEqual([]);

        // A request/continuation on B stays invisible on A.
        const otherProbe = await rawGet(
          otherPort,
          '/async-context?marker=app-b',
        );
        const aRecordsWhileBRuns = await waitForRecords(
          port,
          items => items.length === 1,
        );
        expect(aRecordsWhileBRuns.map(r => r.marker)).toEqual(['app-a']);

        await rawGet(port, '/release-gates');
        await rawGet(otherPort, '/release-gates');
        const bRecords = await waitForRecords(
          otherPort,
          items => items.length === 1 && items[0].status === 'completed',
        );
        expect(bRecords.map(r => r.marker)).toEqual(['app-b']);

        const aRecords = (await rawGet(port, '/async-records')).body.records;
        expect(aRecords.map(r => r.marker)).toEqual(['app-a']);
        expect(otherProbe.body.contextId).not.toBe(probe.body.contextId);
      } finally {
        await otherApp.close();
      }
    }, 10_000);

    it('terminates snapshots for default and custom-filter error responses', async () => {
      const defaultError = await rawGet(
        port,
        '/async-context?marker=err1&fail=request',
      );
      expect(defaultError.statusCode).toBe(400);

      const filteredError = await rawGet(
        port,
        `/async-context?marker=${encodeURIComponent('err-文本')}&fail=filtered`,
      );
      expect(filteredError.statusCode).toBe(422);
      expect(filteredError.body).toEqual({
        filtered: true,
        marker: 'err-文本',
      });

      await rawGet(port, '/release-gates');
      const records = await waitForRecords(
        port,
        items =>
          items.length === 2 && items.every(r => r.status === 'completed'),
      );
      expect(records.map(r => r.marker)).toEqual(['err1', 'err-文本']);
      expect(records.map(r => r.frozenValue)).toEqual(['err1', 'err-文本']);
    });

    it('freezes the marker when the client aborts and still runs the continuation', async () => {
      const probe = rawGet(port, '/async-context?marker=aborted&delayMs=3000');
      probe.catch(() => {});
      probe.req!.once('socket', () => {
        setTimeout(() => probe.req!.destroy(), 80);
      });

      const records = await waitForRecords(port, items =>
        items.some(
          record => record.marker === 'aborted' && record.status === 'pending',
        ),
      );
      const id = records.find(r => r.marker === 'aborted')!.id;

      await rawGet(port, '/release-gates');
      const settled = await waitForRecords(port, items =>
        items.some(record => record.id === id && record.status === 'completed'),
      );
      expect(recordById(settled, id).frozenValue).toBe('aborted');
    }, 10_000);

    it('injects the current snapshot through REQUEST_CONTEXT request-scoped providers', async () => {
      const single = await rawGet(port, '/context-echo?value=hello');
      expect(single.statusCode).toBe(200);
      expect(single.body).toMatchObject({
        attached: true,
        frozen: false,
        echoValue: 'hello',
      });

      // Concurrent requests get independent provider instances, each bound
      // to its own snapshot: values and context ids never cross.
      const echoes = await Promise.all(
        ['echo-a', 'echo-b', 'echo-c'].map(value =>
          rawGet(port, `/context-echo?value=${value}`),
        ),
      );
      const ids = new Set<string>();
      echoes.forEach((result, index) => {
        expect(result.statusCode).toBe(200);
        expect(result.body.echoValue).toBe(`echo-${'abc'[index]}`);
        expect(result.body.frozen).toBe(false);
        ids.add(result.body.contextId);
      });
      expect(ids.size).toBe(3);
    });

    it('drains parked continuations during shutdown and then refuses requests', async () => {
      const probe = await rawGet(port, '/async-context?marker=shutdown');
      await waitForRecords(
        port,
        items => items.length === 1 && items[0].status === 'pending',
      );

      const closingApp = app!;
      const closingPort = port;
      await closingApp.close();
      app = undefined;

      // Completed during shutdown drain, never rewritten afterwards.
      const [record] = closingApp.get(AsyncRecordsStore).getAll();
      expect(record).toMatchObject({
        marker: 'shutdown',
        frozenValue: 'shutdown',
        status: 'completed',
      });

      await waitForConnectionRefused(closingPort);
      await expect(
        new Promise((resolve, reject) =>
          http
            .get({ port: closingPort, path: '/health' }, resolve)
            .on('error', reject),
        ),
      ).rejects.toMatchObject({ code: 'ECONNREFUSED' });
    }, 15_000);

    it('does not replay records after closing and recreating the application', async () => {
      const first = await rawGet(port, '/async-context?marker=first-app');
      await rawGet(port, '/release-gates');
      await waitForRecords(
        port,
        items => items.length === 1 && items[0].status === 'completed',
      );
      const firstContextId = first.body.contextId;
      await app!.close();
      app = undefined;
      await waitForConnectionRefused(port);

      const secondApp = await createApp(module);
      const secondPort = await getPort(secondApp);
      app = secondApp;
      port = secondPort;

      const second = await rawGet(port, '/async-context?marker=second-app');
      expect(second.statusCode).toBe(200);
      expect(second.body.contextId).not.toBe(firstContextId);

      await rawGet(port, '/release-gates');
      const records = await waitForRecords(
        port,
        items => items.length === 1 && items[0].status === 'completed',
      );
      expect(records[0].marker).toBe('second-app');
      expect(records[0].contextId).not.toBe(firstContextId);
      expect(records.map(r => r.frozenValue)).not.toContain('first-app');
    }, 15_000);
  });
}
