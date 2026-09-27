import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { defineContextAppSuites } from './context-app.suite.js';
import { definePlainAppSuites } from './plain-app.suite.js';

const createFastifyApp = (module: any) =>
  NestFactory.create<NestFastifyApplication>(module, new FastifyAdapter(), {
    logger: false,
    abortOnError: false,
  });

defineContextAppSuites('Fastify', createFastifyApp);
definePlainAppSuites('Fastify', createFastifyApp);
