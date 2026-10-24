'use client';

import { Canvas } from '@react-three/fiber';
import { PerformanceMonitor } from '@react-three/drei';
import { useMemo, useState } from 'react';
import * as THREE from 'three';
import { getCity } from '@/lib/city';
import { useUi } from '@/lib/ui-store';
import { CameraRig, HOME_OFFSET, HOME_ZOOM, homeOf, SceneLights } from './camera-rig';
import { CityStatic } from './city-static';
import { Overlays } from './overlays';
import { TrafficLights } from './traffic-lights';
import { TrafficSigns } from './traffic-signs';
import { ParkedCars, Vehicles } from './vehicles';
import { LabelProjector } from './world-labels';

export default function CityCanvas() {
  const city = useMemo(() => getCity(), []);
  const select = useUi((s) => s.select);
  // Full device resolution (up to 2) while frames keep up; one pixel per CSS pixel when they do not.
  const [lowRes, setLowRes] = useState(false);
  return (
    <Canvas
      shadows
      orthographic
      dpr={lowRes ? 1 : [1, 2]}
      camera={{ position: homeOf(city).add(HOME_OFFSET).toArray(), zoom: HOME_ZOOM, near: 1, far: 4000 }}
      gl={{ antialias: true, alpha: true, toneMapping: THREE.NeutralToneMapping }}
      onPointerMissed={() => select(null)}
      onCreated={(state) => {
        if (process.env.NODE_ENV !== 'production') Object.assign(window, { __koloGl: state });
      }}
    >
      <PerformanceMonitor onDecline={() => setLowRes(true)} onIncline={() => setLowRes(false)} flipflops={3} onFallback={() => setLowRes(true)} />
      <SceneLights />
      <CameraRig />
      <CityStatic city={city} />
      <TrafficLights city={city} />
      <TrafficSigns city={city} />
      <ParkedCars city={city} />
      <Vehicles />
      <Overlays city={city} />
      <LabelProjector />
    </Canvas>
  );
}
