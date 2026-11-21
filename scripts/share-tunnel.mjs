// Gives a running local stack a real, publicly valid HTTPS URL without owning a domain,
// using a Cloudflare quick tunnel:  cloudflared tunnel --url https://localhost:8443 --no-tls-verify
// The local server keeps its self-signed dev certificate; Cloudflare terminates public TLS.
// The URL changes every run and stops working when this process exits: never record it as permanent.
// Env: TUNNEL_TARGET (default https://localhost:8443). Requires cloudflared on PATH.
import { spawn, spawnSync } from 'node:child_process';

const target = process.env.TUNNEL_TARGET || 'https://localhost:8443';

const probe = spawnSync('cloudflared', ['--version'], { encoding: 'utf8' });
if (probe.error || probe.status !== 0) {
  console.error('share:tunnel: cloudflared was not found on PATH.');
  console.error('Install it from https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/ and retry.');
  process.exit(1);
}

const child = spawn('cloudflared', ['tunnel', '--url', target, '--no-tls-verify'], { stdio: ['ignore', 'pipe', 'pipe'] });
let printed = false;

function scan(chunk) {
  const text = chunk.toString();
  process.stderr.write(text.split('\n').filter((l) => l && !l.includes('trycloudflare.com')).map((l) => `[cloudflared] ${l}\n`).join(''));
  const m = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(text);
  if (m && !printed) {
    printed = true;
    console.log('');
    console.log(`Public HTTPS URL: ${m[0]}`);
    console.log(`Health check:     ${m[0]}/healthz`);
    console.log('Temporary: valid only while this command runs. Press Ctrl+C to stop.');
    console.log('');
  }
}
child.stdout.on('data', scan);
child.stderr.on('data', scan);
child.on('error', (e) => {
  console.error(`share:tunnel: failed to start cloudflared: ${e.message}`);
  process.exit(1);
});
child.on('exit', (code, signal) => {
  if (!printed) console.error(`share:tunnel: cloudflared exited (${signal ?? code}) before a URL was issued; is the stack running at ${target}?`);
  process.exit(code ?? 1);
});
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill());
