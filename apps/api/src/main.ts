import 'dotenv/config';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix('api');
  app.enableCors({ origin: process.env['WEB_ORIGIN']?.split(',') ?? true });
  app.enableShutdownHooks();
  const port = Number(process.env['PORT'] ?? 4000);
  await app.listen(port);
  Logger.log(`Kolo API on http://localhost:${port}/api`, 'Bootstrap');
}
await bootstrap();
