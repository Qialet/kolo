#!/usr/bin/env -S node
import type { Contract as End } from '../../snapshots/77b5dc0877f7c85a2be723f83890978b3d030fd1011879e5a314a6a43c4d9bad/contract';
import endContract from '../../snapshots/77b5dc0877f7c85a2be723f83890978b3d030fd1011879e5a314a6a43c4d9bad/contract.json' with { type: 'json' };
import {
  Migration,
  MigrationCLI,
  checkExpression,
  col,
  fn,
  primaryKey,
  sql,
} from '@prisma/orm-postgres/migration';

export default class M extends Migration<never, End> {
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.createSchema({ schema: 'public' }),
      this.createTable({
        schema: 'public',
        table: 'Dispute',
        columns: [
          col('id', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('note', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('openedAt', 'timestamptz', {
            notNull: true,
            default: fn(sql`now()`),
            codecRef: { codecId: 'pg/timestamptz-string@1' },
          }),
          col('orderId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('reason', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('resolvedAt', 'timestamptz', { codecRef: { codecId: 'pg/timestamptz-string@1' } }),
          col('status', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
        ],
        constraints: [
          primaryKey(['id']),
          checkExpression(
            'Dispute_status_check_94030d34',
            sql`"status" IN ('OPEN', 'REFUNDED', 'REJECTED')`,
          ),
        ],
      }),
      this.createTable({
        schema: 'public',
        table: 'Driver',
        columns: [
          col('createdAt', 'timestamptz', {
            notNull: true,
            default: fn(sql`now()`),
            codecRef: { codecId: 'pg/timestamptz-string@1' },
          }),
          col('id', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('licenseNo', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('name', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('parkId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('phone', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('rating', 'float8', { notNull: true, codecRef: { codecId: 'pg/float8@1' } }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.createTable({
        schema: 'public',
        table: 'Order',
        columns: [
          col('cancelReason', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('code', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('createdAt', 'timestamptz', {
            notNull: true,
            default: fn(sql`now()`),
            codecRef: { codecId: 'pg/timestamptz-string@1' },
          }),
          col('distanceMeters', 'int4', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
          col('dropoffId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('dropoffLabel', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('dropoffX', 'float8', { notNull: true, codecRef: { codecId: 'pg/float8@1' } }),
          col('dropoffZ', 'float8', { notNull: true, codecRef: { codecId: 'pg/float8@1' } }),
          col('fareRsd', 'int4', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
          col('id', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('passengerName', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('pickupId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('pickupLabel', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('pickupX', 'float8', { notNull: true, codecRef: { codecId: 'pg/float8@1' } }),
          col('pickupZ', 'float8', { notNull: true, codecRef: { codecId: 'pg/float8@1' } }),
          col('source', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('status', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('updatedAt', 'timestamptz', {
            notNull: true,
            codecRef: { codecId: 'pg/timestamptz-string@1' },
          }),
          col('vehicleId', 'text', { codecRef: { codecId: 'pg/text@1' } }),
        ],
        constraints: [
          primaryKey(['id']),
          checkExpression(
            'Order_source_check_885ce13a',
            sql`"source" IN ('APP', 'PHONE', 'BUS_STOP', 'DISPATCHER')`,
          ),
          checkExpression(
            'Order_status_check_b0d6cea2',
            sql`"status" IN ('SEARCHING', 'ASSIGNED', 'ARRIVED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'NO_SHOW', 'EXPIRED')`,
          ),
        ],
      }),
      this.createTable({
        schema: 'public',
        table: 'OrderEvent',
        columns: [
          col('actor', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('at', 'timestamptz', {
            notNull: true,
            default: fn(sql`now()`),
            codecRef: { codecId: 'pg/timestamptz-string@1' },
          }),
          col('id', 'SERIAL', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
          col('note', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('orderId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('type', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('vehicleId', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('x', 'float8', { codecRef: { codecId: 'pg/float8@1' } }),
          col('z', 'float8', { codecRef: { codecId: 'pg/float8@1' } }),
        ],
        constraints: [
          primaryKey(['id']),
          checkExpression(
            'OrderEvent_actor_check_ef4f2db8',
            sql`"actor" IN ('PASSENGER', 'DRIVER', 'DISPATCHER', 'SYSTEM')`,
          ),
          checkExpression(
            'OrderEvent_type_check_99972d90',
            sql`"type" IN ('CREATED', 'OFFERED', 'OFFER_MISSED', 'ASSIGNED', 'ARRIVED', 'PICKED_UP', 'COMPLETED', 'CANCELLED', 'NO_SHOW', 'EXPIRED', 'DISPUTE_OPENED', 'DISPUTE_RESOLVED')`,
          ),
        ],
      }),
      this.createTable({
        schema: 'public',
        table: 'Park',
        columns: [
          col('address', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('capacity', 'int4', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
          col('id', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('name', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('partnerId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('serviceBoxes', 'int4', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.createTable({
        schema: 'public',
        table: 'Partner',
        columns: [
          col('color', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('createdAt', 'timestamptz', {
            notNull: true,
            default: fn(sql`now()`),
            codecRef: { codecId: 'pg/timestamptz-string@1' },
          }),
          col('id', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('name', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.createTable({
        schema: 'public',
        table: 'Vehicle',
        columns: [
          col('color', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('driverId', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('fleetStatus', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('id', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('mileageKm', 'int4', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
          col('model', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('parkId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('plate', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('updatedAt', 'timestamptz', {
            notNull: true,
            codecRef: { codecId: 'pg/timestamptz-string@1' },
          }),
          col('year', 'int4', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
        ],
        constraints: [
          primaryKey(['id']),
          checkExpression(
            'Vehicle_fleetStatus_check_73f4e219',
            sql`"fleetStatus" IN ('ON_LINE', 'IN_PARK', 'MAINTENANCE')`,
          ),
        ],
      }),
      this.createTable({
        schema: 'public',
        table: 'VehicleStatusChange',
        columns: [
          col('actor', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('at', 'timestamptz', {
            notNull: true,
            default: fn(sql`now()`),
            codecRef: { codecId: 'pg/timestamptz-string@1' },
          }),
          col('id', 'SERIAL', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
          col('status', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('vehicleId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
        ],
        constraints: [
          primaryKey(['id']),
          checkExpression(
            'VehicleStatusChange_actor_check_ef4f2db8',
            sql`"actor" IN ('PASSENGER', 'DRIVER', 'DISPATCHER', 'SYSTEM')`,
          ),
          checkExpression(
            'VehicleStatusChange_status_check_73af245e',
            sql`"status" IN ('ON_LINE', 'IN_PARK', 'MAINTENANCE')`,
          ),
        ],
      }),
      this.addUnique({
        schema: 'public',
        table: 'Driver',
        constraint: 'Driver_licenseNo_key',
        columns: ['licenseNo'],
      }),
      this.addUnique({
        schema: 'public',
        table: 'Order',
        constraint: 'Order_code_key',
        columns: ['code'],
      }),
      this.addUnique({
        schema: 'public',
        table: 'Vehicle',
        constraint: 'Vehicle_plate_key',
        columns: ['plate'],
      }),
      this.addUnique({
        schema: 'public',
        table: 'Vehicle',
        constraint: 'Vehicle_driverId_key',
        columns: ['driverId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'Dispute',
        index: 'Dispute_orderId_idx_d284871b',
        columns: ['orderId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'Dispute',
        index: 'Dispute_status_idx_e98638ab',
        columns: ['status'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'Driver',
        index: 'Driver_parkId_idx_6ba65a53',
        columns: ['parkId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'Order',
        index: 'Order_createdAt_idx_9575dbd7',
        columns: ['createdAt'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'Order',
        index: 'Order_status_idx_e98638ab',
        columns: ['status'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'Order',
        index: 'Order_vehicleId_idx_e2df58fc',
        columns: ['vehicleId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'OrderEvent',
        index: 'OrderEvent_orderId_idx_d284871b',
        columns: ['orderId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'Park',
        index: 'Park_partnerId_idx_bf5b312c',
        columns: ['partnerId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'Vehicle',
        index: 'Vehicle_fleetStatus_idx_74716b0e',
        columns: ['fleetStatus'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'Vehicle',
        index: 'Vehicle_parkId_idx_6ba65a53',
        columns: ['parkId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'VehicleStatusChange',
        index: 'VehicleStatusChange_vehicleId_idx_e2df58fc',
        columns: ['vehicleId'],
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'Dispute',
        foreignKey: {
          name: 'Dispute_orderId_fkey',
          columns: ['orderId'],
          references: { schema: 'public', table: 'Order', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'Driver',
        foreignKey: {
          name: 'Driver_parkId_fkey',
          columns: ['parkId'],
          references: { schema: 'public', table: 'Park', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'Order',
        foreignKey: {
          name: 'Order_vehicleId_fkey',
          columns: ['vehicleId'],
          references: { schema: 'public', table: 'Vehicle', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'OrderEvent',
        foreignKey: {
          name: 'OrderEvent_orderId_fkey',
          columns: ['orderId'],
          references: { schema: 'public', table: 'Order', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'Park',
        foreignKey: {
          name: 'Park_partnerId_fkey',
          columns: ['partnerId'],
          references: { schema: 'public', table: 'Partner', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'Vehicle',
        foreignKey: {
          name: 'Vehicle_parkId_fkey',
          columns: ['parkId'],
          references: { schema: 'public', table: 'Park', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'Vehicle',
        foreignKey: {
          name: 'Vehicle_driverId_fkey',
          columns: ['driverId'],
          references: { schema: 'public', table: 'Driver', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'VehicleStatusChange',
        foreignKey: {
          name: 'VehicleStatusChange_vehicleId_fkey',
          columns: ['vehicleId'],
          references: { schema: 'public', table: 'Vehicle', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
