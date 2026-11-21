// Downloads a pinned nats-server release into .tools/nats-server/ and prints the binary path. Idempotent.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = 'v2.11.17';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, '.tools', 'nats-server');
const exe = process.platform === 'win32' ? 'nats-server.exe' : 'nats-server';
const binPath = path.join(outDir, exe);

export { binPath };

function platformSlug() {
  const arch = { x64: 'amd64', arm64: 'arm64' }[process.arch];
  const plat = { win32: 'windows', linux: 'linux', darwin: 'darwin' }[process.platform];
  if (!arch || !plat) throw new Error(`unsupported platform ${process.platform}/${process.arch}`);
  return `${plat}-${arch}`;
}

async function main() {
  if (fs.existsSync(binPath)) {
    console.log(binPath);
    return;
  }
  const slug = platformSlug();
  const base = `nats-server-${VERSION}-${slug}`;
  const url = `https://github.com/nats-io/nats-server/releases/download/${VERSION}/${base}.zip`;
  console.error(`downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status} for ${url}`);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nats-dl-'));
  const zipPath = path.join(tmp, `${base}.zip`);
  fs.writeFileSync(zipPath, Buffer.from(await res.arrayBuffer()));
  const extractDir = path.join(tmp, 'x');
  fs.mkdirSync(extractDir);
  if (process.platform === 'win32') {
    execFileSync('powershell', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${extractDir}' -Force`], { stdio: 'inherit' });
  } else {
    execFileSync('unzip', ['-q', zipPath, '-d', extractDir], { stdio: 'inherit' });
  }
  const extracted = path.join(extractDir, base, exe);
  if (!fs.existsSync(extracted)) throw new Error(`binary not found in archive at ${extracted}`);
  fs.mkdirSync(outDir, { recursive: true });
  fs.copyFileSync(extracted, binPath);
  if (process.platform !== 'win32') fs.chmodSync(binPath, 0o755);
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(binPath);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(`nats:fetch failed: ${e.message}`);
    process.exit(1);
  });
}
