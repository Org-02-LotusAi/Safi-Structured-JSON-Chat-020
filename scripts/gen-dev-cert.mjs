// Generates a self-signed dev certificate for localhost / 127.0.0.1 into infra/certs/.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import selfsigned from 'selfsigned';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, 'infra', 'certs');
fs.mkdirSync(dir, { recursive: true });

const pems = await selfsigned.generate([{ name: 'commonName', value: 'localhost' }], {
  keySize: 2048,
  algorithm: 'sha256',
  notAfterDate: new Date(Date.now() + 365 * 24 * 3600 * 1000),
  extensions: [
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
    { name: 'extKeyUsage', serverAuth: true },
    {
      name: 'subjectAltName',
      altNames: [
        { type: 2, value: 'localhost' },
        { type: 7, ip: '127.0.0.1' },
        { type: 7, ip: '::1' },
      ],
    },
  ],
});
fs.writeFileSync(path.join(dir, 'dev.crt'), pems.cert);
fs.writeFileSync(path.join(dir, 'dev.key'), pems.private, { mode: 0o600 });
console.log(`wrote ${path.join(dir, 'dev.crt')} and dev.key (self-signed, localhost/127.0.0.1, 365 days)`);
