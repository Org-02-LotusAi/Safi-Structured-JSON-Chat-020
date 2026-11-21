import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const binary = path.join(root, '.tools', 'nats-server', process.platform === 'win32' ? 'nats-server.exe' : 'nats-server');

export interface TestNats {
  url: string;
  stop(): Promise<void>;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
  });
}

function canConnect(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1');
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('error', () => resolve(false));
  });
}

/** Starts a JetStream-enabled nats-server (or uses TEST_NATS_URL if set). */
export async function startNatsServer(): Promise<TestNats> {
  if (process.env.TEST_NATS_URL) return { url: process.env.TEST_NATS_URL, stop: async () => {} };
  if (!fs.existsSync(binary)) throw new Error(`nats-server not found at ${binary}; run "npm run nats:fetch"`);

  const port = await freePort();
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'safi-nats-'));
  const proc: ChildProcess = spawn(binary, ['-js', '-a', '127.0.0.1', '-p', String(port), '-sd', storeDir], { stdio: 'ignore' });
  let exited = false;
  proc.once('exit', () => { exited = true; });

  const deadline = Date.now() + 10_000;
  while (!(await canConnect(port))) {
    if (exited) throw new Error('nats-server exited before accepting connections');
    if (Date.now() > deadline) { proc.kill(); throw new Error('timed out waiting for nats-server'); }
    await new Promise((r) => setTimeout(r, 50));
  }

  return {
    url: `nats://127.0.0.1:${port}`,
    stop: async () => {
      if (!exited) {
        const done = new Promise<void>((r) => proc.once('exit', () => r()));
        proc.kill();
        await done;
      }
      fs.rmSync(storeDir, { recursive: true, force: true });
    },
  };
}
