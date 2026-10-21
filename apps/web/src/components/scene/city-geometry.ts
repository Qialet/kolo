import { STOP_SETBACK, type City, type Rect } from '@kolo/sim';
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { palette } from '@/lib/palette';

const tmpColor = new THREE.Color();

/** Axis-aligned box with a vertical colour gradient baked into vertex colours. */
export function gradientBox(w: number, h: number, d: number, x: number, y: number, z: number, top: string, bottom = top) {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y + h / 2, z);
  const pos = g.attributes.position!;
  const colors = new Float32Array(pos.count * 3);
  const cTop = new THREE.Color(top);
  const cBottom = new THREE.Color(bottom);
  for (let i = 0; i < pos.count; i++) {
    const t = (pos.getY(i) - y) / h;
    tmpColor.copy(cBottom).lerp(cTop, t);
    colors.set([tmpColor.r, tmpColor.g, tmpColor.b], i * 3);
  }
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return g;
}

/** Flat quad lying on the ground, centred at (x, z), rotated around Y. */
function quad(w: number, d: number, x: number, y: number, z: number, color: string, rotY = 0) {
  const g = new THREE.PlaneGeometry(w, d);
  g.rotateX(-Math.PI / 2);
  if (rotY) g.rotateY(rotY);
  g.translate(x, y, z);
  const c = new THREE.Color(color);
  const colors = new Float32Array(g.attributes.position!.count * 3);
  for (let i = 0; i < colors.length; i += 3) colors.set([c.r, c.g, c.b], i);
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return g;
}

const rectSlab = (r: Rect, h: number, color: string, pad = 0, y = 0) =>
  gradientBox(r.x1 - r.x0 + pad * 2, h, r.z1 - r.z0 + pad * 2, (r.x0 + r.x1) / 2, y, (r.z0 + r.z1) / 2, color, color);

const merge = (parts: THREE.BufferGeometry[]) => {
  const g = mergeGeometries(parts.map((p) => (p.index ? p.toNonIndexed() : p)));
  for (const p of parts) p.dispose();
  return g!;
};

/** Sidewalk slabs, block interiors, park lawns, depot lots and boulevard medians. */
export function buildGroundGeometry(city: City) {
  const parts: THREE.BufferGeometry[] = [];
  for (const block of city.blocks) {
    const edge = city.bounds;
    // Sidewalk only towards streets: clamp the padded rect to the world bounds.
    const pad = city.sidewalk;
    const r: Rect = {
      x0: Math.max(edge.x0, block.inner.x0 - pad),
      x1: Math.min(edge.x1, block.inner.x1 + pad),
      z0: Math.max(edge.z0, block.inner.z0 - pad),
      z1: Math.min(edge.z1, block.inner.z1 + pad),
    };
    parts.push(rectSlab(r, 0.16, palette.sidewalk));
    parts.push(rectSlab(block.inner, 0.2, block.kind === 'park' ? palette.park : palette.block));
  }
  // Partner yards: asphalt with a violet tint, slightly above the courtyard level.
  for (const depot of city.depots) parts.push(rectSlab(depot.lot, 0.205, palette.depotLot));
  // Courtyard lawns, a touch above the paved courtyard so walkways read between them.
  for (const lawn of city.lawns) parts.push(rectSlab(lawn, 0.24, palette.lawn));
  for (const street of city.streets) {
    if (!street.median) continue;
    for (const seg of city.segments) {
      if (seg.street !== street.id || seg.reverse < seg.id) continue;
      const a = city.nodes[seg.from]!;
      const b = city.nodes[seg.to]!;
      const along = street.axis === 'NS';
      const startOff = (along ? a.halfZ : a.halfX) + STOP_SETBACK + 0.5;
      const endOff = (along ? b.halfZ : b.halfX) + STOP_SETBACK + 0.5;
      const len = seg.length - startOff - endOff;
      const mid = startOff + len / 2;
      const cx = a.x + seg.dirIn.x * mid;
      const cz = a.z + seg.dirIn.z * mid;
      parts.push(gradientBox(along ? street.median * 1.6 : len, 0.22, along ? len : street.median * 1.6, cx, 0, cz, palette.median, palette.sidewalk));
    }
  }
  return merge(parts);
}

