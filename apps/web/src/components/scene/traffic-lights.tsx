'use client';

import { useFrame, type ThreeEvent } from '@react-three/fiber';
import { LIGHT_ASPECTS } from '@kolo/contracts';
import { endTangent, headingOf, poseAlong, type City } from '@kolo/sim';
import { useLayoutEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { frameBuffer } from '@/lib/live';
import { palette } from '@/lib/palette';
import { useUi } from '@/lib/ui-store';

interface Approach {
  node: number;
  phase: number;
  /** Pole foot. */
  x: number;
  z: number;
  heading: number;
  /** Stop bar centre, width across the approach and its heading. */
  barX: number;
  barZ: number;
  barW: number;
  barHeading: number;
}

const tmp = new THREE.Object3D();
const RED = new THREE.Color(palette.red);
const AMBER = new THREE.Color(palette.amber);
const GREEN = new THREE.Color(palette.green);
const OFF = new THREE.Color(palette.lampOff);
const BAR_RED = new THREE.Color(palette.red).multiplyScalar(0.9);
const BAR_AMBER = new THREE.Color(palette.amber);
const BAR_GREEN = new THREE.Color(palette.green);

function approachesOf(city: City): Approach[] {
  const out: Approach[] = [];
  for (const node of city.nodes) {
    if (!node.signal) continue;
    for (const segId of node.in) {
      const seg = city.segments[segId]!;
      const w = city.streets[seg.street]!.laneWidth;
      const lanes = seg.lanes.map((l) => city.lanes[l]!);
      const curb = lanes[lanes.length - 1]!;
      // A track lying on a street lane obeys that street's light: a pole of its own would stand in the road.
      if (seg.rail && curb.twins?.some((t) => t.s1 >= curb.length - 1)) continue;
      const inner = lanes[0]!;
      const d = endTangent(curb.line);
      // Pole on the kerb just before the stop line, bar across all lanes of the approach.
      const pole = poseAlong(curb.line, curb.length - 1.2, w / 2 + 1.4);
      const a = poseAlong(inner.line, inner.length + 0.2, -w / 2);
      const b = poseAlong(curb.line, curb.length + 0.2, w / 2);
      out.push({
        node: node.id,
        phase: seg.phase,
        x: pole.x,
        z: pole.z,
        heading: headingOf({ x: -d.x, z: -d.z }),
        barX: (a.x + b.x) / 2,
        barZ: (a.z + b.z) / 2,
        barW: Math.hypot(b.x - a.x, b.z - a.z),
        barHeading: headingOf(d),
      });
    }
  }
  return out;
}

/** Lamp colours for an aspect index (see LIGHT_ASPECTS). */
function lamps(aspect: number, blinkOn: boolean): [THREE.Color, THREE.Color, THREE.Color, THREE.Color] {
  switch (LIGHT_ASPECTS[aspect]) {
    case 'RED':
      return [RED, OFF, OFF, BAR_RED];
    case 'RED_AMBER':
      return [RED, AMBER, OFF, BAR_RED];
    case 'GREEN':
      return [OFF, OFF, GREEN, BAR_GREEN];
    case 'AMBER':
      return [OFF, AMBER, OFF, BAR_AMBER];
    default:
      return [OFF, blinkOn ? AMBER : OFF, OFF, BAR_AMBER];
  }
}

export function TrafficLights({ city }: { city: City }) {
  const approaches = useMemo(() => approachesOf(city), [city]);
  const n = approaches.length;
  const poles = useRef<THREE.InstancedMesh>(null);
  const heads = useRef<THREE.InstancedMesh>(null);
  const red = useRef<THREE.InstancedMesh>(null);
  const amber = useRef<THREE.InstancedMesh>(null);
  const green = useRef<THREE.InstancedMesh>(null);
  const bars = useRef<THREE.InstancedMesh>(null);
  const select = useUi((s) => s.select);
  const selection = useUi((s) => s.selection);

  useLayoutEffect(() => {
    approaches.forEach((a, i) => {
      tmp.rotation.set(0, a.heading, 0);
      tmp.scale.set(1, 1, 1);
      tmp.position.set(a.x, 2.4, a.z);
      tmp.updateMatrix();
      poles.current?.setMatrixAt(i, tmp.matrix);
      tmp.position.set(a.x, 4.4, a.z);
      tmp.updateMatrix();
      heads.current?.setMatrixAt(i, tmp.matrix);
      const fwd = { x: Math.sin(a.heading) * 0.32, z: Math.cos(a.heading) * 0.32 };
      [red, amber, green].forEach((ref, k) => {
        tmp.position.set(a.x + fwd.x, 5.05 - k * 0.62, a.z + fwd.z);
        tmp.updateMatrix();
        ref.current?.setMatrixAt(i, tmp.matrix);
        ref.current?.setColorAt(i, OFF);
      });
      tmp.rotation.set(0, a.barHeading, 0);
      tmp.position.set(a.barX, 0.045, a.barZ);
      tmp.scale.set(a.barW, 1, 0.5);
      tmp.updateMatrix();
      bars.current?.setMatrixAt(i, tmp.matrix);
      bars.current?.setColorAt(i, BAR_RED);
    });
    for (const m of [poles, heads, red, amber, green, bars]) {
      if (!m.current) continue;
      m.current.instanceMatrix.needsUpdate = true;
      m.current.computeBoundingSphere();
    }
  }, [approaches]);

  useFrame(() => {
    const frame = frameBuffer.latest;
    if (!frame) return;
    const blinkOn = Math.floor(performance.now() / 600) % 2 === 0;
    for (let i = 0; i < n; i++) {
      const a = approaches[i]!;
      const st = frame.lights[a.node];
      if (!st) continue;
      const [r, y, g, bar] = lamps(st[a.phase]!, blinkOn);
      red.current?.setColorAt(i, r);
      amber.current?.setColorAt(i, y);
      green.current?.setColorAt(i, g);
      bars.current?.setColorAt(i, bar);
    }
    for (const m of [red, amber, green, bars]) if (m.current?.instanceColor) m.current.instanceColor.needsUpdate = true;
  });

  // Lamps are the roundest part of a junction: the far level takes a coarse sphere.
  const lod = useUi((s) => s.lod);
  const lamp = useMemo(() => ({ near: new THREE.SphereGeometry(0.26, 12, 8), far: new THREE.SphereGeometry(0.26, 6, 4) }), []);

  const onClick = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    const a = e.instanceId !== undefined ? approaches[e.instanceId] : undefined;
    if (a) select({ kind: 'light', id: a.node });
  };

  const selectedNode = selection?.kind === 'light' ? city.nodes[selection.id] : undefined;

  return (
    <group>
      <instancedMesh ref={poles} args={[undefined, undefined, n]} castShadow onClick={onClick}>
        <cylinderGeometry args={[0.11, 0.13, 4.8, 6]} />
        <meshStandardMaterial color={palette.pole} roughness={0.6} />
      </instancedMesh>
      <instancedMesh ref={heads} args={[undefined, undefined, n]} castShadow onClick={onClick}>
        <boxGeometry args={[0.62, 2.0, 0.5]} />
        <meshStandardMaterial color="#2B303A" roughness={0.5} />
      </instancedMesh>
      <instancedMesh ref={red} args={[lamp.near, undefined, n]} geometry={lod === 'far' ? lamp.far : lamp.near} onClick={onClick}>
        <meshBasicMaterial toneMapped={false} />
      </instancedMesh>
      <instancedMesh ref={amber} args={[lamp.near, undefined, n]} geometry={lod === 'far' ? lamp.far : lamp.near} onClick={onClick}>
        <meshBasicMaterial toneMapped={false} />
      </instancedMesh>
      <instancedMesh ref={green} args={[lamp.near, undefined, n]} geometry={lod === 'far' ? lamp.far : lamp.near} onClick={onClick}>
        <meshBasicMaterial toneMapped={false} />
      </instancedMesh>
      <instancedMesh ref={bars} args={[undefined, undefined, n]}>
        <boxGeometry args={[1, 0.02, 1]} />
        <meshBasicMaterial toneMapped={false} transparent opacity={0.85} />
      </instancedMesh>
      {selectedNode && <LightCountdown nodeId={selectedNode.id} x={selectedNode.x} z={selectedNode.z} />}
    </group>
  );
}

/** Highlight ring around the selected junction (the countdown text lives in SceneLabels). */
function LightCountdown({ x, z }: { nodeId: number; x: number; z: number }) {
  return (
    <mesh position={[x, 0.3, z]} rotation-x={-Math.PI / 2}>
      <ringGeometry args={[11, 12.2, 48]} />
      <meshBasicMaterial color={palette.taxi} transparent opacity={0.9} toneMapped={false} />
    </mesh>
  );
}
