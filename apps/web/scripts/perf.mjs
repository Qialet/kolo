// Frame probe: draw calls, triangles and frame time at fixed views of the running dev app.
// Usage: pnpm perf [--budget] [--cpu N] [--url http://localhost:3000] [--api http://localhost:4000/api]
// --budget fails (exit 1) when a view draws more than its budget; frame time depends on the machine and is only printed.
import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';

const { values: args } = parseArgs({
  options: {
    budget: { type: 'boolean', default: false },
    cpu: { type: 'string' },
    url: { type: 'string', default: 'http://localhost:3000' },
    api: { type: 'string', default: 'http://localhost:4000/api' },
  },
});
const require = createRequire(new URL('../../../package.json', import.meta.url));
const { chromium } = require('playwright-core');

/** View: target x, z and zoom. */
const VIEWS = { overview: [-499, -920, 0.8], home: [0, 0, 4.6], near: [-459, -1225, 12] };
const FRAMES = 120;
/** Most triangles and draw calls per frame (shadow pass included) a view may take. */
const BUDGET = { overview: { triangles: 900_000, draws: 260 }, home: { triangles: 1_200_000, draws: 150 }, near: { triangles: 900_000, draws: 120 } };

const browser = await chromium.launch({ channel: 'chrome', args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
// Count every draw and its triangles (instances included) before the app creates its context.
await page.addInitScript(() => {
  const stats = { calls: 0, tris: 0 };
  window.__koloDraws = stats;
  const proto = WebGL2RenderingContext.prototype;
  for (const name of ['drawElements', 'drawArrays', 'drawElementsInstanced', 'drawArraysInstanced']) {
    const orig = proto[name];
    const elements = name.startsWith('drawElements');
    proto[name] = function (...a) {
      stats.calls++;
      const count = elements ? a[1] : a[2];
      const instances = name.endsWith('Instanced') ? a[elements ? 4 : 3] : 1;
      if (a[0] === 4) stats.tris += (count / 3) * instances;
      return orig.apply(this, a);
    };
  }
});
page.on('pageerror', (e) => console.error('pageerror', e.message));
await page.goto(args.url, { waitUntil: 'load' });
await page.waitForFunction(() => !!window.__koloUi && !!window.__koloGl && !!window.__koloFrames?.latest, null, { timeout: 120_000 });
await page.waitForTimeout(5000);
if (args.cpu) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: Number(args.cpu) });
}

const rows = [];
for (const [name, [x, z, zoom]] of Object.entries(VIEWS)) {
  await page.evaluate(([x, z, zoom]) => window.__koloUi.getState().focus(x, z, { zoom }), [x, z, zoom]);
  await page.waitForTimeout(3000);
  const r = await page.evaluate(
    (frames) =>
      new Promise((done) => {
        const s = window.__koloDraws;
        const times = [];
        let last = performance.now();
        s.calls = 0;
        s.tris = 0;
        const loop = () => {
          const now = performance.now();
          times.push(now - last);
          last = now;
          if (times.length < frames) requestAnimationFrame(loop);
          else done({ times, calls: s.calls / frames, tris: s.tris / frames, lod: window.__koloUi.getState().lod });
        };
        requestAnimationFrame(loop);
      }),
    FRAMES,
  );
  const t = r.times.slice(1).sort((a, b) => a - b);
  rows.push({
    view: name,
    lod: r.lod,
    draws: Math.round(r.calls),
    triangles: Math.round(r.tris),
    frameMs: +(t.reduce((a, b) => a + b, 0) / t.length).toFixed(1),
    p95Ms: +t[Math.floor(t.length * 0.95)].toFixed(1),
  });
}
const gpu = await page.evaluate(() => {
  const gl = window.__koloGl.gl.getContext();
  const info = gl.getExtension('WEBGL_debug_renderer_info');
  return info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : 'unknown GPU';
});
await browser.close();

console.log(`${gpu}${args.cpu ? `, CPU ×${args.cpu}` : ''}`);
console.table(rows);
const state = await fetch(`${args.api}/sim/state`).then((r) => r.json()).catch(() => null);
if (state?.step) console.log(`Server step over the last minute: avg ${state.step.avgMs} ms, max ${state.step.maxMs} ms (budget 16.7 ms)`);
if (args.budget) {
  const over = rows.filter((r) => r.triangles > BUDGET[r.view].triangles || r.draws > BUDGET[r.view].draws);
  for (const r of over) console.error(`Over budget: ${r.view} — ${r.triangles} triangles, ${r.draws} draws (budget ${BUDGET[r.view].triangles}, ${BUDGET[r.view].draws})`);
  if (over.length) process.exit(1);
  console.log('Frame budget: ok');
}
