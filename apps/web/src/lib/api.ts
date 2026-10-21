import type {
  BusDetail,
  CreateOrderInput,
  DisputeDto,
  FleetStatus,
  LightControlInput,
  LightDetail,
  LiveEvent,
  OrderDto,
  OrderSummary,
  ParkDto,
  ResolveDisputeInput,
  SimControlInput,
  TaxiDetail,
  VehicleDto,
} from '@kolo/contracts';

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/api';
export const SOCKET_URL = API_URL.replace(/\/api$/, '');

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...init?.headers },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { message?: string } | null;
    throw new Error(body?.message ?? `${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

const post = <T>(path: string, body: unknown) => request<T>(path, { method: 'POST', body: JSON.stringify(body) });
const patch = <T>(path: string, body: unknown) => request<T>(path, { method: 'PATCH', body: JSON.stringify(body) });

export interface SimState {
  speed: number;
  paused: boolean;
  trafficDensity: number;
  demand: number;
  districtVersion: string;
}

export const api = {
  simState: () => request<SimState>('/sim/state'),
  simControl: (input: SimControlInput) => post<SimState>('/sim/control', input),
  taxi: (id: string) => request<TaxiDetail>(`/sim/taxis/${id}`),
  bus: (id: string) => request<BusDetail>(`/sim/buses/${id}`),
  light: (id: number) => request<LightDetail>(`/sim/lights/${id}`),
  setLight: (id: number, input: LightControlInput) => patch<LightDetail>(`/sim/lights/${id}`, input),
  events: () => request<LiveEvent[]>('/sim/events'),
  parks: () => request<ParkDto[]>('/fleet/parks'),
  vehicles: (parkId?: string) => request<VehicleDto[]>(`/fleet/vehicles${parkId ? `?parkId=${parkId}` : ''}`),
  setFleetStatus: (id: string, status: FleetStatus) => patch<TaxiDetail>(`/fleet/vehicles/${id}/status`, { status }),
  orders: (status?: string, limit = 50) => request<OrderDto[]>(`/orders?limit=${limit}${status ? `&status=${status}` : ''}`),
  order: (id: string) => request<OrderDto>(`/orders/${id}`),
  createOrder: (input: Partial<CreateOrderInput> & { pickupAddressId: string; dropoffAddressId: string }) => post<OrderSummary>('/orders', input),
  cancelOrder: (id: string, reason: string) => post<{ ok: true }>(`/orders/${id}/cancel`, { reason, actor: 'DISPATCHER' }),
  assignOrder: (id: string, vehicleId: string) => post<{ ok: true }>(`/orders/${id}/assign`, { vehicleId }),
  openDispute: (orderId: string, reason: string) => post<DisputeDto>(`/orders/${orderId}/disputes`, { reason }),
  disputes: (status?: string) => request<(DisputeDto & { orderId: string; orderCode: string })[]>(`/orders/disputes${status ? `?status=${status}` : ''}`),
  resolveDispute: (id: string, input: ResolveDisputeInput) => post<DisputeDto>(`/orders/disputes/${id}/resolve`, input),
};
