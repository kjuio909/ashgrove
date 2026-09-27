import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';

async function bootstrap() {
  // The public entry point: the snapshot capability is self-contained in the
  // imported module.
  const app = await NestFactory.create(AppModule);
  await app.listen(3000);
}
void bootstrap();
