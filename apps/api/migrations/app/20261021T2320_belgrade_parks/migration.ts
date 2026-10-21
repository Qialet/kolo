#!/usr/bin/env -S node
import type { Contract as Start } from '../../snapshots/77b5dc0877f7c85a2be723f83890978b3d030fd1011879e5a314a6a43c4d9bad/contract';
import startContract from '../../snapshots/77b5dc0877f7c85a2be723f83890978b3d030fd1011879e5a314a6a43c4d9bad/contract.json' with { type: 'json' };
import type { Contract as End } from '../../snapshots/ea5738ed20458e9b28007e65980cc46dc9eef8078795646bda863a3144fd8b8e/contract';
import endContract from '../../snapshots/ea5738ed20458e9b28007e65980cc46dc9eef8078795646bda863a3144fd8b8e/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, col, rawSql } from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.addColumn({
        schema: 'public',
        table: 'Park',
        column: col('x', 'float8', { codecRef: { codecId: 'pg/float8@1' } }),
      }),
      this.addColumn({
        schema: 'public',
        table: 'Park',
        column: col('z', 'float8', { codecRef: { codecId: 'pg/float8@1' } }),
      }),
      // Orders of the procedural city point at addresses and coordinates that no longer exist
      // (demo data): drop them with their events and disputes (ON DELETE CASCADE).
      rawSql({
        id: 'data.public.Order.reset-procedural-city',
        label: 'Delete orders of the procedural city',
        summary: 'Deletes every order; events and disputes go with them',
        operationClass: 'destructive',
        target: { id: 'postgres', details: { schema: 'public', objectType: 'table', name: 'Order' } },
        precheck: [],
        execute: [{ description: 'delete all orders', sql: 'DELETE FROM "public"."Order"', params: [] }],
        postcheck: [{ description: 'verify no orders are left', sql: 'SELECT NOT EXISTS (SELECT 1 FROM "public"."Order") AS "result"', params: [] }],
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
