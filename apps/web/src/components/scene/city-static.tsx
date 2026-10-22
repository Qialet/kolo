'use client';

import type { ThreeEvent } from '@react-three/fiber';
import type { City } from '@kolo/sim';
import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { palette } from '@/lib/palette';
import { useUi } from '@/lib/ui-store';
import {
  buildBuildingGeometry,
  buildDepotGeometry,
  buildGroundGeometry,
  buildingOfTriangle,
  buildMarkingsGeometry,
  buildPlaygroundGeometry,
  buildRoadGeometry,
  buildTrackGeometry,
  buildWireGeometry,
  flatPolygon,
  LEVEL,
  platformOf,
  withWindows,
} from './city-geometry';

const tmp = new THREE.Object3D();
const color = new THREE.Color();

export function CityStatic({ city }: { city: City }) {
  return (
    <group>
      <Ground city={city} />
      <Buildings city={city} />
      <Trees city={city} />
      <Playgrounds city={city} />
      <Depots city={city} />
      <Tracks city={city} />
      <BusStops city={city} />
      <TrolleyWires city={city} />
    </group>
  );
}

function Ground({ city }: { city: City }) {
  const ground = useMemo(() => buildGroundGeometry(city), [city]);
  const roads = useMemo(() => buildRoadGeometry(city), [city]);
  const markings = useMemo(() => buildMarkingsGeometry(city), [city]);
  const depots = useMemo(() => buildDepotGeometry(city), [city]);
  const b = city.bounds;
  return (
    <group>
      {/* Soft surroundings beyond the district. */}
      <mesh rotation-x={-Math.PI / 2} position={[(b.x0 + b.x1) / 2, LEVEL.ground - 0.05, (b.z0 + b.z1) / 2]}>
        <planeGeometry args={[12000, 12000]} />
        <meshStandardMaterial color={palette.sky} roughness={1} />
      </mesh>
      <mesh geometry={ground} receiveShadow>
        <meshStandardMaterial vertexColors roughness={0.95} />
      </mesh>
      <mesh geometry={roads} receiveShadow>
        <meshStandardMaterial vertexColors roughness={1} />
      </mesh>
      <mesh geometry={depots.lots} receiveShadow>
        <meshStandardMaterial vertexColors roughness={0.95} />
      </mesh>
      <mesh geometry={markings} receiveShadow>
        <meshStandardMaterial vertexColors roughness={0.8} transparent opacity={0.92} polygonOffset polygonOffsetFactor={-2} />
      </mesh>
      <mesh geometry={depots.lines}>
        <meshStandardMaterial vertexColors roughness={0.8} transparent opacity={0.7} polygonOffset polygonOffsetFactor={-2} />
      </mesh>
    </group>
  );
}

function Buildings({ city }: { city: City }) {
  const { geometry, firstTriangle, triangles, ms } = useMemo(() => buildBuildingGeometry(city), [city]);
  useEffect(() => {
    if (process.env.NODE_ENV !== 'production') console.info(`[kolo] buildings: ${city.buildings.length}, ${triangles} triangles, ${ms} ms`);
  }, [city, triangles, ms]);
  const material = useMemo(() => withWindows(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0 })), []);
  const select = useUi((s) => s.select);
  const hover = useUi((s) => s.hover);
  const buildingAt = (e: ThreeEvent<PointerEvent | MouseEvent>) =>
    e.faceIndex !== undefined && e.faceIndex !== null ? city.buildings[buildingOfTriangle(firstTriangle, e.faceIndex)] : undefined;
  return (
    <mesh
      geometry={geometry}
      material={material}
      castShadow
      receiveShadow
      onClick={(e) => {
        e.stopPropagation();
        const b = buildingAt(e);
        if (b) select({ kind: 'building', id: b.id });
      }}
      onPointerMove={(e) => {
        e.stopPropagation();
        const b = buildingAt(e);
        hover(b ? `building:${b.id}` : null);
      }}
      onPointerOut={() => hover(null)}
    />
  );
}

