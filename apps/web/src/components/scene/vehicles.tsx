'use client';

import { useFrame, type ThreeEvent } from '@react-three/fiber';
import { TAXI_ACTIVITIES } from '@kolo/contracts';
import type { City } from '@kolo/sim';
import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { frameBuffer, type VehiclePose } from '@/lib/live';
import { palette } from '@/lib/palette';
import { useUi } from '@/lib/ui-store';

/** Latest interpolated poses by id, shared with overlays (labels, routes, camera follow). */
export const livePoses = new Map<string, VehiclePose>();

const MAX = { taxi: 64, car: 160, bus: 16 };
const KIND = { TAXI: 0, CAR: 1, BUS: 2 } as const;

const tmp = new THREE.Object3D();
/** Moving instances: raycasting must not rely on a bounding sphere cached at first use. */
const WORLD_SPHERE = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 2000);
const TAIL_ON = new THREE.Color('#FF2D3D');
const TAIL_OFF = new THREE.Color('#7A2530');
const SIGN_FREE = new THREE.Color(palette.green);
const SIGN_PICKUP = new THREE.Color(palette.amber);
const SIGN_OFF = new THREE.Color('#4A4F5A');
/** Parked cars are mixed slightly towards the sidewalk tone so moving traffic reads first. */
const PARKED_DUST = new THREE.Color(palette.sidewalk);
const FREE = TAXI_ACTIVITIES.indexOf('FREE');
const TO_PICKUP = TAXI_ACTIVITIES.indexOf('TO_PICKUP');
const AT_PICKUP = TAXI_ACTIVITIES.indexOf('AT_PICKUP');

function box(w: number, h: number, d: number, x: number, y: number, z: number, r = 0.15) {
  const g = new RoundedBoxGeometry(w, h, d, 2, r);
  g.translate(x, y, z);
  return g;
}

function wheels(xs: number, zs: number[], r: number) {
  const parts: THREE.BufferGeometry[] = [];
  for (const sx of [-xs, xs]) {
    for (const z of zs) {
      const g = new THREE.CylinderGeometry(r, r, 0.26, 10);
      g.rotateZ(Math.PI / 2);
      g.translate(sx, r, z);
      parts.push(g);
    }
  }
  return mergeGeometries(parts)!;
}

function useGeometries() {
  return useMemo(() => {
    const carBody = box(1.82, 0.66, 4.4, 0, 0.66, 0, 0.2);
    const carCabin = box(1.52, 0.5, 2.1, 0, 1.18, -0.25, 0.18);
    const carWheels = wheels(0.84, [-1.35, 1.35], 0.33);
    const tails = mergeGeometries([box(0.42, 0.16, 0.06, -0.58, 0.8, -2.2, 0.03), box(0.42, 0.16, 0.06, 0.58, 0.8, -2.2, 0.03)])!;
    const sign = box(0.78, 0.24, 0.34, 0, 1.62, -0.2, 0.06);
    const busBody = box(2.5, 2.5, 11.8, 0, 1.6, 0, 0.3);
    const busGlass = box(2.56, 0.95, 11.2, 0, 2.15, 0.1, 0.12);
    const busRoof = box(2.2, 0.16, 9.5, 0, 2.94, 0, 0.06);
    const busWheels = wheels(1.08, [-3.9, 3.9], 0.5);
    const busTails = mergeGeometries([box(0.4, 0.3, 0.06, -0.9, 0.9, -5.92, 0.03), box(0.4, 0.3, 0.06, 0.9, 0.9, -5.92, 0.03)])!;
    return { carBody, carCabin, carWheels, tails, sign, busBody, busGlass, busRoof, busWheels, busTails };
  }, []);
}

type Group = 'taxi' | 'car' | 'bus';
type Part =
  | 'taxiBody' | 'taxiCabin' | 'taxiWheels' | 'taxiTails' | 'taxiSign'
  | 'carBody' | 'carCabin' | 'carWheels' | 'carTails'
  | 'busBody' | 'busGlass' | 'busRoof' | 'busWheels' | 'busTails';

/** The single <Vehicles> instance registers its instanced meshes here; only useFrame reads them. */
const meshes: Partial<Record<Part, THREE.InstancedMesh>> = {};
const bind = (part: Part) => (m: THREE.InstancedMesh | null) => register(part, m);
function register(part: Part, m: THREE.InstancedMesh | null) {
  if (m) meshes[part] = m;
  else delete meshes[part];
}

const setCursor = (value: string) => {
  document.body.style.cursor = value;
};

