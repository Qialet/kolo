'use client';

import { create } from 'zustand';

export type Selection =
  | { kind: 'taxi'; id: string }
  | { kind: 'bus'; id: string }
  | { kind: 'car'; id: string }
  | { kind: 'light'; id: number }
  | { kind: 'building'; id: string }
  | { kind: 'depot'; id: string }
  | { kind: 'stop'; id: string }
  | { kind: 'order'; id: string };

export interface CameraRequest {
  x: number;
  z: number;
  zoom?: number;
  /** Follow a vehicle id until the user pans. */
  follow?: string;
  nonce: number;
}

interface UiState {
  selection: Selection | null;
  hovered: string | null;
  camera: CameraRequest | null;
  cameraCommand: { type: 'zoomIn' | 'zoomOut' | 'rotateLeft' | 'rotateRight' | 'home'; nonce: number } | null;
  labels: boolean;
  parkFilter: string | null;
  createOrder: { pickupId?: string; dropoffId?: string } | null;
  select: (s: Selection | null) => void;
  hover: (key: string | null) => void;
  focus: (x: number, z: number, opts?: { zoom?: number; follow?: string }) => void;
  command: (type: NonNullable<UiState['cameraCommand']>['type']) => void;
  toggleLabels: () => void;
  setParkFilter: (id: string | null) => void;
  openCreateOrder: (preset?: { pickupId?: string; dropoffId?: string }) => void;
  closeCreateOrder: () => void;
}

let nonce = 0;

export const useUi = create<UiState>((set) => ({
  selection: null,
  hovered: null,
  camera: null,
  cameraCommand: null,
  labels: true,
  parkFilter: null,
  createOrder: null,
  select: (selection) => set({ selection }),
  hover: (hovered) => set({ hovered }),
  focus: (x, z, opts) => set({ camera: { x, z, nonce: ++nonce, ...opts } }),
  command: (type) => set({ cameraCommand: { type, nonce: ++nonce } }),
  toggleLabels: () => set((s) => ({ labels: !s.labels })),
  setParkFilter: (parkFilter) => set({ parkFilter }),
  openCreateOrder: (preset) => set({ createOrder: preset ?? {} }),
  closeCreateOrder: () => set({ createOrder: null }),
}));
