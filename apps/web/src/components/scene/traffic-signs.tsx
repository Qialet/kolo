'use client';

import { useFrame } from '@react-three/fiber';
import { endTangent, headingOf, poseAlong, type City, type TrafficSign } from '@kolo/sim';
import { useLayoutEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { palette } from '@/lib/palette';
import { useUi } from '@/lib/ui-store';

interface Placed {
  kind: TrafficSign['kind'];
  /** Pole foot, on the kerb of the approach the sign controls. */
  x: number;
  z: number;
}

interface Bar {
  x: number;
  z: number;
  w: number;
  heading: number;
}

/** Plate centre height and the pole under it: about twice life size, like the traffic lights, to read from the camera. */
const PLATE_Y = 3.6;
const POLE_H = 3.2;

/** Each sign is an outer plate (border colour) and a smaller inner one in front of it. */
const PLATES: Record<TrafficSign['kind'], { sides: number; start: number; outer: number; inner: number; border: string; face: string }> = {
  // Point down.
  giveWay: { sides: 3, start: -Math.PI / 2, outer: 1.1, inner: 0.72, border: palette.signRed, face: palette.signWhite },
  // Flat top.
  stop: { sides: 8, start: Math.PI / 8, outer: 0.84, inner: 0.74, border: palette.signWhite, face: palette.signRed },
  priority: { sides: 4, start: 0, outer: 0.88, inner: 0.6, border: palette.signWhite, face: palette.signYellow },
};
const KINDS = Object.keys(PLATES) as TrafficSign['kind'][];

const tmp = new THREE.Object3D();
const look = new THREE.Vector3();

function placeSigns(city: City): { signs: Placed[]; bars: Bar[] } {
  const signs: Placed[] = [];
  const bars: Bar[] = [];
  for (const sign of city.signs) {
    const seg = city.segments[sign.seg]!;
    const w = city.streets[seg.street]!.laneWidth;
    const lanes = seg.lanes.map((l) => city.lanes[l]!);
    const curb = lanes[lanes.length - 1]!;
    // On the kerb just before the stop line.
    const p = poseAlong(curb.line, Math.max(0, curb.length - 2.5), w / 2 + 1.4);
    signs.push({ kind: sign.kind, x: p.x, z: p.z });
    if (sign.kind === 'stop') {
      const inner = lanes[0]!;
      const a = poseAlong(inner.line, inner.length - 0.3, -w / 2);
      const b = poseAlong(curb.line, curb.length - 0.3, w / 2);
      bars.push({ x: (a.x + b.x) / 2, z: (a.z + b.z) / 2, w: Math.hypot(b.x - a.x, b.z - a.z), heading: headingOf(endTangent(curb.line)) });
    }
  }
  return { signs, bars };
}

/** Give way, stop and priority road signs at junction approaches; hidden from afar. */
export function TrafficSigns({ city }: { city: City }) {
  const { signs, bars } = useMemo(() => placeSigns(city), [city]);
  const lod = useUi((s) => s.lod);
  const poles = useRef<THREE.InstancedMesh>(null);
  const stopBars = useRef<THREE.InstancedMesh>(null);

  useLayoutEffect(() => {
    tmp.rotation.set(0, 0, 0);
    signs.forEach((s, i) => {
      tmp.scale.set(1, 1, 1);
      tmp.position.set(s.x, POLE_H / 2, s.z);
      tmp.updateMatrix();
      poles.current?.setMatrixAt(i, tmp.matrix);
    });
    bars.forEach((b, i) => {
      tmp.rotation.set(0, b.heading, 0);
      tmp.scale.set(b.w, 1, 0.45);
      tmp.position.set(b.x, 0.045, b.z);
      tmp.updateMatrix();
      stopBars.current?.setMatrixAt(i, tmp.matrix);
    });
    for (const m of [poles, stopBars]) {
      if (!m.current) continue;
      m.current.instanceMatrix.needsUpdate = true;
      m.current.computeBoundingSphere();
    }
  }, [signs, bars]);

  return (
    <group visible={lod !== 'far'}>
      <instancedMesh ref={poles} args={[undefined, undefined, signs.length]} castShadow>
        <cylinderGeometry args={[0.08, 0.08, POLE_H, 6]} />
        <meshStandardMaterial color={palette.pole} roughness={0.6} />
      </instancedMesh>
      {KINDS.map((kind) => (
        <SignPlates key={kind} kind={kind} signs={signs} />
      ))}
      <instancedMesh ref={stopBars} args={[undefined, undefined, bars.length]}>
        <boxGeometry args={[1, 0.02, 1]} />
        <meshBasicMaterial color={palette.marking} toneMapped={false} />
      </instancedMesh>
    </group>
  );
}

/**
 * Plates of one kind, turned to the camera: from above an upright plate is mostly seen edge on or from
 * behind, while the pole's place on the kerb already tells which approach the sign is for.
 */
function SignPlates({ kind, signs }: { kind: TrafficSign['kind']; signs: Placed[] }) {
  const mine = useMemo(() => signs.filter((s) => s.kind === kind), [signs, kind]);
  const plate = PLATES[kind];
  const outer = useRef<THREE.InstancedMesh>(null);
  const inner = useRef<THREE.InstancedMesh>(null);
  /** Camera direction the matrices were last laid out for (NaN: not yet). */
  const laidFor = useRef({ x: NaN, y: NaN, z: NaN, n: -1 });

  useFrame(({ camera }) => {
    camera.getWorldDirection(look);
    const last = laidFor.current;
    if (Math.abs(look.x - last.x) + Math.abs(look.y - last.y) + Math.abs(look.z - last.z) < 1e-4 && last.n === mine.length) return;
    laidFor.current = { x: look.x, y: look.y, z: look.z, n: mine.length };
    const yaw = Math.atan2(-look.x, -look.z);
    const pitch = Math.asin(Math.min(1, -look.y));
    tmp.scale.set(1, 1, 1);
    tmp.rotation.set(-pitch, yaw, 0, 'YXZ');
    mine.forEach((s, i) => {
      for (const [ref, ahead] of [
        [outer, 0.1],
        [inner, 0.12],
      ] as const) {
        tmp.position.set(s.x - look.x * ahead, PLATE_Y - look.y * ahead, s.z - look.z * ahead);
        tmp.updateMatrix();
        ref.current?.setMatrixAt(i, tmp.matrix);
      }
    });
    tmp.rotation.set(0, 0, 0, 'XYZ');
    for (const m of [outer, inner]) {
      if (!m.current) continue;
      m.current.instanceMatrix.needsUpdate = true;
      m.current.computeBoundingSphere();
    }
  });

  return (
    <>
      <instancedMesh ref={outer} args={[undefined, undefined, mine.length]}>
        <circleGeometry args={[plate.outer, plate.sides, plate.start]} />
        <meshBasicMaterial color={plate.border} toneMapped={false} />
      </instancedMesh>
      <instancedMesh ref={inner} args={[undefined, undefined, mine.length]}>
        <circleGeometry args={[plate.inner, plate.sides, plate.start]} />
        <meshBasicMaterial color={plate.face} toneMapped={false} />
      </instancedMesh>
    </>
  );
}
