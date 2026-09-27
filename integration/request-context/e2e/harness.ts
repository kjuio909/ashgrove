import type { INestApplication } from '@nestjs/common';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { NestFactory } from '@nestjs/core';
import * as http from 'node:http';
import type { DynamicModule, Type } from '@nestjs/common';
import { AppModule } from '../src/app.module.js';

export type HttpPlatform = 'express' | 'fastify';

/**
 * Result of a probe request issued through the raw HTTP client.
 */
export interface RawRequestResult {
  statusCode: number;
  body: any;
  rawBody: string;
  req: http.ClientRequest;
}

/**
 * Issues an HTTP GET and resolves with the parsed response. The returned
 * `req` allows tests to abort the request before it completes.
 */
export function rawGet(
  port: number,
  path: string,
  options: { headers?: Record<string, string> } = {},
): Promise<RawRequestResult> & { req?: http.ClientRequest } {
  let req: http.ClientRequest;
  const promise = new Promise<RawRequestResult>((resolve, reject) => {
    req = http.get(
      {
        port,
        path,
        headers: { Connection: 'close', ...options.headers },
      },
      res => {
        let rawBody = '';
        res.setEncoding('utf8');
        res.on('data', chunk => (rawBody += chunk));
        res.on('end', () => {
          let body: any = rawBody;
          try {
            body = rawBody ? JSON.parse(rawBody) : null;
          } catch {
            // leave body as the raw string
          }
          resolve({ statusCode: res.statusCode ?? 0, body, rawBody, req });
        });
      },
    );
    req.on('error', error => {
      const typed = error as NodeJS.ErrnoException;
      if (typed.code === 'ECONNRESET' || typed.code === 'EPIPE') {
        resolve({
          statusCode: 0,
          body: null,
          rawBody: '',
          req,
        });
        return;
      }
      reject(error);
    });
  }) as Promise<RawRequestResult> & { req?: http.ClientRequest };
  promise.req = req!;
  return promise;
}

/**
 * Polls `/async-records` until `predicate` holds or the timeout elapses.
 */
export async function waitForRecords(
  port: number,
  predicate: (records: any[]) => boolean,
  timeoutMs = 3000,
): Promise<any[]> {
  const deadline = Date.now() + timeoutMs;
  let records: any[] = [];
  while (Date.now() < deadline) {
    const result = await rawGet(port, '/async-records');
    records = result.body?.records ?? [];
    if (predicate(records)) {
      return records;
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(
    `waitForRecords timed out; last records: ${JSON.stringify(records)}`,
  );
}

export async function getPort(app: INestApplication): Promise<number> {
  await app.listen(0);
  const address = app.getHttpServer().address();
  if (typeof address === 'object' && address) {
    return address.port;
  }
  throw new Error('Expected TCP server address');
}

export function recordById(records: any[], recordId: string) {
  const record = records.find(item => item.recordId === recordId);
  if (!record) {
    throw new Error(`record ${recordId} not found`);
  }
  return record;
}

/**
 * Bootstraps the given module on the requested platform without listening.
 */
export async function createApp(
  module: Type<any> | DynamicModule = AppModule,
  platform: HttpPlatform = 'express',
  options: { abortOnError?: boolean; logger?: boolean } = {},
): Promise<INestApplication> {
  if (platform === 'fastify') {
    return NestFactory.create(module, new FastifyAdapter(), {
      logger: options.logger ? undefined : false,
      abortOnError: options.abortOnError,
    });
  }
  return NestFactory.create(module, {
    logger: options.logger ? undefined : false,
    abortOnError: options.abortOnError,
  });
}
