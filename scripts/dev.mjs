import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
let stopping = false;
let worker;
let retry;
let failures = 0;
const web = spawn(process.execPath, [require.resolve('next/dist/bin/next'), 'dev', ...process.argv.slice(2)], { stdio: ['inherit', 'pipe', 'pipe'] });
web.stdout.on('data', chunk => {
  process.stdout.write(chunk);
});
web.stderr.on('data', chunk => process.stderr.write(chunk));
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  clearTimeout(retry);
  process.exitCode = code;
  web.kill('SIGTERM');
  worker?.kill('SIGTERM');
  const deadline = setTimeout(() => { web.kill('SIGKILL'); worker?.kill('SIGKILL'); }, 15000);
  deadline.unref();
}
function startWorker() {
  if (stopping) return;
  console.log('[stela] Starting IO worker alongside the web server');
  const started = Date.now();
  worker = spawn(process.execPath, ['--import', 'tsx', 'scripts/io-local-worker.ts'], { stdio: 'inherit' });
  worker.on('error', () => { console.error('[stela] Cannot launch IO worker'); stop(1); });
  worker.on('exit', () => {
    if (stopping) return;
    failures = Date.now() - started > 60000 ? 1 : failures + 1;
    const delay = Math.min(30000, 1000 * 2 ** Math.min(failures, 5));
    console.error(`[stela] IO worker exited; restarting in ${delay / 1000}s`);
    retry = setTimeout(startWorker, delay);
  });
}

// The worker can start before Next is ready: it only polls the dedicated IO
// database, and this removes the fragile dependency on the dev server's log
// format or which stream prints the Ready message.
startWorker();
web.on('error', () => stop(1));
web.on('exit', code => stop(code ?? 1));
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
