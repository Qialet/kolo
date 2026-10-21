'use client';

import type { ThreeEvent } from '@react-three/fiber';
import type { Building, City } from '@kolo/sim';
import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { palette } from '@/lib/palette';
import { useUi } from '@/lib/ui-store';
import { buildDepotMarkings, buildGroundGeometry, buildMarkingsGeometry, unitBuildingGeometry, withWindows } from './city-geometry';

const tmp = new THREE.Object3D();
const color = new THREE.Color();

export function CityStatic({ city }: { city: City }) {
  return (
    <group>
      <Ground city={city} />
      <Buildings city={city} />
      <Trees city={city} />
      <Depots city={city} />
      <BusStops city={city} />
    </group>
  );
}

function Ground({ city }: { city: City }) {
  const ground = useMemo(() => buildGroundGeometry(city), [city]);
  const markings = useMemo(() => buildMarkingsGeometry(city), [city]);
  const slots = useMemo(() => buildDepotMarkings(city), [city]);
  return (
    <group>
      {/* Asphalt everywhere; blocks sit on top of it. */}
      <mesh rotation-x={-Math.PI / 2} receiveShadow>
        <planeGeometry args={[1300, 1300]} />
        <meshStandardMaterial color={palette.asphalt} roughness={1} />
      </mesh>
      {/* Soft surroundings beyond the district. */}
      <mesh rotation-x={-Math.PI / 2} position-y={-0.05}>
        <planeGeometry args={[6000, 6000]} />
        <meshStandardMaterial color={palette.sky} roughness={1} />
      </mesh>
      <mesh geometry={ground} receiveShadow castShadow={false}>
        <meshStandardMaterial vertexColors roughness={0.95} />
      </mesh>
      <mesh geometry={markings} receiveShadow>
        <meshStandardMaterial vertexColors roughness={0.8} transparent opacity={0.92} polygonOffset polygonOffsetFactor={-2} />
      </mesh>
      <mesh geometry={slots}>
        <meshStandardMaterial vertexColors roughness={0.8} transparent opacity={0.7} polygonOffset polygonOffsetFactor={-2} />
      </mesh>
    </group>
  );
}

const buildingTint = (b: Building) => {
  if (b.kind === 'garage') return '#FFE2D6';
  if (b.kind === 'depot-office') return '#E6E0FF';
  if (b.kind === 'poi') return palette.poiTint;
  if (b.kind === 'stall') return '#FFFFFF';
  return palette.buildingTints[b.tint % palette.buildingTints.length]!;
};

function Buildings({ city }: { city: City }) {
  const ref = useRef<THREE.InstancedMesh>(null);
  const geometry = useMemo(() => unitBuildingGeometry(), []);
  const material = useMemo(() => withWindows(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0 })), []);
  const select = useUi((s) => s.select);
  const hover = useUi((s) => s.hover);
  const selection = useUi((s) => s.selection);

  useEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    city.buildings.forEach((b, i) => {
      tmp.position.set(b.x, 0.2, b.z);
      tmp.scale.set(b.w, b.h, b.d);
      tmp.rotation.set(0, 0, 0);
      tmp.updateMatrix();
      mesh.setMatrixAt(i, tmp.matrix);
      color.set(buildingTint(b));
      if (selection?.kind === 'building' && selection.id === b.id) color.set('#FFF1C2');
      mesh.setColorAt(i, color);
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
  }, [city, selection]);

  const onClick = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    const b = e.instanceId !== undefined ? city.buildings[e.instanceId] : undefined;
    if (b) select({ kind: 'building', id: b.id });
  };

  return (
    <instancedMesh
      ref={ref}
      args={[geometry, material, city.buildings.length]}
      castShadow
      receiveShadow
      onClick={onClick}
      onPointerOver={(e) => {
        e.stopPropagation();
        hover(e.instanceId !== undefined ? `building:${city.buildings[e.instanceId]?.id}` : null);
      }}
      onPointerOut={() => hover(null)}
    />
  );
}

