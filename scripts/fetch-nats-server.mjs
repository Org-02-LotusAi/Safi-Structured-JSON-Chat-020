// Downloads a pinned nats-server release into .tools/nats-server/ and prints the binary path. Idempotent.
import { createHash } from 'node:crypto';
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

// SHA-256 of each release archive, copied from the release's published SHA256SUMS
// (https://github.com/nats-io/nats-server/releases/download/v2.11.17/SHA256SUMS). Update with VERSION.
const SHA256 = {
  'windows-amd64.zip': '45c6a61420c87afaa31edf89372b3cfb4335ac12838fc8c593967a4d8b503f5a',
  'windows-arm64.zip': 'dc047714f30bcddc08d2847c3a0eda9820e0a5e4526d94fd5f18501d37797760',
  'linux-amd64.tar.gz': 'ad608dd0ea8bbfa58c40e3b8f58ed67478eec26166ec49c502db8d17589b51b5',
  'linux-arm64.tar.gz': 'd21df24f262f34f8bf6d1f0bca557c08429e433fd9f60f6983105539ae517feb',
  'darwin-amd64.tar.gz': '17511c7bad18aa6b911d83f8907f5fc371369eec30bd9b16d3fba0100d54518c',
  'darwin-arm64.tar.gz': 'e17d11c5e9cb0824e003013304ba3d96ca24adbff9998084c746869c0347be9b',
};

function platformSlug() {
  const arch = { x64: 'amd64', arm64: 'arm64' }[process.arch];
  const plat = { win32: 'windows', linux: 'linux', darwin: 'darwin' }[process.platform];
  if (!arch || !plat) throw new Error(`unsupported platform ${process.platform}/${process.arch}`);
  return `${plat}-${arch}`;
}

async function main() {
  if (process.env.TEST_NATS_URL) {
    console.error('TEST_NATS_URL is set; not downloading nats-server');
    return;
  }
  if (fs.existsSync(binPath)) {
    console.log(binPath);
    return;
  }
  const slug = platformSlug();
  const base = `nats-server-${VERSION}-${slug}`;
  const ext = process.platform === 'win32' ? 'zip' : 'tar.gz';
  const expected = SHA256[`${slug}.${ext}`];
  if (!expected) throw new Error(`no pinned SHA-256 for ${slug}.${ext}`);
  const url = `https://github.com/nats-io/nats-server/releases/download/${VERSION}/${base}.${ext}`;
  console.error(`downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status} for ${url}`);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nats-dl-'));
  const zipPath = path.join(tmp, `${base}.${ext}`);
  const data = Buffer.from(await res.arrayBuffer());
  const actual = createHash('sha256').update(data).digest('hex');
  if (actual !== expected) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw new Error(`SHA-256 mismatch for ${url}: expected ${expected}, got ${actual}; refusing to install`);
  }
  fs.writeFileSync(zipPath, data);
  const extractDir = path.join(tmp, 'x');
  fs.mkdirSync(extractDir);
  if (process.platform === 'win32') {
    execFileSync('powershell', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${extractDir}' -Force`], { stdio: 'inherit' });
  } else {
    execFileSync('tar', ['-xzf', zipPath, '-C', extractDir], { stdio: 'inherit' });
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