/** Lane lines, centre lines, stop lines at unsignalised approaches and zebra crossings. */
export function buildMarkingsGeometry(city: City) {
  const parts: THREE.BufferGeometry[] = [];
  const y = 0.03;
  for (const seg of city.segments) {
    const street = city.streets[seg.street]!;
    const a = city.nodes[seg.from]!;
    const b = city.nodes[seg.to]!;
    const along = seg.axis === 'NS';
    const right = { x: -seg.dirIn.z, z: seg.dirIn.x };
    const startOff = (along ? a.halfZ : a.halfX) + STOP_SETBACK;
    const endOff = (along ? b.halfZ : b.halfX) + STOP_SETBACK;
    const rot = along ? 0 : Math.PI / 2;
    const dashed = (offset: number, width: number, dash: number, gap: number) => {
      for (let s = startOff + 1; s < seg.length - endOff - dash; s += dash + gap) {
        const m = s + dash / 2;
        parts.push(quad(width, dash, a.x + seg.dirIn.x * m + right.x * offset, y, a.z + seg.dirIn.z * m + right.z * offset, palette.marking, rot));
      }
    };
    if (street.lanesPerDir > 1) dashed(street.median + street.laneWidth, 0.14, 3, 6);
    // Centre line once per pair (local streets only — boulevards have a median).
    if (!street.median && seg.reverse > seg.id) dashed(0, 0.14, 3, 4);
    // Stop line on unsignalised approaches (signalised ones are drawn live, tinted by aspect).
    if (!b.signal) {
      const w = street.halfWidth - street.median;
      const m = seg.length - endOff + 0.3;
      const off = street.median + w / 2;
      parts.push(quad(along ? w : 0.45, along ? 0.45 : w, a.x + seg.dirIn.x * m + right.x * off, y + 0.002, a.z + seg.dirIn.z * m + right.z * off, palette.marking));
    }
  }
  // Zebra crossings on every leg of every junction.
  for (const node of city.nodes) {
    for (const segId of node.out) {
      const seg = city.segments[segId]!;
      const street = city.streets[seg.street]!;
      const along = seg.axis === 'NS';
      const half = along ? node.halfZ : node.halfX;
      const centre = half + STOP_SETBACK / 2;
      const cx = node.x + seg.dirIn.x * centre;
      const cz = node.z + seg.dirIn.z * centre;
      for (let t = -street.halfWidth + 0.6; t < street.halfWidth - 0.3; t += 1.1) {
        const px = along ? cx + t : cx;
        const pz = along ? cz : cz + t;
        parts.push(quad(along ? 0.55 : 2.8, along ? 2.8 : 0.55, px, y, pz, palette.marking));
      }
    }
  }
  return merge(parts);
}

/** Parking-slot lines in depot lots. */
export function buildDepotMarkings(city: City) {
  const parts: THREE.BufferGeometry[] = [];
  for (const depot of city.depots) {
    for (const slot of depot.slots) {
      const sideways = Math.abs(Math.sin(slot.heading)) > 0.5;
      // Two separators per slot, perpendicular to the row.
      for (const k of [-1, 1]) {
        const ox = sideways ? 0 : k * 1.6;
        const oz = sideways ? k * 1.6 : 0;
        parts.push(quad(sideways ? 5 : 0.12, sideways ? 0.12 : 5, slot.x + ox, 0.2, slot.z + oz, palette.depot));
      }
    }
  }
  return parts.length ? merge(parts) : new THREE.BufferGeometry();
}

/** Box with a flat vertex colour, rotated around Z (tilt) and Y, bottom at y. */
function part(w: number, h: number, d: number, color: string, x: number, y: number, z: number, rotY: number, tilt = 0) {
  const g = new THREE.BoxGeometry(w, h, d);
  if (tilt) g.rotateX(tilt);
  g.translate(0, h / 2, 0);
  g.rotateY(rotY);
  g.translate(x, y, z);
  const c = new THREE.Color(color);
  const colors = new Float32Array(g.attributes.position!.count * 3);
  for (let i = 0; i < colors.length; i += 3) colors.set([c.r, c.g, c.b], i);
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return g;
}

