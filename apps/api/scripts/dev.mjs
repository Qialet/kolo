// Dev runner: compiles the API in watch mode and restarts the server whenever the API output
// or the built workspace packages (@kolo/sim, @kolo/contracts) change.
import { spawn } from 'node:child_process';
import { existsSync, watch } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
const tsconfig = resolve(root, 'tsconfig.build.json');
const entry = resolve(root, 'dist/main.js');
const DEBOUNCE_MS = 400;
const OUTPUT = /^dist[\\/].*\.(js|json)$/;

// Watch package roots and filter by dist/: a build that deletes and recreates dist would
// otherwise leave the watcher on a directory that no longer exists.
const watched = [{ dir: root, label: '' }];
for (const pkg of ['@kolo/sim', '@kolo/contracts']) {
  const dist = dirname(fileURLToPath(import.meta.resolve(pkg)));
  watched.push({ dir: dirname(dist), label: `${pkg.split('/')[1]}/` });
}

let server = null;
let restarting = false;
let shuttingDown = false;
// The server starts after the first compilation; output written before that is not a change.
let ready = false;

function start() {
  if (!existsSync(entry)) {
    console.log('[dev] waiting for build output');
    return;
  }
  server = spawn(process.execPath, ['--enable-source-maps', entry], { cwd: root, stdio: 'inherit' });
  server.on('exit', () => {
    server = null;
    if (restarting && !shuttingDown) {
      restarting = false;
      start();
    }
  });
}

function restart(reason) {
  if (shuttingDown) return;
  console.log(`\n[dev] ${reason} changed — restarting API`);
  if (!server) return start();
  if (restarting) return;
  restarting = true;
  // SIGTERM lets Nest run shutdown hooks (flush pending DB writes, free the port).
  server.kill('SIGTERM');
}

const compiler = spawn(process.execPath, [tsc, '-p', tsconfig, '--watch', '--preserveWatchOutput'], {
  cwd: root,
  stdio: ['ignore', 'pipe', 'inherit'],
});
compiler.stdout.on('data', (chunk) => {
  process.stdout.write(chunk);
  if (!ready && /Watching for file changes/.test(String(chunk))) {
    ready = true;
    start();
  }
});

let timer = null;
for (const { dir, label } of watched) {
  watch(dir, { recursive: true }, (_event, file) => {
    if (!ready || !file || !OUTPUT.test(file)) return;
    clearTimeout(timer);
    timer = setTimeout(() => restart(`${label}${file}`), DEBOUNCE_MS);
  });
}

const stop = () => {
  shuttingDown = true;
  compiler.kill();
  server?.kill('SIGTERM');
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
compiler.on('exit', (code) => {
  stop();
  process.exitCode = code ?? 0;
});
