'use client';

import { useFrame, useThree } from '@react-three/fiber';
import { useLayoutEffect, useRef, type ReactNode } from 'react';
import * as THREE from 'three';
import { cn } from '@/lib/utils';
import { livePoses } from './vehicles';

export type Anchor = { x: number; y: number; z: number } | { follow: string; y: number };

/** DOM labels anchored to world positions. Lives outside React state on purpose. */
const registry = new Map<HTMLElement, { current: Anchor }>();
const v = new THREE.Vector3();

/** Inside the Canvas: projects every registered label once per frame. */
export function LabelProjector() {
  const camera = useThree((s) => s.camera);
  const size = useThree((s) => s.size);
  useFrame(() => {
    for (const [el, ref] of registry) {
      const a = ref.current;
      if ('follow' in a) {
        const p = livePoses.get(a.follow);
        if (!p) {
          el.style.visibility = 'hidden';
          continue;
        }
        v.set(p.x, a.y, p.z);
      } else v.set(a.x, a.y, a.z);
      v.project(camera);
      const x = ((v.x + 1) / 2) * size.width;
      const y = ((1 - v.y) / 2) * size.height;
      const off = x < -200 || y < -200 || x > size.width + 200 || y > size.height + 200;
      el.style.visibility = off ? 'hidden' : 'visible';
      if (!off) el.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`;
    }
  });
  return null;
}

/** Outside the Canvas: a label whose bottom-centre sits on the anchor. */
export function WorldLabel({ anchor, children, className, interactive = false }: { anchor: Anchor; children: ReactNode; className?: string; interactive?: boolean }) {
  const el = useRef<HTMLDivElement>(null);
  const ref = useRef(anchor);
  useLayoutEffect(() => {
    ref.current = anchor;
  });
  useLayoutEffect(() => {
    const node = el.current;
    if (!node) return;
    registry.set(node, ref);
    return () => {
      registry.delete(node);
    };
  }, []);
  return (
    <div ref={el} className={cn('absolute top-0 left-0 will-change-transform', interactive ? 'pointer-events-auto' : 'pointer-events-none')} style={{ visibility: 'hidden' }}>
      <div className={cn('-translate-x-1/2 -translate-y-full', className)}>{children}</div>
    </div>
  );
}
