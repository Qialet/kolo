// Frame probe: draw calls, triangles and frame time at fixed views of the running dev app.
// Usage: pnpm perf [--cpu N] [--url http://localhost:3000]
import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';

const { values: args } = parseArgs({
  options: { cpu: { type: 'string' }, url: { type: 'string', default: 'http://localhost:3000' } },
});
const require = createRequire(new URL('../../../package.json', import.meta.url));
const { chromium } = require('playwright-core');

/** View: target x, z and zoom. */
const VIEWS = { overview: [-499, -920, 0.8], home: [0, 0, 4.6], near: [-459, -1225, 12] };
const FRAMES = 120;

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
