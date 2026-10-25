'use client';

import { useFrame, type ThreeEvent } from '@react-three/fiber';
import { TAXI_ACTIVITIES, VEHICLE_KINDS } from '@kolo/contracts';
import type { City } from '@kolo/sim';
import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { frameBuffer, type VehiclePose } from '@/lib/live';
import { palette } from '@/lib/palette';
import { useVehicles } from '@/lib/queries';
import { TramTrails, type TrailPose } from '@/lib/tram-trail';
import { chunkCells } from '@/lib/lod';
import { useUi } from '@/lib/ui-store';
import { ChunkedInstances, type InstancePart } from './chunked';

/** Latest interpolated poses by id, shared with overlays (labels, routes, camera follow). */
export const livePoses = new Map<string, VehiclePose>();

const MAX = { taxi: 64, car: 160, bus: 260, trolley: 60, minibus: 24, tram: 80 };
/** CAF Urbos 3 (frame flag 8) and Tatra KT4: the frame gives the front, sections follow its trail. */
const TRAM = { long: { length: 33, sections: 5 }, short: { length: 19, sections: 2 } } as const;
const LONG_TRAM = 8;
const TRAM_SECTIONS = MAX.tram * TRAM.long.sections;
/** Section model length; real sections (6.6 and 9.5 m) are scaled to it along z, less the joint. */
const TRAM_MODEL = 8;
const TRAM_JOINT = 0.35;
const trails = new TramTrails();
const sectionPoses: TrailPose[] = [];
const HALO_PULSE = 2.4;
/** Turn signals: frame bits 4 (left) and 5 (right), blinking at this rate (Hz). */
const SIGNAL_LEFT = 16;
const SIGNAL_RIGHT = 32;
const BLINK_HZ = 1.5;
const KIND = Object.fromEntries(VEHICLE_KINDS.map((k, i) => [k, i])) as Record<(typeof VEHICLE_KINDS)[number], number>;

const tmp = new THREE.Object3D();
const view = new THREE.Frustum();
const projView = new THREE.Matrix4();
const sphere = new THREE.Sphere();
const at = new THREE.Vector3();
/** Moving instances: raycasting must not rely on a bounding sphere cached at first use. */
const WORLD_SPHERE = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 5000);
const TAIL_ON = new THREE.Color('#FF2D3D');
const TAIL_OFF = new THREE.Color('#7A2530');
const SIGN_FREE = new THREE.Color(palette.green);
const SIGN_PICKUP = new THREE.Color(palette.amber);
const SIGN_OFF = new THREE.Color('#4A4F5A');
/** Parked cars are mixed slightly towards the sidewalk tone so moving traffic reads first. */
const PARKED_DUST = new THREE.Color(palette.sidewalk);
/** With a partner filter on, other partners' taxis fade towards the street tone. */
const TAXI_ON = new THREE.Color(palette.taxi);
const TAXI_DIM = new THREE.Color(palette.taxi).lerp(new THREE.Color(palette.asphalt), 0.72);
const FREE = TAXI_ACTIVITIES.indexOf('FREE');
const TO_PICKUP = TAXI_ACTIVITIES.indexOf('TO_PICKUP');
const AT_PICKUP = TAXI_ACTIVITIES.indexOf('AT_PICKUP');

function box(w: number, h: number, d: number, x: number, y: number, z: number, r = 0.15) {
  const g = new RoundedBoxGeometry(w, h, d, 2, r);
  g.translate(x, y, z);
  return g;
}

