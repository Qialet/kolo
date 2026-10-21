'use client';

import { Line } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import type { PlaceRef, RoutePoint } from '@kolo/contracts';
import type { City } from '@kolo/sim';
import { useMemo, useRef } from 'react';
import * as THREE from 'three';
import { palette } from '@/lib/palette';
import { useBus, useOrder, useTaxi } from '@/lib/queries';
import { useUi } from '@/lib/ui-store';
import { livePoses } from './vehicles';

/** 3D parts of the selection overlay (rings, routes, outlines). Text lives in SceneLabels. */
export function Overlays({ city }: { city: City }) {
  const selection = useUi((s) => s.selection);
  return (
    <group>
      {selection?.kind === 'taxi' && <TaxiOverlay id={selection.id} />}
      {selection?.kind === 'bus' && <BusOverlay id={selection.id} />}
      {selection?.kind === 'order' && <OrderOverlay id={selection.id} />}
      {selection?.kind === 'car' && <VehicleRing id={selection.id} color={palette.pole} />}
      {selection?.kind === 'building' && <BuildingOutline city={city} id={selection.id} />}
      {selection?.kind === 'stop' && <StopRing city={city} id={selection.id} />}
      {selection?.kind === 'depot' && <DepotOutline city={city} id={selection.id} />}
    </group>
  );
}

export const routeColor = (activity?: string) =>
  activity === 'ON_TRIP' ? palette.taxiDeep : activity === 'TO_PICKUP' || activity === 'AT_PICKUP' ? palette.pickup : palette.depot;

function TaxiOverlay({ id }: { id: string }) {
  const { data } = useTaxi(id);
  return (
    <group>
      <VehicleRing id={id} color={palette.taxi} />
      {data && data.route.length > 1 && <LiveRoute vehicleId={id} points={data.route} color={routeColor(data.activity)} dashed={data.activity !== 'ON_TRIP'} />}
      {data?.order && (
        <>
          <PinRing place={data.order.pickup} color={palette.pickup} />
          <PinRing place={data.order.dropoff} color={palette.dropoff} />
        </>
      )}
      {!data?.order && data?.routeTarget && <PinRing place={data.routeTarget} color={palette.depot} />}
    </group>
  );
}

function BusOverlay({ id }: { id: string }) {
  const { data } = useBus(id);
  return (
    <group>
      <VehicleRing id={id} color={palette.bus} size={8} />
      {data && data.route.length > 1 && <LiveRoute vehicleId={id} points={data.route} color={palette.bus} dashed />}
    </group>
  );
}

function OrderOverlay({ id }: { id: string }) {
  const { data } = useOrder(id);
  if (!data) return null;
  const live = data.vehicleId && ['ASSIGNED', 'ARRIVED', 'IN_PROGRESS'].includes(data.status);
  return (
    <group>
      <PinRing place={data.pickup} color={palette.pickup} />
      <PinRing place={data.dropoff} color={palette.dropoff} />
      {live && <TaxiOverlay id={data.vehicleId!} />}
    </group>
  );
}

/** Route polyline whose first point sticks to the interpolated vehicle position. */
function LiveRoute({ vehicleId, points, color, dashed }: { vehicleId: string; points: RoutePoint[]; color: string; dashed: boolean }) {
  const line = useRef<THREE.Object3D & { geometry: { setPositions: (p: number[]) => void }; computeLineDistances: () => void }>(null);
  const base = useMemo(() => points.flatMap((p) => [p.x, 0.45, p.z]), [points]);
  const vecs = useMemo(() => points.map((p) => new THREE.Vector3(p.x, 0.45, p.z)), [points]);
  useFrame(() => {
    const pose = livePoses.get(vehicleId);
    if (!pose || !line.current) return;
    const arr = base.slice();
    arr[0] = pose.x;
    arr[2] = pose.z;
    line.current.geometry.setPositions(arr);
    if (dashed) line.current.computeLineDistances();
  });
  return (
    <group>
      <Line points={vecs} color="#FFFFFF" lineWidth={9} transparent opacity={0.85} depthTest={false} renderOrder={10} />
      <Line ref={line as never} points={vecs} color={color} lineWidth={4.5} dashed={dashed} dashSize={5} gapSize={3.5} depthTest={false} renderOrder={11} />
    </group>
  );
}

function PinRing({ place, color }: { place: PlaceRef; color: string }) {
  return (
    <group position={[place.x, 0.32, place.z]}>
      <mesh rotation-x={-Math.PI / 2}>
        <ringGeometry args={[2.2, 3.4, 32]} />
        <meshBasicMaterial color={color} toneMapped={false} />
      </mesh>
      <mesh position-y={1.6}>
        <cylinderGeometry args={[0.12, 0.12, 3.2, 6]} />
        <meshBasicMaterial color={color} toneMapped={false} />
      </mesh>
    </group>
  );
}

function VehicleRing({ id, color, size = 5 }: { id: string; color: string; size?: number }) {
  const ring = useRef<THREE.Mesh>(null);
  useFrame(({ clock }) => {
    const pose = livePoses.get(id);
    const m = ring.current;
    if (!pose || !m) return;
    m.position.set(pose.x, 0.26, pose.z);
    const s = 1 + Math.sin(clock.elapsedTime * 4) * 0.08;
    m.scale.set(s, s, s);
  });
  return (
    <mesh ref={ring} rotation-x={-Math.PI / 2}>
      <ringGeometry args={[size - 1, size, 40]} />
      <meshBasicMaterial color={color} transparent opacity={0.9} toneMapped={false} />
    </mesh>
  );
}

function BuildingOutline({ city, id }: { city: City; id: string }) {
  const b = city.buildings.find((x) => x.id === id);
  const geo = useMemo(() => (b ? new THREE.EdgesGeometry(new THREE.BoxGeometry(b.w + 0.4, b.h + 0.4, b.d + 0.4)) : null), [b]);
  if (!b || !geo) return null;
  return (
    <lineSegments position={[b.x, 0.2 + b.h / 2, b.z]} geometry={geo}>
      <lineBasicMaterial color={palette.taxiDeep} />
    </lineSegments>
  );
}

function DepotOutline({ city, id }: { city: City; id: string }) {
  const d = city.depots.find((x) => x.id === id);
  if (!d) return null;
  return (
    <mesh position={[(d.lot.x0 + d.lot.x1) / 2, 0.23, (d.lot.z0 + d.lot.z1) / 2]} rotation-x={-Math.PI / 2}>
      <planeGeometry args={[d.lot.x1 - d.lot.x0, d.lot.z1 - d.lot.z0]} />
      <meshBasicMaterial color={palette.depot} transparent opacity={0.14} depthWrite={false} />
    </mesh>
  );
}

function StopRing({ city, id }: { city: City; id: string }) {
  const stop = city.busStops.find((s) => s.id === id);
  if (!stop) return null;
  return (
    <mesh position={[stop.x, 0.3, stop.z]} rotation-x={-Math.PI / 2}>
      <ringGeometry args={[5, 6, 40]} />
      <meshBasicMaterial color={palette.bus} toneMapped={false} />
    </mesh>
  );
}