export function Vehicles() {
  const g = useGeometries();
  const poses = useRef<VehiclePose[]>([]);
  const ids = useRef<Record<Group, string[]>>({ taxi: [], car: [], bus: [] });

  const select = useUi((s) => s.select);
  const hover = useUi((s) => s.hover);
  const carColors = useMemo(() => palette.cars.map((x) => new THREE.Color(x)), []);

  useFrame(() => {
    const n = frameBuffer.sample(performance.now(), poses.current);
    const counts = { taxi: 0, car: 0, bus: 0 };
    const idLists = ids.current;
    livePoses.clear();
    for (let i = 0; i < n; i++) {
      const p = poses.current[i]!;
      livePoses.set(p.id, p);
      const group: Group = p.kind === KIND.TAXI ? 'taxi' : p.kind === KIND.BUS ? 'bus' : 'car';
      const k = counts[group];
      if (k >= MAX[group]) continue;
      counts[group]++;
      idLists[group][k] = p.id;
      const grow = Math.min(1, p.age / 500);
      tmp.position.set(p.x, 0.2, p.z);
      tmp.rotation.set(0, p.heading, 0);
      // Vehicles are drawn ~15% larger than life so they read as the main actors.
      tmp.scale.setScalar(Math.max(0.01, grow) * 1.15);
      tmp.updateMatrix();
      const braking = (p.flags & 1) !== 0;
      if (group === 'taxi') {
        for (const part of ['taxiBody', 'taxiCabin', 'taxiWheels', 'taxiTails', 'taxiSign'] as const) meshes[part]?.setMatrixAt(k, tmp.matrix);
        meshes.taxiTails?.setColorAt(k, braking ? TAIL_ON : TAIL_OFF);
        const sign = p.activity === FREE ? SIGN_FREE : p.activity === TO_PICKUP || p.activity === AT_PICKUP ? SIGN_PICKUP : SIGN_OFF;
        meshes.taxiSign?.setColorAt(k, sign);
      } else if (group === 'car') {
        for (const part of ['carBody', 'carCabin', 'carWheels', 'carTails'] as const) meshes[part]?.setMatrixAt(k, tmp.matrix);
        const hash = hashId(p.id);
        meshes.carBody?.setColorAt(k, carColors[hash % carColors.length]!);
        meshes.carTails?.setColorAt(k, braking ? TAIL_ON : TAIL_OFF);
      } else {
        for (const part of ['busBody', 'busGlass', 'busRoof', 'busWheels', 'busTails'] as const) meshes[part]?.setMatrixAt(k, tmp.matrix);
        meshes.busTails?.setColorAt(k, braking ? TAIL_ON : TAIL_OFF);
      }
    }
    const apply = (group: Group, list: readonly Part[]) => {
      for (const part of list) {
        const m = meshes[part];
        if (!m) continue;
        m.count = counts[group];
        m.boundingSphere = WORLD_SPHERE;
        m.instanceMatrix.needsUpdate = true;
        if (m.instanceColor) m.instanceColor.needsUpdate = true;
      }
    };
    apply('taxi', ['taxiBody', 'taxiCabin', 'taxiWheels', 'taxiTails', 'taxiSign'] as const);
    apply('car', ['carBody', 'carCabin', 'carWheels', 'carTails'] as const);
    apply('bus', ['busBody', 'busGlass', 'busRoof', 'busWheels', 'busTails'] as const);
  });

  const pick = (group: Group) => (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    const id = e.instanceId !== undefined ? ids.current[group][e.instanceId] : undefined;
    if (!id) return;
    select(group === 'taxi' ? { kind: 'taxi', id } : group === 'bus' ? { kind: 'bus', id } : { kind: 'car', id });
  };
  const over = (group: Group) => (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    const id = e.instanceId !== undefined ? ids.current[group][e.instanceId] : undefined;
    hover(id ? `${group}:${id}` : null);
    setCursor('pointer');
  };
  const out = () => {
    hover(null);
    setCursor('');
  };
  const handlers = (group: Group) => ({ onClick: pick(group), onPointerOver: over(group), onPointerOut: out });

  // Instanced meshes need a non-empty colour buffer before the first render.
  const withColors = (count: number, color: string) => {
    const arr = new Float32Array(count * 3);
    const col = new THREE.Color(color);
    for (let i = 0; i < count; i++) arr.set([col.r, col.g, col.b], i * 3);
    return new THREE.InstancedBufferAttribute(arr, 3);
  };

  return (
    <group>
      {/* Taxis: the hero objects — saturated Kolo yellow. */}
      <instancedMesh ref={bind('taxiBody')} args={[g.carBody, undefined, MAX.taxi]} castShadow frustumCulled={false} {...handlers('taxi')}>
        <meshStandardMaterial color={palette.taxi} roughness={0.35} metalness={0.05} />
      </instancedMesh>
      <instancedMesh ref={bind('taxiCabin')} args={[g.carCabin, undefined, MAX.taxi]} frustumCulled={false} {...handlers('taxi')}>
        <meshStandardMaterial color={palette.glass} roughness={0.2} metalness={0.3} />
      </instancedMesh>
      <instancedMesh ref={bind('taxiWheels')} args={[g.carWheels, undefined, MAX.taxi]} frustumCulled={false}>
        <meshStandardMaterial color="#20232A" roughness={0.8} />
      </instancedMesh>
      <instancedMesh ref={bind('taxiTails')} args={[g.tails, undefined, MAX.taxi]} frustumCulled={false} instanceColor={withColors(MAX.taxi, '#7A2530')}>
        <meshBasicMaterial toneMapped={false} />
      </instancedMesh>
      <instancedMesh ref={bind('taxiSign')} args={[g.sign, undefined, MAX.taxi]} frustumCulled={false} instanceColor={withColors(MAX.taxi, '#4A4F5A')}>
        <meshBasicMaterial toneMapped={false} />
      </instancedMesh>

      {/* Background cars: neutral greys and whites. */}
      <instancedMesh ref={bind('carBody')} args={[g.carBody, undefined, MAX.car]} castShadow frustumCulled={false} instanceColor={withColors(MAX.car, '#FFFFFF')} {...handlers('car')}>
        <meshStandardMaterial roughness={0.45} />
      </instancedMesh>
      <instancedMesh ref={bind('carCabin')} args={[g.carCabin, undefined, MAX.car]} frustumCulled={false}>
        <meshStandardMaterial color={palette.glass} roughness={0.25} metalness={0.25} />
      </instancedMesh>
      <instancedMesh ref={bind('carWheels')} args={[g.carWheels, undefined, MAX.car]} frustumCulled={false}>
        <meshStandardMaterial color="#20232A" roughness={0.8} />
      </instancedMesh>
      <instancedMesh ref={bind('carTails')} args={[g.tails, undefined, MAX.car]} frustumCulled={false} instanceColor={withColors(MAX.car, '#7A2530')}>
        <meshBasicMaterial toneMapped={false} />
      </instancedMesh>

      {/* Buses: cobalt, the second accent of the city. */}
      <instancedMesh ref={bind('busBody')} args={[g.busBody, undefined, MAX.bus]} castShadow frustumCulled={false} {...handlers('bus')}>
        <meshStandardMaterial color={palette.bus} roughness={0.4} />
      </instancedMesh>
      <instancedMesh ref={bind('busGlass')} args={[g.busGlass, undefined, MAX.bus]} frustumCulled={false} {...handlers('bus')}>
        <meshStandardMaterial color="#1B2A4A" roughness={0.2} metalness={0.3} />
      </instancedMesh>
      <instancedMesh ref={bind('busRoof')} args={[g.busRoof, undefined, MAX.bus]} frustumCulled={false}>
        <meshStandardMaterial color="#F4F7FF" roughness={0.6} />
      </instancedMesh>
      <instancedMesh ref={bind('busWheels')} args={[g.busWheels, undefined, MAX.bus]} frustumCulled={false}>
        <meshStandardMaterial color="#20232A" roughness={0.8} />
      </instancedMesh>
      <instancedMesh ref={bind('busTails')} args={[g.busTails, undefined, MAX.bus]} frustumCulled={false} instanceColor={withColors(MAX.bus, '#7A2530')}>
        <meshBasicMaterial toneMapped={false} />
      </instancedMesh>
    </group>
  );
}