/** Box without rounded edges for the far level. */
function plainBox(w: number, h: number, d: number, x: number, y: number, z: number) {
  const g = new THREE.BoxGeometry(w, h, d);
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
    // Turn signal lamps wrapped round the left corners, larger than life to read from the isometric camera
    // (model +x is the left side; the right side is the same mirrored).
    const blink = (w: number, h: number, x: number, y: number, z: number) => mergeGeometries([box(w, h, w, x, y, z, 0.04), box(w, h, w, x, y, -z, 0.04)])!;
    const carBlink = blink(0.34, 0.22, 0.8, 0.8, 2.1);
    const halo = new THREE.RingGeometry(3.4, 4.3, 40);
    const coach = (length: number, height: number, axles: number[], wheel: number): Record<(typeof COACH_PARTS)[number] | 'Blink', THREE.BufferGeometry> => ({
      Body: box(2.5, height, length - 0.2, 0, 0.35 + height / 2, 0, 0.3),
      Glass: box(2.56, 0.95, length - 0.8, 0, 0.35 + height - 0.8, 0.1, 0.12),
      Roof: box(2.2, 0.16, length * 0.8, 0, 0.35 + height + 0.09, 0, 0.06),
      Wheels: wheels(1.08, axles, wheel),
      Tails: mergeGeometries([box(0.4, 0.3, 0.06, -0.9, 0.9, -length / 2 + 0.08, 0.03), box(0.4, 0.3, 0.06, 0.9, 0.9, -length / 2 + 0.08, 0.03)])!,
      Blink: blink(0.42, 0.3, 1.1, 0.9, length / 2 - 0.16),
    });
    const transit: Record<TransitGroup, Record<string, THREE.BufferGeometry>> = {
      bus: coach(12, 2.5, [-3.9, 3.9], 0.5),
      trolley: { ...coach(12, 2.5, [-3.9, 3.9], 0.5), Poles: trolleyPoles() },
      minibus: coach(7.5, 2.3, [-2.4, 2.4], 0.42),
    };
    const tram = { ...coach(TRAM_MODEL, 2.45, [-2.5, 2.5], 0.36), Panto: pantograph() };
    // Far level: plain boxes for the rounded bodies; wheels, tail lamps and pantographs are under a pixel there.
    const flat = (length: number, height: number) => ({
      Body: plainBox(2.5, height, length - 0.2, 0, 0.35 + height / 2, 0),
      Glass: plainBox(2.56, 0.95, length - 0.8, 0, 0.35 + height - 0.8, 0.1),
      Roof: plainBox(2.2, 0.16, length * 0.8, 0, 0.35 + height + 0.09, 0),
      Wheels: null,
      Tails: null,
      Blink: null,
    });
    const farBody = plainBox(1.82, 0.66, 4.4, 0, 0.66, 0);
    const farCabin = plainBox(1.52, 0.5, 2.1, 0, 1.18, -0.25);
    const far: Partial<Record<Part, THREE.BufferGeometry | null>> = {
      taxiBody: farBody,
      taxiCabin: farCabin,
      taxiWheels: null,
      taxiTails: null,
      taxiBlink: null,
      taxiSign: plainBox(0.78, 0.24, 0.34, 0, 1.62, -0.2),
      carBody: farBody,
      carCabin: farCabin,
      carWheels: null,
      carTails: null,
      carBlink: null,
      tramPanto: null,
    };
    const farCoaches = { bus: flat(12, 2.5), trolley: flat(12, 2.5), minibus: flat(7.5, 2.3), tram: flat(TRAM_MODEL, 2.45) };
    for (const [group, parts] of Object.entries(farCoaches)) for (const [p, geo] of Object.entries(parts)) far[`${group}${p}` as Part] = geo;
    return { carBody, carCabin, carWheels, tails, sign, carBlink, halo, transit, tram, far };
  }, []);
}

/** Thin bar between two points of the y–z plane, at x. */
function bar(x: number, from: { y: number; z: number }, to: { y: number; z: number }, size = 0.07) {
  const g = new THREE.BoxGeometry(size, size, Math.hypot(to.y - from.y, to.z - from.z));
  g.rotateX(Math.atan2(to.y - from.y, from.z - to.z));
  g.translate(x, (from.y + to.y) / 2, (from.z + to.z) / 2);
  return g;
}

/** Folding pantograph on a section roof, its collector touching the tram wire 6.0 m above the street. */
function pantograph() {
  const roof = { y: 3.0, z: -1.0 };
  const knee = { y: 4.1, z: 0.7 };
  const head = { y: (6.0 - 0.2) / 1.15 - 0.04, z: -0.2 };
  const parts = [-0.3, 0.3].flatMap((x) => [bar(x, roof, knee), bar(x, knee, head)]);
  const collector = new THREE.BoxGeometry(1.7, 0.06, 0.12);
  collector.translate(0, head.y, head.z);
  parts.push(collector);
  return mergeGeometries(parts)!;
}

