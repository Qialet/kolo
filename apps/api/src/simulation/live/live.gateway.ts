import { Logger, type OnModuleDestroy } from '@nestjs/common';
import { type OnGatewayConnection, type OnGatewayInit, WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import { SOCKET_NAMESPACE, SocketEvent, type LiveHello } from '@kolo/contracts';
import type { Subscription } from 'rxjs';
import type { Server, Socket } from 'socket.io';
import { SimulationService } from '../simulation.service.js';

/** Pushes simulation frames (10 Hz), KPIs (1 Hz), live events and order updates to every admin. */
@WebSocketGateway({ namespace: SOCKET_NAMESPACE, cors: { origin: process.env['WEB_ORIGIN']?.split(',') ?? true } })
export class LiveGateway implements OnGatewayInit, OnGatewayConnection, OnModuleDestroy {
  private readonly log = new Logger(LiveGateway.name);
  @WebSocketServer() server!: Server;
  private subs: Subscription[] = [];

  constructor(private readonly simulation: SimulationService) {}

  afterInit() {
    const s = this.simulation;
    this.subs.push(
      s.frames$.subscribe((f) => this.server.volatile.emit(SocketEvent.FRAME, f)),
      s.kpi$.subscribe((k) => this.server.emit(SocketEvent.KPI, k)),
      s.events$.subscribe((e) => this.server.emit(SocketEvent.EVENT, e)),
      s.orders$.subscribe((o) => this.server.emit(SocketEvent.ORDER, o)),
    );
  }

  handleConnection(client: Socket) {
    const hello: LiveHello = { districtId: this.simulation.city.districtId, version: this.simulation.city.version };
    client.emit(SocketEvent.HELLO, hello);
    client.emit(SocketEvent.KPI, this.simulation.sim.kpi());
    for (const e of [...this.simulation.recentEvents].reverse()) client.emit(SocketEvent.EVENT, e);
    this.log.debug(`client ${client.id} connected`);
  }

  onModuleDestroy() {
    for (const s of this.subs) s.unsubscribe();
  }
}
