import { Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { Actor, FleetStatus, LiveEvent, LiveFrame, LiveKpi, OrderSummary } from '@kolo/contracts';
import { buildCity, Simulation, type City, type FleetVehicleSeed, type SimOrderEvent } from '@kolo/sim';
import { Subject } from 'rxjs';
import { DatabaseService } from '../database/database.service.js';
import { SeedService } from '../database/seed/seed.service.js';

const TICK_MS = 50;
const FRAME_MS = 100;
const KPI_MS = 1000;
const RECENT_EVENTS = 60;

/**
 * Runs the authoritative city simulation in-process and persists its business events.
 * Live state (positions, lights) stays in memory; orders, events and fleet changes go to Postgres.
 */
@Injectable()
export class SimulationService implements OnModuleInit, OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger(SimulationService.name);
  readonly city: City = buildCity();
  sim!: Simulation;
  readonly frames$ = new Subject<LiveFrame>();
  readonly kpi$ = new Subject<LiveKpi>();
  readonly events$ = new Subject<LiveEvent>();
  readonly orders$ = new Subject<OrderSummary>();
  readonly recentEvents: LiveEvent[] = [];
  private timer: NodeJS.Timeout | null = null;
  /** Serialises writes so an order row always exists before its events. */
  private writes: Promise<unknown> = Promise.resolve();
  private parkNames = new Map<string, string>();

  constructor(
    private readonly database: DatabaseService,
    private readonly seed: SeedService,
  ) {}

  async onModuleInit() {
    await this.seed.ensureSeeded(this.city);
    await this.seed.syncParks(this.city);
    const orm = this.database.orm;
    await this.closeOrphanedOrders();
    const parks = await orm.Park.all();
    for (const p of parks) this.parkNames.set(p.id, p.name);
    const vehicles = await orm.Vehicle.include('driver').orderBy((v) => v.id.asc()).all();
    const fleet: FleetVehicleSeed[] = vehicles
      .map((v) => ({
        id: v.id,
        plate: v.plate,
        model: v.model,
        parkId: v.parkId,
        parkName: this.parkNames.get(v.parkId) ?? v.parkId,
        fleetStatus: v.fleetStatus as FleetStatus,
        driverName: v.driver?.name ?? null,
        driverRating: v.driver?.rating ?? null,
      }))
      .sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)));
    const last = await orm.Order.orderBy((o) => o.code.desc()).select('code').first();
    this.sim = new Simulation(this.city, fleet, {
      seed: Date.now() % 100000,
      lastOrderNumber: last ? Number(last.code.replace(/\D/g, '')) : 0,
      hooks: {
        onOrderCreated: (order, source) => this.enqueue(() => this.insertOrder(order, source)),
        onOrderEvent: (order, event, extra) => {
          this.orders$.next(order);
          this.enqueue(() => this.recordOrderEvent(order, event, extra.cancelReason));
        },
        onFleetStatus: (vehicleId, status, actor) => this.enqueue(() => this.recordFleetStatus(vehicleId, status, actor)),
        onDisputeOpened: (orderId, reason) => this.enqueue(() => orm.Dispute.create({ orderId, reason, status: 'OPEN' })),
        onLiveEvent: (e) => this.pushEvent(e),
      },
    });
    const open = await orm.Dispute.where({ status: 'OPEN' }).aggregate((a) => ({ n: a.count() }));
    this.sim.setOpenDisputes(open.n);
    this.log.log(`City ready: ${this.city.buildings.length} buildings, ${fleet.length} taxis, ${this.city.busLines.length} bus lines`);
  }

  onApplicationBootstrap() {
    let last = performance.now();
    let frameAcc = 0;
    let kpiAcc = 0;
    this.timer = setInterval(() => {
      const now = performance.now();
      const dt = (now - last) / 1000;
      last = now;
      this.sim.tick(dt);
      frameAcc += dt * 1000;
      kpiAcc += dt * 1000;
      if (frameAcc >= FRAME_MS) {
        frameAcc = 0;
        this.frames$.next(this.sim.frame());
      }
      if (kpiAcc >= KPI_MS) {
        kpiAcc = 0;
        this.kpi$.next(this.sim.kpi());
      }
    }, TICK_MS);
  }

  async onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    await this.writes;
  }

  parkName(id: string) {
    return this.parkNames.get(id) ?? id;
  }

  pushEvent(e: LiveEvent) {
    this.recentEvents.unshift(e);
    if (this.recentEvents.length > RECENT_EVENTS) this.recentEvents.pop();
    this.events$.next(e);
  }

  // ───────────────────────────── persistence ─────────────────────────────

  private enqueue(job: () => Promise<unknown>) {
    this.writes = this.writes.then(job).catch((err: unknown) => this.log.error(err instanceof Error ? err.message : String(err)));
  }

  /** Orders that were live when the process stopped can never finish — close them. */
  private async closeOrphanedOrders() {
    const orm = this.database.orm;
    const stale = await orm.Order.where((o) => o.status.in(['SEARCHING', 'ASSIGNED', 'ARRIVED', 'IN_PROGRESS'])).select('id').all();
    for (const o of stale) {
      await orm.Order.where({ id: o.id }).update({ status: 'CANCELLED', cancelReason: 'Перезапуск системы' });
      await orm.OrderEvent.create({ orderId: o.id, type: 'CANCELLED', actor: 'SYSTEM', note: 'Перезапуск системы' });
    }
    if (stale.length) this.log.warn(`Closed ${stale.length} orders left open by the previous run`);
  }

  private async insertOrder(order: OrderSummary, source: string) {
    await this.database.orm.Order.create({
      id: order.id,
      code: order.code,
      status: order.status,
      source: source as 'APP',
      passengerName: order.passengerName,
      pickupId: order.pickup.addressId,
      pickupLabel: order.pickup.label,
      pickupX: order.pickup.x,
      pickupZ: order.pickup.z,
      dropoffId: order.dropoff.addressId,
      dropoffLabel: order.dropoff.label,
      dropoffX: order.dropoff.x,
      dropoffZ: order.dropoff.z,
      vehicleId: order.vehicleId,
      fareRsd: order.fareRsd,
      distanceMeters: order.distanceMeters,
    });
  }

  private async recordOrderEvent(order: OrderSummary, e: SimOrderEvent, cancelReason?: string) {
    const orm = this.database.orm;
    await orm.Order.where({ id: order.id }).update({
      status: order.status,
      vehicleId: order.vehicleId,
      fareRsd: order.fareRsd,
      distanceMeters: order.distanceMeters,
      ...(cancelReason ? { cancelReason } : {}),
    });
    await orm.OrderEvent.create({ orderId: order.id, type: e.type, actor: e.actor, note: e.note, vehicleId: e.vehicleId, x: e.x, z: e.z });
  }

  private async recordFleetStatus(vehicleId: string, status: FleetStatus, actor: Actor) {
    const orm = this.database.orm;
    await orm.Vehicle.where({ id: vehicleId }).update({ fleetStatus: status });
    await orm.VehicleStatusChange.create({ vehicleId, status, actor });
  }
}