/** Two trolley poles from the roof back up to the wires 5.6 m above the street (model space, before the 1.15 upscale). */
function trolleyPoles() {
  const from = { y: 3.05, z: 1.6 };
  const to = { y: (5.6 - 0.2) / 1.15, z: -3.9 };
  const len = Math.hypot(to.y - from.y, to.z - from.z);
  const tilt = Math.atan2(to.y - from.y, from.z - to.z);
  const parts = [-0.35, 0.35].map((x) => {
    const g = new THREE.BoxGeometry(0.07, 0.07, len);
    g.rotateX(tilt);
    g.translate(x, (from.y + to.y) / 2, (from.z + to.z) / 2);
    return g;
  });
  return mergeGeometries(parts)!;
}

type TransitGroup = 'bus' | 'trolley' | 'minibus';
type Group = 'taxi' | 'car' | TransitGroup | 'tram';
/** Tram parts drawn per section; the pantograph and the tail lamps once per tram. */
const TRAM_SECTION_PARTS = ['tramBody', 'tramGlass', 'tramRoof', 'tramWheels'] as const;
const TRANSIT: readonly TransitGroup[] = ['bus', 'trolley', 'minibus'];
const COACH_PARTS = ['Body', 'Glass', 'Roof', 'Wheels', 'Tails'] as const;
/** Groups with turn signals (not trams); their lamps are instanced apart from the bodies, only while lit. */
const SIGNALLING = ['taxi', 'car', 'bus', 'trolley', 'minibus'] as const;
type BlinkPart = `${(typeof SIGNALLING)[number]}Blink`;
type TransitPart = `${TransitGroup}${(typeof COACH_PARTS)[number] | 'Poles'}`;
const partsOf = (group: TransitGroup): TransitPart[] => [...COACH_PARTS, ...(group === 'trolley' ? (['Poles'] as const) : [])].map((p) => `${group}${p}` as const);
type Part =
  | 'taxiBody' | 'taxiCabin' | 'taxiWheels' | 'taxiTails' | 'taxiSign' | 'taxiHalo'
  | 'carBody' | 'carCabin' | 'carWheels' | 'carTails'
  | (typeof TRAM_SECTION_PARTS)[number] | 'tramTails' | 'tramPanto'
  | TransitPart
  | BlinkPart;
