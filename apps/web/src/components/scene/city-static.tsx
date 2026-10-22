'use client';

import type { ThreeEvent } from '@react-three/fiber';
import type { City } from '@kolo/sim';
import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { palette } from '@/lib/palette';
import { chunkCells } from '@/lib/lod';
import { useUi } from '@/lib/ui-store';
import { ChunkedInstances, type InstancePart } from './chunked';
import {
  buildBuildingChunks,
  buildDepotGeometry,
  buildGroundGeometry,
  buildingOfTriangle,
  buildMarkingsGeometry,
  buildPlaygroundGeometry,
  buildRoadGeometry,
  buildTrackGeometry,
  buildWireGeometry,
  type BuildingChunk,
  flatPolygon,
  LEVEL,
  platformOf,
  withWindows,
} from './city-geometry';

const tmp = new THREE.Object3D();

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
  const { chunks, triangles, ms } = useMemo(() => buildBuildingChunks(city), [city]);
  useEffect(() => {
    if (process.env.NODE_ENV !== 'production') console.info(`[kolo] buildings: ${city.buildings.length} in ${chunks.length} chunks, ${triangles} triangles, ${ms} ms`);
  }, [city, chunks, triangles, ms]);
  // Window rows turn to moiré from afar: the far level paints plain walls.
  const materials = useMemo(
    () => ({
      near: withWindows(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0 })),
      far: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0 }),
    }),
    [],
  );
  const lod = useUi((s) => s.lod);
  const select = useUi((s) => s.select);
  const hover = useUi((s) => s.hover);
  const buildingAt = (chunk: BuildingChunk, e: ThreeEvent<PointerEvent | MouseEvent>) =>
    e.faceIndex !== undefined && e.faceIndex !== null ? city.buildings[chunk.buildings[buildingOfTriangle(chunk.firstTriangle, e.faceIndex)]!] : undefined;
  return (
    <group>
      {chunks.map((chunk) => (
        <mesh
          key={chunk.key}
          geometry={chunk.geometry}
          material={materials[lod]}
          castShadow
          receiveShadow
          onClick={(e) => {
            e.stopPropagation();
            const b = buildingAt(chunk, e);
            if (b) select({ kind: 'building', id: b.id });
          }}
          onPointerMove={(e) => {
            e.stopPropagation();
            const b = buildingAt(chunk, e);
            hover(b ? `building:${b.id}` : null);
          }}
          onPointerOut={() => hover(null)}
        />
      ))}
    </group>
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
  const lod = useUi((s) => s.lod);
  const cells = useMemo(() => chunkCells(city.trees), [city]);
  const parts = useMemo((): InstancePart[] => {
    const crown = new THREE.MeshStandardMaterial({ roughness: 0.9, flatShading: true });
    const trunk = new THREE.MeshStandardMaterial({ color: palette.trunk, roughness: 1 });
    const dark = new THREE.Color(palette.treeDark);
    const light = new THREE.Color(palette.tree);
    return [
      {
        near: new THREE.IcosahedronGeometry(1, 1),
        far: new THREE.IcosahedronGeometry(1, 0),
        material: crown,
        castShadow: true,
        place: (i, o) => {
          const t = city.trees[i]!;
          o.rotation.set(0, (i * 1.37) % Math.PI, 0);
          o.position.set(t.x, LEVEL.ground + t.h * 0.62, t.z);
          o.scale.set(t.r, t.h * 0.42, t.r);
        },
        color: (i, c) => c.copy(i % 3 === 0 ? dark : light),
      },
      {
        near: new THREE.CylinderGeometry(1, 1, 1, 6),
        far: null,
        material: trunk,
        place: (i, o) => {
          const t = city.trees[i]!;
          o.position.set(t.x, LEVEL.ground + t.h * 0.2, t.z);
          o.scale.set(0.22, t.h * 0.4, 0.22);
        },
      },
    ];
  }, [city]);
  return <ChunkedInstances cells={cells} parts={parts} lod={lod} />;
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

/** Shelters of all stops as four instanced parts; a click on any part selects the stop. */
function BusStops({ city }: { city: City }) {
  const select = useUi((s) => s.select);
  const refs = useRef<(THREE.InstancedMesh | null)[]>([]);
  const parts = useMemo(() => {
    const at = (g: THREE.BufferGeometry, x: number, y: number, z: number) => g.translate(x, y, z);
    return [
      { geometry: at(new THREE.BoxGeometry(1.5, 0.14, 4.2), 0, 2.5, 0), material: new THREE.MeshStandardMaterial({ color: palette.bus, roughness: 0.5 }), castShadow: true },
      { geometry: at(new THREE.BoxGeometry(0.08, 2.4, 3.8), -0.6, 1.25, 0), material: new THREE.MeshStandardMaterial({ color: '#DDE8FF', transparent: true, opacity: 0.65 }), castShadow: false },
      { geometry: at(new THREE.CylinderGeometry(0.07, 0.07, 3.2, 6), 0.5, 1.6, -2.6), material: new THREE.MeshStandardMaterial({ color: palette.pole }), castShadow: false },
      {
        geometry: at(new THREE.BoxGeometry(0.7, 0.7, 0.12), 0.5, 3.2, -2.6),
        material: new THREE.MeshStandardMaterial({ color: palette.bus, emissive: palette.bus, emissiveIntensity: 0.35 }),
        castShadow: false,
      },
    ];
  }, []);
  useLayoutEffect(() => {
    city.busStops.forEach((stop, i) => {
      // Tram-only stops: the shelter stands on the platform; left of the track it turns round to face it.
      tmp.position.set(stop.x, platformOf(city, stop) ? LEVEL.platform : LEVEL.ground, stop.z);
      tmp.rotation.set(0, stop.heading + ((stop.platform ?? 0) < 0 ? Math.PI : 0), 0);
      tmp.updateMatrix();
      for (const m of refs.current) m?.setMatrixAt(i, tmp.matrix);
    });
    for (const m of refs.current) {
      if (!m) continue;
      m.instanceMatrix.needsUpdate = true;
      m.computeBoundingSphere();
    }
  }, [city]);
  return (
    <group>
      {parts.map((p, k) => (
        <instancedMesh
          key={k}
          ref={(m) => {
            refs.current[k] = m;
          }}
          args={[p.geometry, p.material, city.busStops.length]}
          castShadow={p.castShadow}
          onClick={(e) => {
            e.stopPropagation();
            const stop = e.instanceId !== undefined ? city.busStops[e.instanceId] : undefined;
            if (stop) select({ kind: 'stop', id: stop.id });
          }}
        />
      ))}
    </group>
  );
}