/** Cars parked on local sidewalks: static, muted, not interactive. */
export function ParkedCars({ city }: { city: City }) {
  const g = useMemo(
    () => ({
      body: box(1.82, 0.66, 4.4, 0, 0.66, 0, 0.2),
      cabin: box(1.52, 0.5, 2.1, 0, 1.18, -0.25, 0.18),
      wheels: wheels(0.84, [-1.35, 1.35], 0.33),
    }),
    [],
  );
  const body = useRef<THREE.InstancedMesh>(null);
  const cabin = useRef<THREE.InstancedMesh>(null);
  const wheel = useRef<THREE.InstancedMesh>(null);
  useEffect(() => {
    const colors = palette.cars.map((x) => new THREE.Color(x).lerp(PARKED_DUST, 0.25));
    city.parkedCars.forEach((car, i) => {
      // Sidewalk level, same 15% upscale as moving vehicles.
      tmp.position.set(car.x, 0.17, car.z);
      tmp.rotation.set(0, car.heading, 0);
      tmp.scale.setScalar(1.15);
      tmp.updateMatrix();
      for (const m of [body.current, cabin.current, wheel.current]) m?.setMatrixAt(i, tmp.matrix);
      body.current?.setColorAt(i, colors[car.tint % colors.length]!);
    });
    for (const m of [body.current, cabin.current, wheel.current]) {
      if (!m) continue;
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
      m.computeBoundingSphere();
    }
  }, [city]);
  const n = city.parkedCars.length;
  return (
    <group>
      <instancedMesh ref={body} args={[g.body, undefined, n]} castShadow receiveShadow>
        <meshStandardMaterial roughness={0.55} />
      </instancedMesh>
      <instancedMesh ref={cabin} args={[g.cabin, undefined, n]}>
        <meshStandardMaterial color={palette.glass} roughness={0.3} metalness={0.2} />
      </instancedMesh>
      <instancedMesh ref={wheel} args={[g.wheels, undefined, n]}>
        <meshStandardMaterial color="#20232A" roughness={0.8} />
      </instancedMesh>
    </group>
  );
}

function hashId(id: string) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h;
}
