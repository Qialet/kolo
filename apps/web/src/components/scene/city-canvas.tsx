'use client';

import { Canvas } from '@react-three/fiber';
import { useMemo } from 'react';
import * as THREE from 'three';
import { getCity } from '@/lib/city';
import { useUi } from '@/lib/ui-store';
import { CameraRig, HOME_OFFSET, HOME_ZOOM, SceneLights } from './camera-rig';
import { CityStatic } from './city-static';
import { Overlays } from './overlays';
import { TrafficLights } from './traffic-lights';
import { Vehicles } from './vehicles';
import { LabelProjector } from './world-labels';

export default function CityCanvas() {
  const city = useMemo(() => getCity(), []);
  const select = useUi((s) => s.select);
  return (
    <Canvas
      shadows
      orthographic
      dpr={[1, 2]}
      camera={{ position: HOME_OFFSET.toArray(), zoom: HOME_ZOOM, near: 1, far: 4000 }}
      gl={{ antialias: true, alpha: true, toneMapping: THREE.NeutralToneMapping }}
      onPointerMissed={() => select(null)}
    >
      <SceneLights />
      <CameraRig />
      <CityStatic city={city} />
      <TrafficLights city={city} />
      <Vehicles />
      <Overlays city={city} />
      <LabelProjector />
    </Canvas>
  );
}