/** Courtyard playgrounds: soft pad, sandbox, swings, a climbing tower with a slide and benches. */
export function buildPlaygroundGeometry(city: City) {
  const parts: THREE.BufferGeometry[] = [];
  const base = 0.24;
  for (const pg of city.playgrounds) {
    const alongX = pg.w >= pg.d;
    const long = alongX ? pg.w : pg.d;
    const short = alongX ? pg.d : pg.w;
    // Local frame: u along the long side, v across it; put() sizes are (across, height, along).
    const rot = alongX ? Math.PI / 2 : 0;
    const at = (u: number, v: number) => (alongX ? { x: pg.x + u, z: pg.z + v } : { x: pg.x + v, z: pg.z + u });
    const put = (w: number, h: number, d: number, color: string, u: number, y: number, v: number, tilt = 0) => {
      const p = at(u, v);
      parts.push(part(w, h, d, color, p.x, base + y, p.z, rot, tilt));
    };
    parts.push(part(pg.w, 0.06, pg.d, palette.playPad, pg.x, base, pg.z, 0));
    const slots = [-0.3, 0.02, 0.3].map((k) => k * long);
    const order = [[0, 1, 2], [2, 0, 1], [1, 2, 0]][pg.variant % 3]!;
    // Sandbox: low white border around sand.
    const sand = slots[order[0]!]!;
    put(3.2, 0.28, 3.2, palette.marking, sand, 0, 0);
    put(2.7, 0.3, 2.7, palette.playSand, sand, 0, 0);
    // Swings: two posts, a top bar and two seats (the frame runs across the pad).
    const swing = slots[order[1]!]!;
    for (const v of [-1.5, 1.5]) put(0.14, 2.4, 0.14, palette.playFrame, swing, 0, v);
    put(3.1, 0.12, 0.12, palette.playFrame, swing, 2.3, 0);
    for (const v of [-0.6, 0.6]) {
      put(0.04, 1.6, 0.04, palette.playFrame, swing, 0.75, v);
      put(0.5, 0.06, 0.4, palette.playSeat, swing, 0.7, v);
    }
    // Climbing tower with a roof and a slide down towards the pad edge.
    const tower = slots[order[2]!]!;
    put(1.8, 1.5, 1.8, palette.playFrame, tower, 0, -0.6);
    put(2.1, 0.12, 2.1, palette.playSlide, tower, 1.5, -0.6);
    put(1.2, 0.9, 1.2, palette.playSlide, tower, 1.62, -0.6);
    const dir = tower > 0.5 ? -1 : 1;
    put(0.8, 0.08, 3, palette.playSlide, tower + dir * 2.3, 0.75, -0.6, dir > 0 ? 0.45 : -0.45);
    // Benches along the long sides.
    for (const v of [-short / 2 + 0.5, short / 2 - 0.5]) put(0.45, 0.45, long * 0.18, palette.trunk, -long * 0.15 * Math.sign(v), 0, v);
  }
  return parts.length ? merge(parts) : new THREE.BufferGeometry();
}

/** Unit box (0..1 in Y) with gradient colours, used for instanced buildings. */
export function unitBuildingGeometry() {
  return gradientBox(1, 1, 1, 0, 0, 0, palette.buildingTop, palette.buildingBase);
}

/**
 * Adds a procedural window grid to vertical faces (floors every 3.2 m, ground floor plain).
 * Works with instancing because it derives world coordinates from the instance matrix.
 */
export function withWindows(material: THREE.MeshStandardMaterial) {
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vKoloWorld;\nvarying vec3 vKoloNormal;')
      .replace(
        '#include <worldpos_vertex>',
        `#include <worldpos_vertex>
        vec4 koloW = vec4(transformed, 1.0);
        #ifdef USE_INSTANCING
          koloW = instanceMatrix * koloW;
        #endif
        vKoloWorld = (modelMatrix * koloW).xyz;
        vKoloNormal = normal;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vKoloWorld;\nvarying vec3 vKoloNormal;')
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        if (abs(vKoloNormal.y) < 0.5 && vKoloWorld.y > 3.6) {
          float floorF = fract(vKoloWorld.y / 3.2);
          float rowMask = step(0.34, floorF) * step(floorF, 0.78);
          float h = abs(vKoloNormal.x) > 0.5 ? vKoloWorld.z : vKoloWorld.x;
          float col = fract(h / 2.7);
          float colMask = step(0.22, col) * step(col, 0.78);
          float m = rowMask * colMask;
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.6, 0.67, 0.78), m * 0.5);
        }`,
      );
  };
  material.customProgramCacheKey = () => 'kolo-windows';
  return material;
}
