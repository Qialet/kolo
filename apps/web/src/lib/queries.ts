'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from './api';

export const keys = {
  taxi: (id: string) => ['taxi', id] as const,
  bus: (id: string) => ['bus', id] as const,
  light: (id: number) => ['light', id] as const,
  parks: ['parks'] as const,
  vehicles: ['vehicles'] as const,
  order: (id: string) => ['order', id] as const,
  orders: (status?: string) => ['orders', status ?? 'all'] as const,
  disputes: (status?: string) => ['disputes', status ?? 'all'] as const,
  simState: ['sim-state'] as const,
};

export const useTaxi = (id: string | null) =>
  useQuery({ queryKey: keys.taxi(id ?? ''), queryFn: () => api.taxi(id!), enabled: !!id, refetchInterval: 1000 });

export const useBus = (id: string | null) =>
  useQuery({ queryKey: keys.bus(id ?? ''), queryFn: () => api.bus(id!), enabled: !!id, refetchInterval: 1000 });

export const useLight = (id: number | null) =>
  useQuery({ queryKey: keys.light(id ?? -1), queryFn: () => api.light(id!), enabled: id !== null, refetchInterval: 1000 });

export const useParks = () => useQuery({ queryKey: keys.parks, queryFn: api.parks, refetchInterval: 4000 });

export const useVehicles = () => useQuery({ queryKey: keys.vehicles, queryFn: () => api.vehicles(), refetchInterval: 4000 });

export const useOrder = (id: string | null) =>
  useQuery({ queryKey: keys.order(id ?? ''), queryFn: () => api.order(id!), enabled: !!id, refetchInterval: 2000 });

export const useOrders = (status?: string) =>
  useQuery({ queryKey: keys.orders(status), queryFn: () => api.orders(status, 60), refetchInterval: 3000 });

export const useDisputes = (status?: string) =>
  useQuery({ queryKey: keys.disputes(status), queryFn: () => api.disputes(status), refetchInterval: 5000 });

export const useSimState = () => useQuery({ queryKey: keys.simState, queryFn: api.simState, refetchInterval: 5000 });
