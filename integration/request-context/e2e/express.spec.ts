import { NestFactory } from '@nestjs/core';
import { defineContextAppSuites } from './context-app.suite.js';
import { definePlainAppSuites } from './plain-app.suite.js';

const createExpressApp = (module: any) =>
  NestFactory.create(module, { logger: false, abortOnError: false });

defineContextAppSuites('Express', createExpressApp);
definePlainAppSuites('Express', createExpressApp);
