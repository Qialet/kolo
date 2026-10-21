import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { db } from '../prisma/db.js';

/** Owns the single Prisma 8 client (one connection pool per process). */
@Injectable()
export class DatabaseService implements OnModuleDestroy {
  readonly db = db;

  /** ORM models of the default `public` namespace. */
  get orm() {
    return db.orm.public;
  }

  async onModuleDestroy() {
    await db.close();
  }
}
