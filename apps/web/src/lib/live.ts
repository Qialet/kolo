'use client';

import {
  ACTIVE_ORDER_STATUSES,
  SOCKET_NAMESPACE,
  SocketEvent,
  type LiveEvent,
  type LiveFrame,
  type LiveHello,
  type LiveKpi,
  type OrderSummary,
  type VehicleTuple,
} from '@kolo/contracts';
import { io, type Socket } from 'socket.io-client';
import { create } from 'zustand';
import { api, SOCKET_URL } from './api';

/** Interpolated pose of a vehicle at render time. */
export interface VehiclePose {
  id: string;
  kind: number;
  x: number;
  z: number;
  heading: number;
  speed: number;
  activity: number;
  flags: number;
  /** ms since the vehicle first appeared (for spawn fade-in). */
  age: number;
}

interface BufferedFrame {
  localTime: number;
  frame: LiveFrame;
  byId: Map<string, VehicleTuple>;
}

const RENDER_DELAY = 140;

/**
 * Keeps the last frames from the server and samples them with a small delay so that
 * 10 Hz updates render as smooth 60 fps motion. Lives outside React on purpose.
 */
class FrameBuffer {
  private frames: BufferedFrame[] = [];
  private offsets: number[] = [];
  private firstSeen = new Map<string, number>();
  latest: LiveFrame | null = null;
  latestAt = 0;

  push(frame: LiveFrame) {
    const now = performance.now();
    this.offsets.push(now - frame.wall);
    if (this.offsets.length > 40) this.offsets.shift();
    const offset = Math.min(...this.offsets);
    const byId = new Map<string, VehicleTuple>();
    for (const v of frame.vehicles) {
      byId.set(v[0], v);
      if (!this.firstSeen.has(v[0])) this.firstSeen.set(v[0], now);
    }
    this.frames.push({ localTime: frame.wall + offset, frame, byId });
    if (this.frames.length > 30) this.frames.shift();
    this.latest = frame;
    this.latestAt = now;
  }

  /** Fills `out` with interpolated poses; returns the number of vehicles. */
  sample(now: number, out: VehiclePose[]): number {
    const frames = this.frames;
    if (!frames.length) return 0;
    const rt = now - RENDER_DELAY;
    let b = frames.findIndex((f) => f.localTime > rt);
    if (b === -1) b = frames.length - 1;
    const a = Math.max(0, b - 1);
    const fa = frames[a]!;
    const fb = frames[b]!;
    const span = fb.localTime - fa.localTime;
    const t = span > 0 ? Math.min(1, Math.max(0, (rt - fa.localTime) / span)) : 1;
    let n = 0;
    for (const vb of fb.frame.vehicles) {
      const va = fa.byId.get(vb[0]) ?? vb;
      const pose = out[n] ?? (out[n] = { id: '', kind: 0, x: 0, z: 0, heading: 0, speed: 0, activity: -1, flags: 0, age: 0 });
      pose.id = vb[0];
      pose.kind = vb[1];
      pose.x = va[2] + (vb[2] - va[2]) * t;
      pose.z = va[3] + (vb[3] - va[3]) * t;
      pose.heading = lerpAngle(va[4], vb[4], t);
      pose.speed = vb[5];
      pose.activity = vb[6];
      pose.flags = vb[7];
      pose.age = now - (this.firstSeen.get(vb[0]) ?? now);
      n++;
    }
    return n;
  }

  /** Latest known pose of one vehicle (not interpolated). */
  find(id: string): VehicleTuple | undefined {
    return this.frames[this.frames.length - 1]?.byId.get(id);
  }
}

function lerpAngle(a: number, b: number, t: number) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

export const frameBuffer = new FrameBuffer();

interface LiveState {
  connected: boolean;
  kpi: LiveKpi | null;
  events: LiveEvent[];
  unread: number;
  /** Active orders keyed by id, updated from the socket. */
  orders: Record<string, OrderSummary>;
  /** District version the server simulates (from the hello message). */
  districtVersion: string | null;
  markRead: () => void;
}

export const useLive = create<LiveState>((set) => ({
  connected: false,
  kpi: null,
  events: [],
  unread: 0,
  orders: {},
  districtVersion: null,
  markRead: () => set({ unread: 0 }),
}));

let socket: Socket | null = null;

export function connectLive() {
  if (socket) return socket;
  socket = io(`${SOCKET_URL}${SOCKET_NAMESPACE}`, { transports: ['websocket'] });
  let connectedAt = 0;
  socket.on('connect', () => {
    connectedAt = performance.now();
    useLive.setState({ connected: true });
    // Seed live orders; afterwards the socket keeps them current.
    void api.orders('SEARCHING,ASSIGNED,ARRIVED,IN_PROGRESS', 100).then((list) =>
      useLive.setState((s) => {
        const orders = { ...s.orders };
        for (const o of list) orders[o.id] ??= { id: o.id, code: o.code, status: o.status, pickup: o.pickup, dropoff: o.dropoff, passengerName: o.passengerName, vehicleId: o.vehicleId, fareRsd: o.fareRsd, distanceMeters: o.distanceMeters, createdAt: new Date(o.createdAt).getTime() };
        return { orders };
      }),
    );
  });
  socket.on('disconnect', () => useLive.setState({ connected: false }));
  socket.on(SocketEvent.HELLO, (h: LiveHello) => useLive.setState({ districtVersion: h.version }));
  socket.on(SocketEvent.FRAME, (f: LiveFrame) => frameBuffer.push(f));
  socket.on(SocketEvent.KPI, (kpi: LiveKpi) => useLive.setState({ kpi }));
  socket.on(SocketEvent.EVENT, (e: LiveEvent) =>
    useLive.setState((s) => (s.events.some((x) => x.id === e.id) ? s : { events: [e, ...s.events].slice(0, 80), unread: performance.now() - connectedAt < 1500 ? s.unread : s.unread + 1 })),
  );
  socket.on(SocketEvent.ORDER, (o: OrderSummary) =>
    useLive.setState((s) => {
      const orders = { ...s.orders };
      if (ACTIVE_ORDER_STATUSES.includes(o.status)) orders[o.id] = o;
      else delete orders[o.id];
      return { orders };
    }),
  );
  return socket;
}
