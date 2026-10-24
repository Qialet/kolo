'use client';

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
  /** Facing the traffic it is for. */
  heading: number;
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

/**
 * Each sign is a grey back plate, a border plate on its face and a smaller inner one in front: polygon prisms
 * (a cylinder with as many sides), so they keep their shape from any side like the light heads.
 */
const PLATES: Record<TrafficSign['kind'], { sides: number; start: number; outer: number; inner: number; border: string; face: string }> = {
  // Point down.
  giveWay: { sides: 3, start: 0, outer: 1.1, inner: 0.72, border: palette.signRed, face: palette.signWhite },
  // Flat top.
  stop: { sides: 8, start: Math.PI / 8, outer: 0.84, inner: 0.74, border: palette.signWhite, face: palette.signRed },
  priority: { sides: 4, start: 0, outer: 0.88, inner: 0.6, border: palette.signWhite, face: palette.signYellow },
};
const KINDS = Object.keys(PLATES) as TrafficSign['kind'][];

/** Plate layers: distance in front of the pole and thickness. */
const BACK = { ahead: 0.12, depth: 0.06 };
const BORDER = { ahead: 0.16, depth: 0.02 };
const FACE = { ahead: 0.18, depth: 0.02 };

const tmp = new THREE.Object3D();

function placeSigns(city: City): { signs: Placed[]; bars: Bar[] } {
  const signs: Placed[] = [];
  const bars: Bar[] = [];
  for (const sign of city.signs) {
    const seg = city.segments[sign.seg]!;
    const w = city.streets[seg.street]!.laneWidth;
    const lanes = seg.lanes.map((l) => city.lanes[l]!);
    const curb = lanes[lanes.length - 1]!;
    const d = endTangent(curb.line);
    // On the kerb just before the stop line.
    const p = poseAlong(curb.line, Math.max(0, curb.length - 2.5), w / 2 + 1.4);
    signs.push({ kind: sign.kind, x: p.x, z: p.z, heading: headingOf({ x: -d.x, z: -d.z }) });
    if (sign.kind === 'stop') {
      const inner = lanes[0]!;
      const a = poseAlong(inner.line, inner.length - 0.3, -w / 2);
      const b = poseAlong(curb.line, curb.length - 0.3, w / 2);
      bars.push({ x: (a.x + b.x) / 2, z: (a.z + b.z) / 2, w: Math.hypot(b.x - a.x, b.z - a.z), heading: headingOf(d) });
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
    tmp.scale.set(1, 1, 1);
    signs.forEach((s, i) => {
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

/** Plates of one kind, upright on their poles and turned to their approach. */
function SignPlates({ kind, signs }: { kind: TrafficSign['kind']; signs: Placed[] }) {
  const mine = useMemo(() => signs.filter((s) => s.kind === kind), [signs, kind]);
  const plate = PLATES[kind];
  const back = useRef<THREE.InstancedMesh>(null);
  const border = useRef<THREE.InstancedMesh>(null);
  const face = useRef<THREE.InstancedMesh>(null);

  useLayoutEffect(() => {
    tmp.scale.set(1, 1, 1);
    mine.forEach((s, i) => {
      // The prism axis is laid along the heading: X first stands it up, Y turns it.
      tmp.rotation.set(Math.PI / 2, s.heading, 0, 'YXZ');
      for (const [ref, layer] of [
        [back, BACK],
        [border, BORDER],
        [face, FACE],
      ] as const) {
        tmp.position.set(s.x + Math.sin(s.heading) * layer.ahead, PLATE_Y, s.z + Math.cos(s.heading) * layer.ahead);
        tmp.updateMatrix();
        ref.current?.setMatrixAt(i, tmp.matrix);
      }
    });
    tmp.rotation.set(0, 0, 0, 'XYZ');
    for (const m of [back, border, face]) {
      if (!m.current) continue;
      m.current.instanceMatrix.needsUpdate = true;
      m.current.computeBoundingSphere();
    }
  }, [mine]);

  return (
    <>
      <instancedMesh ref={back} args={[undefined, undefined, mine.length]} castShadow>
        <cylinderGeometry args={[plate.outer, plate.outer, BACK.depth, plate.sides, 1, false, plate.start]} />
        <meshStandardMaterial color={palette.signBack} roughness={0.6} />
      </instancedMesh>
      <instancedMesh ref={border} args={[undefined, undefined, mine.length]}>
        <cylinderGeometry args={[plate.outer, plate.outer, BORDER.depth, plate.sides, 1, false, plate.start]} />
        <meshBasicMaterial color={plate.border} toneMapped={false} />
      </instancedMesh>
      <instancedMesh ref={face} args={[undefined, undefined, mine.length]}>
        <cylinderGeometry args={[plate.inner, plate.inner, FACE.depth, plate.sides, 1, false, plate.start]} />
        <meshBasicMaterial color={plate.face} toneMapped={false} />
      </instancedMesh>
    </>
  );
}
