'use client';

import { useLayoutEffect, useRef } from 'react';
import * as THREE from 'three';
import type { ChunkCell, Lod } from '@/lib/lod';

/** One instanced part of a static object (a tree crown, a parked car body). */
export interface InstancePart {
  near: THREE.BufferGeometry;
  /** Simpler model for the far level; null hides the part there. */
  far: THREE.BufferGeometry | null;
  material: THREE.Material;
  /** Casts a shadow at the near level only. */
  castShadow?: boolean;
  receiveShadow?: boolean;
  /** Places one instance of this part: item index into the source list. */
  place: (item: number, o: THREE.Object3D) => void;
  color?: (item: number, c: THREE.Color) => void;
}

const tmp = new THREE.Object3D();
const tint = new THREE.Color();

/**
 * Static instances cut into spatial chunks: each chunk is its own instanced mesh with a tight
 * bounding sphere, so three culls it against the view and against the sun's shadow camera.
 */
export function ChunkedInstances({ cells, parts, lod }: { cells: ChunkCell[]; parts: InstancePart[]; lod: Lod }) {
  return (
    <group>
      {cells.map((cell) =>
        parts.map((part, k) => <ChunkPart key={`${cell.key}/${k}`} items={cell.items} part={part} lod={lod} />),
      )}
    </group>
  );
}

function ChunkPart({ items, part, lod }: { items: number[]; part: InstancePart; lod: Lod }) {
  const mesh = useRef<THREE.InstancedMesh>(null);
  useLayoutEffect(() => {
    const m = mesh.current;
    if (!m) return;
    items.forEach((item, i) => {
      tmp.position.set(0, 0, 0);
      tmp.rotation.set(0, 0, 0);
      tmp.scale.set(1, 1, 1);
      part.place(item, tmp);
      tmp.updateMatrix();
      m.setMatrixAt(i, tmp.matrix);
      if (part.color) {
        part.color(item, tint);
        m.setColorAt(i, tint);
      }
    });
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
    m.computeBoundingSphere();
  }, [items, part]);
  const far = lod === 'far';
  const geometry = far ? part.far : part.near;
  return (
    <instancedMesh
      ref={mesh}
      args={[part.near, part.material, items.length]}
      geometry={geometry ?? part.near}
      visible={geometry !== null}
      castShadow={!!part.castShadow && !far}
      receiveShadow={!!part.receiveShadow}
    />
  );
}
