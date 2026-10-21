import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type {
  Actor,
  CreateOrderInput,
  DisputeDto,
  DisputeStatus,
  OrderDto,
  OrderEventDto,
  OrderEventType,
  OrderListQuery,
  OrderSource,
  OrderStatus,
  ResolveDisputeInput,
} from '@kolo/contracts';
import { toIso } from '../common/time.js';
import { DatabaseService } from '../database/database.service.js';
import { SimulationService } from '../simulation/simulation.service.js';

type OrderRow = {
  id: string;
  code: string;
  status: string;
  source: string;
  passengerName: string;
  pickupId: string;
  pickupLabel: string;
  pickupX: number;
  pickupZ: number;
  dropoffId: string;
  dropoffLabel: string;
  dropoffX: number;
  dropoffZ: number;
  vehicleId: string | null;
  fareRsd: number;
  distanceMeters: number;
  cancelReason: string | null;
  createdAt: string;
  updatedAt: string;
  vehicle?: { plate: string } | null;
};

type DisputeRow = { id: string; reason: string; status: string; note: string | null; openedAt: string; resolvedAt: string | null };

@Injectable()
export class OrdersService {
  constructor(
    private readonly database: DatabaseService,
    private readonly simulation: SimulationService,
  ) {}

  async list(q: OrderListQuery): Promise<OrderDto[]> {
    const orm = this.database.orm;
    const statuses = q.status?.split(',').filter(Boolean) as OrderStatus[] | undefined;
    let query = orm.Order.include('vehicle');
    if (statuses?.length) query = query.where((o) => o.status.in(statuses));
    if (q.vehicleId) query = query.where({ vehicleId: q.vehicleId });
    const rows = await query.orderBy((o) => o.createdAt.desc()).limit(q.limit).all();
    return rows.map((r) => this.toDto(r));
  }

  async get(id: string): Promise<OrderDto> {
    const row = await this.database.orm.Order.where({ id })
      .include('vehicle')
      .include('events', (e) => e.orderBy((x) => x.id.asc()))
      .include('disputes', (d) => d.orderBy((x) => x.openedAt.asc()))
      .first();
    if (!row) throw new NotFoundException('Order not found');
    return {
      ...this.toDto(row),
      events: row.events.map(
        (e): OrderEventDto => ({
          id: String(e.id),
          type: e.type as OrderEventType,
          actor: e.actor as Actor,
          note: e.note,
          vehicleId: e.vehicleId,
          x: e.x,
          z: e.z,
          at: toIso(e.at)!,
        }),
      ),
      disputes: row.disputes.map((d) => this.disputeDto(d)),
    };
  }

  create(input: CreateOrderInput) {
    const order = this.simulation.sim.createOrder({
      pickupId: input.pickupAddressId,
      dropoffId: input.dropoffAddressId,
      source: input.source,
      ...(input.passengerName ? { passengerName: input.passengerName } : {}),
    });
    if (!order) throw new BadRequestException('Unknown or identical pickup/dropoff');
    return order;
  }

  cancel(id: string, reason: string, actor: Actor) {
    if (!this.simulation.sim.cancelOrder(id, reason, actor)) throw new BadRequestException('Order is not active');
    return { ok: true };
  }

  assign(id: string, vehicleId: string) {
    if (!this.simulation.sim.assignOrder(id, vehicleId)) {
      throw new BadRequestException('Order must be searching and the taxi free and on line');
    }
    return { ok: true };
  }

  async openDispute(orderId: string, reason: string) {
    const orm = this.database.orm;
    const order = await orm.Order.first({ id: orderId });
    if (!order) throw new NotFoundException('Order not found');
    const dispute = await orm.Dispute.create({ orderId, reason, status: 'OPEN' });
    await orm.OrderEvent.create({ orderId, type: 'DISPUTE_OPENED', actor: 'DISPATCHER', note: reason });
    this.simulation.sim.setOpenDisputes(this.simulation.sim.kpi().orders.openDisputes + 1);
    return this.disputeDto(dispute);
  }

  async disputes(status?: string): Promise<(DisputeDto & { orderId: string; orderCode: string })[]> {
    const orm = this.database.orm;
    const base = status ? orm.Dispute.where({ status: status as DisputeStatus }) : orm.Dispute;
    const rows = await base.include('order').orderBy((d) => d.openedAt.desc()).limit(100).all();
    return rows.map((d) => ({ ...this.disputeDto(d), orderId: d.orderId, orderCode: d.order.code }));
  }

  async resolveDispute(disputeId: string, input: ResolveDisputeInput) {
    const orm = this.database.orm;
    const dispute = await orm.Dispute.first({ id: disputeId });
    if (!dispute) throw new NotFoundException('Dispute not found');
    if (dispute.status !== 'OPEN') throw new BadRequestException('Dispute already resolved');
    const updated = await orm.Dispute.where({ id: disputeId }).update({
      status: input.resolution,
      note: input.note ?? null,
      resolvedAt: new Date().toISOString(),
    });
    const base = input.resolution === 'REFUNDED' ? 'Возврат средств пассажиру' : 'Возражение отклонено';
    await orm.OrderEvent.create({
      orderId: dispute.orderId,
      type: 'DISPUTE_RESOLVED',
      actor: 'DISPATCHER',
      note: input.note ? `${base}: ${input.note}` : base,
    });
    this.simulation.sim.resolveDispute();
    return updated ? this.disputeDto(updated) : null;
  }

  private disputeDto(d: DisputeRow): DisputeDto {
    return {
      id: d.id,
      reason: d.reason,
      status: d.status as DisputeStatus,
      note: d.note,
      openedAt: toIso(d.openedAt)!,
      resolvedAt: toIso(d.resolvedAt),
    };
  }

  private toDto(r: OrderRow): OrderDto {
    return {
      id: r.id,
      code: r.code,
      status: r.status as OrderStatus,
      source: r.source as OrderSource,
      passengerName: r.passengerName,
      pickup: { addressId: r.pickupId, label: r.pickupLabel, x: r.pickupX, z: r.pickupZ },
      dropoff: { addressId: r.dropoffId, label: r.dropoffLabel, x: r.dropoffX, z: r.dropoffZ },
      vehicleId: r.vehicleId,
      vehiclePlate: r.vehicle?.plate ?? null,
      fareRsd: r.fareRsd,
      distanceMeters: r.distanceMeters,
      cancelReason: r.cancelReason,
      createdAt: toIso(r.createdAt)!,
      updatedAt: toIso(r.updatedAt)!,
    };
  }
}