function Playgrounds({ city }: { city: City }) {
  const geometry = useMemo(() => buildPlaygroundGeometry(city), [city]);
  return (
    <mesh geometry={geometry} castShadow receiveShadow>
      <meshStandardMaterial vertexColors roughness={0.8} />
    </mesh>
  );
}

function Trees({ city }: { city: City }) {
  const crowns = useRef<THREE.InstancedMesh>(null);
  const trunks = useRef<THREE.InstancedMesh>(null);
  useEffect(() => {
    city.trees.forEach((t, i) => {
      tmp.rotation.set(0, (i * 1.37) % Math.PI, 0);
      tmp.position.set(t.x, LEVEL.ground + t.h * 0.62, t.z);
      tmp.scale.set(t.r, t.h * 0.42, t.r);
      tmp.updateMatrix();
      crowns.current?.setMatrixAt(i, tmp.matrix);
      color.set(i % 3 === 0 ? palette.treeDark : palette.tree);
      crowns.current?.setColorAt(i, color);
      tmp.position.set(t.x, LEVEL.ground + t.h * 0.2, t.z);
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
  const shapes = useMemo(
    () =>
      city.depots.map((d) => ({
        pick: flatPolygon(d.lot, [], LEVEL.depotLines + 0.01, palette.depot),
        outline: new THREE.Line(
          new THREE.BufferGeometry().setFromPoints([...d.lot, d.lot[0]!].map((p) => new THREE.Vector3(p.x, LEVEL.depotLines + 0.02, p.z))),
          new THREE.LineBasicMaterial({ color: palette.depot }),
        ),
      })),
    [city],
  );
  return (
    <group>
      {city.depots.map((depot, k) => (
        <group key={depot.id}>
          {/* Invisible pick surface over the lot. */}
          <mesh
            geometry={shapes[k]!.pick}
            onClick={(e) => {
              e.stopPropagation();
              select({ kind: 'depot', id: depot.id });
            }}
          >
            <meshBasicMaterial transparent opacity={0} depthWrite={false} />
          </mesh>
          {/* Violet boundary of the partner yard. */}
          <primitive object={shapes[k]!.outline} />
          {/* Coral service box doors on the garage front. */}
          {depot.boxes.map((box, i) => {
            const back = { x: Math.sin(box.heading), z: Math.cos(box.heading) };
            return (
              <mesh key={i} position={[box.x - back.x * 8.1, 1.9, box.z - back.z * 8.1]} rotation-y={box.heading}>
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
      ))}
    </group>
  );
}

/** Tram rails, the ballast bed off the street lanes and tram-only platforms. */
function Tracks({ city }: { city: City }) {
  const g = useMemo(() => buildTrackGeometry(city), [city]);
  return (
    <group>
      <mesh geometry={g.ballast} receiveShadow>
        <meshStandardMaterial vertexColors roughness={1} polygonOffset polygonOffsetFactor={-1} />
      </mesh>
      <mesh geometry={g.rails}>
        <meshStandardMaterial vertexColors roughness={0.45} metalness={0.4} polygonOffset polygonOffsetFactor={-3} />
      </mesh>
      <mesh geometry={g.platforms} castShadow receiveShadow>
        <meshStandardMaterial vertexColors roughness={0.9} />
      </mesh>
    </group>
  );
}

/** Trolleybus wire pairs and the single tram wire. */
function TrolleyWires({ city }: { city: City }) {
  const geometry = useMemo(() => buildWireGeometry(city), [city]);
  return (
    <lineSegments geometry={geometry}>
      <lineBasicMaterial color={palette.wire} transparent opacity={0.75} />
    </lineSegments>
  );
}

function BusStops({ city }: { city: City }) {
  const select = useUi((s) => s.select);
  return (
    <group>
      {city.busStops.map((stop) => (
        <group
          key={stop.id}
          // Tram-only stops: the shelter stands on the platform.
          position={[stop.x, platformOf(city, stop) ? LEVEL.platform : LEVEL.ground, stop.z]}
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
        </group>
      ))}
    </group>
  );
}