function Trees({ city }: { city: City }) {
  const crowns = useRef<THREE.InstancedMesh>(null);
  const trunks = useRef<THREE.InstancedMesh>(null);
  useEffect(() => {
    city.trees.forEach((t, i) => {
      tmp.rotation.set(0, (i * 1.37) % Math.PI, 0);
      tmp.position.set(t.x, 0.2 + t.h * 0.62, t.z);
      tmp.scale.set(t.r, t.h * 0.42, t.r);
      tmp.updateMatrix();
      crowns.current?.setMatrixAt(i, tmp.matrix);
      color.set(i % 3 === 0 ? palette.treeDark : palette.tree);
      crowns.current?.setColorAt(i, color);
      tmp.position.set(t.x, 0.2 + t.h * 0.2, t.z);
      tmp.scale.set(0.22, t.h * 0.4, 0.22);
      tmp.updateMatrix();
      trunks.current?.setMatrixAt(i, tmp.matrix);
    });
    for (const m of [crowns.current, trunks.current]) {
      if (!m) continue;
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
      m.computeBoundingSphere();
    }
  }, [city]);
  return (
    <group>
      <instancedMesh ref={crowns} args={[undefined, undefined, city.trees.length]} castShadow>
        <icosahedronGeometry args={[1, 1]} />
        <meshStandardMaterial roughness={0.9} flatShading />
      </instancedMesh>
      <instancedMesh ref={trunks} args={[undefined, undefined, city.trees.length]}>
        <cylinderGeometry args={[1, 1, 1, 6]} />
        <meshStandardMaterial color={palette.trunk} roughness={1} />
      </instancedMesh>
    </group>
  );
}

function Depots({ city }: { city: City }) {
  const select = useUi((s) => s.select);
  return (
    <group>
      {city.depots.map((depot) => {
        const lotW = depot.lot.x1 - depot.lot.x0;
        const lotD = depot.lot.z1 - depot.lot.z0;
        return (
          <group key={depot.id}>
            {/* Invisible pick surface over the lot. */}
            <mesh
              position={[(depot.lot.x0 + depot.lot.x1) / 2, 0.24, (depot.lot.z0 + depot.lot.z1) / 2]}
              rotation-x={-Math.PI / 2}
              onClick={(e) => {
                e.stopPropagation();
                select({ kind: 'depot', id: depot.id });
              }}
            >
              <planeGeometry args={[lotW, lotD]} />
              <meshBasicMaterial transparent opacity={0} depthWrite={false} />
            </mesh>
            {/* Violet boundary of the partner yard. */}
            <lineSegments position-y={0.26}>
              <edgesGeometry args={[new THREE.BoxGeometry(lotW - 1, 0.01, lotD - 1).translate((depot.lot.x0 + depot.lot.x1) / 2, 0, (depot.lot.z0 + depot.lot.z1) / 2)]} />
              <lineBasicMaterial color={palette.depot} />
            </lineSegments>
            {/* Coral service box doors. */}
            {depot.boxes.map((box, i) => {
              const back = { x: Math.sin(box.heading), z: Math.cos(box.heading) };
              return (
                <mesh key={i} position={[box.x - back.x * 4.2, 1.9, box.z - back.z * 4.2]} rotation-y={box.heading}>
                  <boxGeometry args={[3.6, 3.4, 0.5]} />
                  <meshStandardMaterial color={palette.service} roughness={0.6} />
                </mesh>
              );
            })}
            {/* Gate. */}
            <mesh position={[depot.gate.x, 0.3, depot.gate.z]}>
              <boxGeometry args={[1.2, 0.6, 1.2]} />
              <meshStandardMaterial color={palette.depot} />
            </mesh>
          </group>
        );
      })}
    </group>
  );
}

function BusStops({ city }: { city: City }) {
  const select = useUi((s) => s.select);
  return (
    <group>
      {city.busStops.map((stop) => (
        <group
          key={stop.id}
          position={[stop.x, 0.2, stop.z]}
          rotation-y={stop.heading}
          onClick={(e) => {
            e.stopPropagation();
            select({ kind: 'stop', id: stop.id });
          }}
        >
          <mesh position={[0, 2.5, 0]} castShadow>
            <boxGeometry args={[1.5, 0.14, 4.2]} />
            <meshStandardMaterial color={palette.bus} roughness={0.5} />
          </mesh>
          <mesh position={[-0.6, 1.25, 0]}>
            <boxGeometry args={[0.08, 2.4, 3.8]} />
            <meshStandardMaterial color="#DDE8FF" transparent opacity={0.65} />
          </mesh>
          <mesh position={[0.5, 1.6, -2.6]}>
            <cylinderGeometry args={[0.07, 0.07, 3.2, 6]} />
            <meshStandardMaterial color={palette.pole} />
          </mesh>
          <mesh position={[0.5, 3.2, -2.6]}>
            <boxGeometry args={[0.7, 0.7, 0.12]} />
            <meshStandardMaterial color={palette.bus} emissive={palette.bus} emissiveIntensity={0.35} />
          </mesh>
          {/* Cobalt bay marking on the curb lane (the road is on local +X). */}
          <mesh position={[3.4, -0.16, 0]} rotation-x={-Math.PI / 2}>
            <planeGeometry args={[2.6, 13]} />
            <meshBasicMaterial color={palette.bus} transparent opacity={0.16} depthWrite={false} />
          </mesh>
        </group>
      ))}
    </group>
  );
}