const TRANSIT_COLOR: Record<TransitGroup, string> = { bus: palette.bus, trolley: palette.trolley, minibus: palette.minibus };

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
  const lod = useUi((s) => s.lod);
  // Swap every part to its far model (or hide it) and back; nothing casts a shadow from afar.
  useEffect(() => {
    for (const part of Object.keys(meshes) as Part[]) {
      const m = meshes[part]!;
      const near = (m.userData.near ??= { geometry: m.geometry, castShadow: m.castShadow }) as { geometry: THREE.BufferGeometry; castShadow: boolean };
      const far = lod === 'far' && part in g.far ? g.far[part]! : undefined;
      m.geometry = far ?? near.geometry;
      m.visible = far !== null;
      m.castShadow = near.castShadow && lod === 'near';
    }
  }, [lod, g]);
  const poses = useRef<VehiclePose[]>([]);
  // For trams: the tram id of every section instance.
  const ids = useRef<Record<Group, string[]>>({ taxi: [], car: [], bus: [], trolley: [], minibus: [], tram: [] });

  const select = useUi((s) => s.select);
  const hover = useUi((s) => s.hover);
  const carColors = useMemo(() => palette.cars.map((x) => new THREE.Color(x)), []);
  // Partner filter: taxis of the chosen park get a violet halo, the rest fade out.
  const parkFilter = useUi((s) => s.parkFilter);
  const fleet = useVehicles();
  const parkOf = useMemo(() => new Map(fleet.data?.map((v) => [v.id, v.parkId]) ?? []), [fleet.data]);

  useFrame(({ clock, camera }) => {
    // Vehicles off screen are not drawn (their poses still feed overlays and trails).
    view.setFromProjectionMatrix(projView.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    const inView = (x: number, z: number, r: number) => view.intersectsSphere(sphere.set(at.set(x, 1, z), r));
    let halos = 0;
    // Roughly constant on screen: larger when zoomed out, never smaller than the car.
    const pulse = (1 + Math.sin(clock.elapsedTime * HALO_PULSE) * 0.08) * Math.max(1, 7 / camera.zoom);
    const n = frameBuffer.sample(performance.now(), poses.current);
    const counts = { taxi: 0, car: 0, bus: 0, trolley: 0, minibus: 0, tram: 0 };
    const blinks = { taxi: 0, car: 0, bus: 0, trolley: 0, minibus: 0 };
    const lit = (clock.elapsedTime * BLINK_HZ) % 1 < 0.5;
    let trams = 0;
    const idLists = ids.current;
    livePoses.clear();
    for (let i = 0; i < n; i++) {
      const p = poses.current[i]!;
      livePoses.set(p.id, p);
      if (p.kind === KIND.TRAM) {
        const car = (p.flags & LONG_TRAM) !== 0 ? TRAM.long : TRAM.short;
        trails.feed(p.id, p.x, p.z, p.heading, car.length);
        if (trams >= MAX.tram || !inView(p.x, p.z, car.length + 6)) continue;
        const grow = Math.max(0.01, Math.min(1, p.age / 500)) * 1.15;
        const sections = trails.sections(p.id, car.length, car.sections, sectionPoses);
        const along = (car.length / car.sections - TRAM_JOINT) / TRAM_MODEL;
        sections.forEach((q, j) => {
          const k = counts.tram++;
          idLists.tram[k] = p.id;
          tmp.position.set(q.x, 0.2, q.z);
          tmp.rotation.set(0, q.heading, 0);
          // 15% larger across like every vehicle, true length along the track.
          tmp.scale.set(grow, grow, along);
          tmp.updateMatrix();
          for (const part of TRAM_SECTION_PARTS) meshes[part]?.setMatrixAt(k, tmp.matrix);
          if (j === Math.floor(car.sections / 2)) meshes.tramPanto?.setMatrixAt(trams, tmp.matrix);
          if (j === car.sections - 1) meshes.tramTails?.setMatrixAt(trams, tmp.matrix);
        });
        meshes.tramTails?.setColorAt(trams, (p.flags & 1) !== 0 ? TAIL_ON : TAIL_OFF);
        trams++;
        // Overlays (selection ring, label, camera follow) take the middle of the car, not its front.
        p.x = sections.reduce((a, q) => a + q.x, 0) / sections.length;
        p.z = sections.reduce((a, q) => a + q.z, 0) / sections.length;
        continue;
      }
      if (!inView(p.x, p.z, 12)) continue;
      const group: Group =
        p.kind === KIND.TAXI ? 'taxi' : p.kind === KIND.BUS ? 'bus' : p.kind === KIND.TROLLEY ? 'trolley' : p.kind === KIND.MINIBUS ? 'minibus' : 'car';
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
      const signal = lit ? p.flags & (SIGNAL_LEFT | SIGNAL_RIGHT) : 0;
      const signalling = group as (typeof SIGNALLING)[number];
      const lamps = meshes[`${signalling}Blink`];
      if (signal && lamps) {
        // The right side is the left one mirrored.
        if (signal & SIGNAL_RIGHT) {
          tmp.scale.x = -tmp.scale.x;
          tmp.updateMatrix();
        }
        lamps.setMatrixAt(blinks[signalling]++, tmp.matrix);
        if (signal & SIGNAL_RIGHT) {
          tmp.scale.x = -tmp.scale.x;
          tmp.updateMatrix();
        }
      }
      if (group === 'taxi') {
        for (const part of ['taxiBody', 'taxiCabin', 'taxiWheels', 'taxiTails', 'taxiSign'] as const) meshes[part]?.setMatrixAt(k, tmp.matrix);
        meshes.taxiTails?.setColorAt(k, braking ? TAIL_ON : TAIL_OFF);
        const sign = p.activity === FREE ? SIGN_FREE : p.activity === TO_PICKUP || p.activity === AT_PICKUP ? SIGN_PICKUP : SIGN_OFF;
        meshes.taxiSign?.setColorAt(k, sign);
        const mine = parkFilter !== null && parkOf.get(p.id) === parkFilter;
        meshes.taxiBody?.setColorAt(k, parkFilter === null || mine ? TAXI_ON : TAXI_DIM);
        if (mine && meshes.taxiHalo) {
          tmp.position.set(p.x, 0.26, p.z);
          tmp.rotation.set(-Math.PI / 2, 0, 0);
          tmp.scale.setScalar(pulse);
          tmp.updateMatrix();
          meshes.taxiHalo.setMatrixAt(halos++, tmp.matrix);
        }
      } else if (group === 'car') {
        for (const part of ['carBody', 'carCabin', 'carWheels', 'carTails'] as const) meshes[part]?.setMatrixAt(k, tmp.matrix);
        const hash = hashId(p.id);
        meshes.carBody?.setColorAt(k, carColors[hash % carColors.length]!);
        meshes.carTails?.setColorAt(k, braking ? TAIL_ON : TAIL_OFF);
      } else {
        for (const part of partsOf(group)) meshes[part]?.setMatrixAt(k, tmp.matrix);
        meshes[`${group}Tails`]?.setColorAt(k, braking ? TAIL_ON : TAIL_OFF);
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
    for (const group of TRANSIT) apply(group, partsOf(group));
    apply('tram', TRAM_SECTION_PARTS);
    counts.tram = trams;
    apply('tram', ['tramPanto', 'tramTails'] as const);
    for (const group of SIGNALLING) {
      const m = meshes[`${group}Blink`];
      if (!m) continue;
      m.count = blinks[group];
      m.boundingSphere = WORLD_SPHERE;
      m.instanceMatrix.needsUpdate = true;
    }
    trails.prune();
    const halo = meshes.taxiHalo;
    if (halo) {
      halo.count = halos;
      halo.boundingSphere = WORLD_SPHERE;
      halo.instanceMatrix.needsUpdate = true;
    }
  });

  const pick = (group: Group) => (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    const id = e.instanceId !== undefined ? ids.current[group][e.instanceId] : undefined;
    if (!id) return;
    select(group === 'taxi' ? { kind: 'taxi', id } : group === 'car' ? { kind: 'car', id } : { kind: 'bus', id });
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

  // Created once: the component re-renders when the fleet list refreshes.
  const c = useMemo(
    () => ({
      taxiBody: withColors(MAX.taxi, palette.taxi),
      taxiTails: withColors(MAX.taxi, '#7A2530'),
      taxiSign: withColors(MAX.taxi, '#4A4F5A'),
      carBody: withColors(MAX.car, '#FFFFFF'),
      carTails: withColors(MAX.car, '#7A2530'),
      busTails: withColors(MAX.bus, '#7A2530'),
      trolleyTails: withColors(MAX.trolley, '#7A2530'),
      minibusTails: withColors(MAX.minibus, '#7A2530'),
      tramTails: withColors(MAX.tram, '#7A2530'),
    }),
    [],
  );

  return (
    <group>
      {/* Taxis: the hero objects — saturated Kolo yellow. */}
      <instancedMesh ref={bind('taxiBody')} args={[g.carBody, undefined, MAX.taxi]} castShadow frustumCulled={false} instanceColor={c.taxiBody} {...handlers('taxi')}>
        <meshStandardMaterial roughness={0.35} metalness={0.05} />
      </instancedMesh>
      {/* Partner halo under the filtered park's taxis. */}
      <instancedMesh ref={bind('taxiHalo')} args={[g.halo, undefined, MAX.taxi]} frustumCulled={false} renderOrder={2}>
        <meshBasicMaterial color={palette.depot} transparent opacity={0.75} depthWrite={false} />
      </instancedMesh>
      <instancedMesh ref={bind('taxiCabin')} args={[g.carCabin, undefined, MAX.taxi]} frustumCulled={false} {...handlers('taxi')}>
        <meshStandardMaterial color={palette.glass} roughness={0.2} metalness={0.3} />
      </instancedMesh>
      <instancedMesh ref={bind('taxiWheels')} args={[g.carWheels, undefined, MAX.taxi]} frustumCulled={false}>
        <meshStandardMaterial color="#20232A" roughness={0.8} />
      </instancedMesh>
      <instancedMesh ref={bind('taxiTails')} args={[g.tails, undefined, MAX.taxi]} frustumCulled={false} instanceColor={c.taxiTails}>
        <meshBasicMaterial toneMapped={false} />
      </instancedMesh>
      <instancedMesh ref={bind('taxiBlink')} args={[g.carBlink, undefined, MAX.taxi]} frustumCulled={false}>
        <meshBasicMaterial color={palette.blinker} toneMapped={false} side={THREE.DoubleSide} />
      </instancedMesh>
      <instancedMesh ref={bind('taxiSign')} args={[g.sign, undefined, MAX.taxi]} frustumCulled={false} instanceColor={c.taxiSign}>
        <meshBasicMaterial toneMapped={false} />
      </instancedMesh>

      {/* Background cars: neutral greys and whites. */}
      <instancedMesh ref={bind('carBody')} args={[g.carBody, undefined, MAX.car]} castShadow frustumCulled={false} instanceColor={c.carBody} {...handlers('car')}>
        <meshStandardMaterial roughness={0.45} />
      </instancedMesh>
      <instancedMesh ref={bind('carCabin')} args={[g.carCabin, undefined, MAX.car]} frustumCulled={false}>
        <meshStandardMaterial color={palette.glass} roughness={0.25} metalness={0.25} />
      </instancedMesh>
      <instancedMesh ref={bind('carWheels')} args={[g.carWheels, undefined, MAX.car]} frustumCulled={false}>
        <meshStandardMaterial color="#20232A" roughness={0.8} />
      </instancedMesh>
      <instancedMesh ref={bind('carTails')} args={[g.tails, undefined, MAX.car]} frustumCulled={false} instanceColor={c.carTails}>
        <meshBasicMaterial toneMapped={false} />
      </instancedMesh>
      <instancedMesh ref={bind('carBlink')} args={[g.carBlink, undefined, MAX.car]} frustumCulled={false}>
        <meshBasicMaterial color={palette.blinker} toneMapped={false} side={THREE.DoubleSide} />
      </instancedMesh>

      {/* Public transport: buses cobalt (the second accent of the city), trolleybuses teal, minibuses light cobalt. */}
      {TRANSIT.map((group) => (
        <group key={group}>
          <instancedMesh ref={bind(`${group}Body`)} args={[g.transit[group].Body, undefined, MAX[group]]} castShadow frustumCulled={false} {...handlers(group)}>
            <meshStandardMaterial color={TRANSIT_COLOR[group]} roughness={0.4} />
          </instancedMesh>
          <instancedMesh ref={bind(`${group}Glass`)} args={[g.transit[group].Glass, undefined, MAX[group]]} frustumCulled={false} {...handlers(group)}>
            <meshStandardMaterial color="#1B2A4A" roughness={0.2} metalness={0.3} />
          </instancedMesh>
          <instancedMesh ref={bind(`${group}Roof`)} args={[g.transit[group].Roof, undefined, MAX[group]]} frustumCulled={false}>
            <meshStandardMaterial color="#F4F7FF" roughness={0.6} />
          </instancedMesh>
          <instancedMesh ref={bind(`${group}Wheels`)} args={[g.transit[group].Wheels, undefined, MAX[group]]} frustumCulled={false}>
            <meshStandardMaterial color="#20232A" roughness={0.8} />
          </instancedMesh>
          <instancedMesh ref={bind(`${group}Tails`)} args={[g.transit[group].Tails, undefined, MAX[group]]} frustumCulled={false} instanceColor={c[`${group}Tails`]}>
            <meshBasicMaterial toneMapped={false} />
          </instancedMesh>
          <instancedMesh ref={bind(`${group}Blink`)} args={[g.transit[group].Blink, undefined, MAX[group]]} frustumCulled={false}>
            <meshBasicMaterial color={palette.blinker} toneMapped={false} side={THREE.DoubleSide} />
          </instancedMesh>
          {g.transit[group].Poles && (
            <instancedMesh ref={bind(`${group}Poles`)} args={[g.transit[group].Poles, undefined, MAX[group]]} frustumCulled={false}>
              <meshStandardMaterial color={palette.wire} roughness={0.7} />
            </instancedMesh>
          )}
        </group>
      ))}

      {/* Trams: deep indigo sections on the track, a pantograph up to the tram wire; any section selects the tram. */}
      <instancedMesh ref={bind('tramBody')} args={[g.tram.Body, undefined, TRAM_SECTIONS]} castShadow frustumCulled={false} {...handlers('tram')}>
        <meshStandardMaterial color={palette.tram} roughness={0.4} />
      </instancedMesh>
      <instancedMesh ref={bind('tramGlass')} args={[g.tram.Glass, undefined, TRAM_SECTIONS]} frustumCulled={false} {...handlers('tram')}>
        <meshStandardMaterial color="#1B2A4A" roughness={0.2} metalness={0.3} />
      </instancedMesh>
      <instancedMesh ref={bind('tramRoof')} args={[g.tram.Roof, undefined, TRAM_SECTIONS]} frustumCulled={false} {...handlers('tram')}>
        <meshStandardMaterial color="#F4F7FF" roughness={0.6} />
      </instancedMesh>
      <instancedMesh ref={bind('tramWheels')} args={[g.tram.Wheels, undefined, TRAM_SECTIONS]} frustumCulled={false}>
        <meshStandardMaterial color="#20232A" roughness={0.8} />
      </instancedMesh>
      <instancedMesh ref={bind('tramTails')} args={[g.tram.Tails, undefined, MAX.tram]} frustumCulled={false} instanceColor={c.tramTails}>
        <meshBasicMaterial toneMapped={false} />
      </instancedMesh>
      <instancedMesh ref={bind('tramPanto')} args={[g.tram.Panto, undefined, MAX.tram]} frustumCulled={false}>
        <meshStandardMaterial color={palette.wire} roughness={0.7} />
      </instancedMesh>
    </group>
  );
}

/** Instanced meshes need a non-empty colour buffer before the first render. */
function withColors(count: number, color: string) {
  const arr = new Float32Array(count * 3);
  const col = new THREE.Color(color);
  for (let i = 0; i < count; i++) arr.set([col.r, col.g, col.b], i * 3);
  return new THREE.InstancedBufferAttribute(arr, 3);
}

/** Cars parked on local sidewalks: static, muted, not interactive; cut into chunks for culling. */
export function ParkedCars({ city }: { city: City }) {
  const lod = useUi((s) => s.lod);
  const cells = useMemo(() => chunkCells(city.parkedCars), [city]);
  const parts = useMemo((): InstancePart[] => {
    const colors = palette.cars.map((x) => new THREE.Color(x).lerp(PARKED_DUST, 0.25));
    // Sidewalk level, same 15% upscale as moving vehicles.
    const place = (i: number, o: THREE.Object3D) => {
      const car = city.parkedCars[i]!;
      o.position.set(car.x, -0.12, car.z);
      o.rotation.set(0, car.heading, 0);
      o.scale.setScalar(1.15);
    };
    return [
      {
        near: box(1.82, 0.66, 4.4, 0, 0.66, 0, 0.2),
        far: plainBox(1.82, 0.66, 4.4, 0, 0.66, 0),
        material: new THREE.MeshStandardMaterial({ roughness: 0.55 }),
        castShadow: true,
        receiveShadow: true,
        place,
        color: (i, c) => c.copy(colors[city.parkedCars[i]!.tint % colors.length]!),
      },
      {
        near: box(1.52, 0.5, 2.1, 0, 1.18, -0.25, 0.18),
        far: plainBox(1.52, 0.5, 2.1, 0, 1.18, -0.25),
        material: new THREE.MeshStandardMaterial({ color: palette.glass, roughness: 0.3, metalness: 0.2 }),
        place,
      },
      { near: wheels(0.84, [-1.35, 1.35], 0.33), far: null, material: new THREE.MeshStandardMaterial({ color: '#20232A', roughness: 0.8 }), place },
    ];
  }, [city]);
  return <ChunkedInstances cells={cells} parts={parts} lod={lod} />;
}

function hashId(id: string) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h;
}
