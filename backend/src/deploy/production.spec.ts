import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const { load } = require('js-yaml');

const root = resolve(__dirname, '../../..');
const read = (name: string) => readFileSync(resolve(root, name), 'utf8');
const compose = load(read('deploy/docker-compose.prod.yml'));

describe('production quote PDF runtime', () => {
  it('keeps Chromium crashpad on the writable tempfs', () => {
    const backend = compose.services['customer-ops-backend'];

    expect(backend.read_only).toBe(true);
    expect(backend.tmpfs).toEqual(expect.arrayContaining(['/tmp']));
    expect(backend.environment).toMatchObject({ HOME: '/tmp' });
    expect(read('deploy/.env.prod.example')).toMatch(/^HOME=\/tmp$/m);
  });
});
