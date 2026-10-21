import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';

// Needs the local Postgres from .env (see CLAUDE.md).
describe('Kolo API (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /api/health', () => request(app.getHttpServer()).get('/api/health').expect(200).expect({ ok: true, service: 'kolo-api' }));

  it('GET /api/fleet/parks lists the three partner depots', async () => {
    const res = await request(app.getHttpServer()).get('/api/fleet/parks').expect(200);
    expect(res.body.map((p: { id: string }) => p.id)).toEqual(['P1', 'P2', 'P3']);
  });
});
