'use client';

import { MapControls } from '@react-three/drei';
import { useFrame, useThree } from '@react-three/fiber';
import type { City } from '@kolo/sim';
import { useEffect, useMemo, useRef, type ComponentRef } from 'react';
import * as THREE from 'three';
import { getCity } from '@/lib/city';
import { nextLod } from '@/lib/lod';
import { useUi } from '@/lib/ui-store';
import { livePoses } from './vehicles';

type MapControlsImpl = ComponentRef<typeof MapControls>;

export const HOME_ZOOM = 4.6;
export const HOME_OFFSET = new THREE.Vector3(330, 370, 330);
/** The camera may wander this far past the district frame. */
const PAN_MARGIN = 200;

/** Centre of the district frame: where the camera looks on start and on «home». */
export function homeOf(city: City) {
  const b = city.bounds;
  return new THREE.Vector3((b.x0 + b.x1) / 2, 0, (b.z0 + b.z1) / 2);
}

interface Anim {
  target: THREE.Vector3;
  zoom: number;
  rotate: number;
}

/** Isometric map-style camera: pan in the ground plane, limited tilt, animated focus and follow. */
export function CameraRig() {
  const controls = useRef<MapControlsImpl>(null);
  const get = useThree((s) => s.get);
  const anim = useRef<Anim | null>(null);
  const follow = useRef<string | null>(null);
  const request = useUi((s) => s.camera);
  const command = useUi((s) => s.cameraCommand);
  const bounds = getCity().bounds;
  const home = useMemo(() => homeOf(getCity()), []);

  useEffect(() => {
    if (!request) return;
    const camera = get().camera;
    anim.current = { target: new THREE.Vector3(request.x, 0, request.z), zoom: request.zoom ?? Math.max(camera.zoom, 4), rotate: 0 };
    follow.current = request.follow ?? null;
  }, [request, get]);

  useEffect(() => {
    if (!command) return;
    const camera = get().camera;
    const c = controls.current;
    const target = c ? c.target.clone() : new THREE.Vector3();
    const current = anim.current ?? { target, zoom: camera.zoom, rotate: 0 };
    if (command.type === 'zoomIn') anim.current = { ...current, zoom: Math.min(14, current.zoom * 1.45) };
    if (command.type === 'zoomOut') anim.current = { ...current, zoom: Math.max(0.8, current.zoom / 1.45) };
    if (command.type === 'rotateLeft') anim.current = { ...current, rotate: current.rotate + Math.PI / 4 };
    if (command.type === 'rotateRight') anim.current = { ...current, rotate: current.rotate - Math.PI / 4 };
    if (command.type === 'home') {
      follow.current = null;
      if (c) {
        c.target.copy(home);
        camera.position.copy(home).add(HOME_OFFSET);
      }
      anim.current = { target: home.clone(), zoom: HOME_ZOOM, rotate: 0 };
    }
  }, [command, get, home]);

  useFrame((state, dt) => {
    const camera = state.camera;
    const c = controls.current;
    const a = anim.current;
    if (!c) return;
    if (follow.current && a) {
      const pose = livePoses.get(follow.current);
      if (pose) a.target.set(pose.x, 0, pose.z);
    }
    if (a) {
      const k = 1 - Math.exp(-dt * 5);
      const delta = a.target.clone().sub(c.target).multiplyScalar(k);
      c.target.add(delta);
      camera.position.add(delta);
      if (Math.abs(a.rotate) > 1e-4) {
        const step = a.rotate * k;
        a.rotate -= step;
        const offset = camera.position.clone().sub(c.target).applyAxisAngle(THREE.Object3D.DEFAULT_UP, step);
        camera.position.copy(c.target).add(offset);
      }
      camera.zoom += (a.zoom - camera.zoom) * k;
      camera.updateProjectionMatrix();
      const settled = delta.lengthSq() < 0.0004 && Math.abs(a.zoom - camera.zoom) < 0.005 && Math.abs(a.rotate) < 1e-4;
      if (settled && !follow.current) anim.current = null;
    }
    c.update();
    // Keep the view over the district: shift target and camera together.
    const x = THREE.MathUtils.clamp(c.target.x, bounds.x0 - PAN_MARGIN, bounds.x1 + PAN_MARGIN);
    const z = THREE.MathUtils.clamp(c.target.z, bounds.z0 - PAN_MARGIN, bounds.z1 + PAN_MARGIN);
    if (x !== c.target.x || z !== c.target.z) {
      camera.position.x += x - c.target.x;
      camera.position.z += z - c.target.z;
      c.target.x = x;
      c.target.z = z;
    }
    const ui = useUi.getState();
    const lod = nextLod(camera.zoom, ui.lod);
    if (lod !== ui.lod) ui.setLod(lod);
  });

  return (
    <MapControls
      ref={controls}
      makeDefault
      target={home}
      enableDamping
      dampingFactor={0.12}
      minZoom={0.8}
      maxZoom={14}
      minPolarAngle={0.5}
      maxPolarAngle={1.05}
      screenSpacePanning={false}
      zoomToCursor
      onStart={() => {
        follow.current = null;
        anim.current = null;
      }}
    />
  );
}

/** Sun that follows the camera target so the shadow map keeps its resolution. */
export function SceneLights() {
  const light = useRef<THREE.DirectionalLight>(null);
  const controls = useThree((s) => s.controls) as MapControlsImpl | null;
  useFrame(() => {
    const l = light.current;
    if (!l || !controls) return;
    const t = controls.target;
    l.position.set(t.x - 160, 300, t.z + 110);
    l.target.position.copy(t);
    l.target.updateMatrixWorld();
  });
  return (
    <>
      <hemisphereLight args={['#FFFFFF', '#B9C3D1', 1.25]} />
      <directionalLight
        ref={light}
        intensity={2.6}
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-camera-left={-320}
        shadow-camera-right={320}
        shadow-camera-top={320}
        shadow-camera-bottom={-320}
        shadow-camera-near={10}
        shadow-camera-far={900}
        shadow-bias={-0.0004}
        shadow-normalBias={0.6}
      />
    </>
  );
}
