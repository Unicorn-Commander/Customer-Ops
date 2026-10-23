import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const { load } = require('js-yaml');
const {
  SECRET_KEYS,
  createEnvironment,
  writeEnvironment,
} = require('../../../deploy/selfhost/bootstrap.cjs');
const { configureDatabase } = require('../../../deploy/selfhost/configure-database.cjs');

const root = resolve(__dirname, '../../..');
const read = (name: string) => readFileSync(resolve(root, name), 'utf8');
const template = read('deploy/.env.example');
const compose = load(read('deploy/docker-compose.selfhost.yml'));
const realm = JSON.parse(read('deploy/selfhost/customer-ops-realm.json'));
const envValues = (text: string) =>
  Object.fromEntries(
    text.split('\n').flatMap((line) => {
      const match = line.match(/^([A-Z_]+)=(.*?)(?:\s+#.*)?$/);
      return match ? [[match[1], match[2].trim()]] : [];
    }),
  );

describe('self-host credential bootstrap', () => {
  // Deterministic bytes test the contract without creating any real credential.
  const fakeRandom = () => {
    let index = 0;
    return jest.fn((size: number) => Buffer.alloc(size, ++index));
  };

  it('replaces every blank credential independently with URL-safe 256-bit material', () => {
    const random = fakeRandom();
    const values = envValues(createEnvironment(template, random));
    const credentials = SECRET_KEYS.map((key: string) => values[key]);
    expect(random).toHaveBeenCalledTimes(SECRET_KEYS.length);
    expect(random.mock.calls.every(([size]: [number]) => size === 32)).toBe(true);
    expect(credentials.every((value: string) => /^[a-f0-9]{64}$/.test(value))).toBe(true);
    expect(new Set(credentials).size).toBe(SECRET_KEYS.length);
  });

  it('requires exclusive creation and owner-only permissions', () => {
    const io = { writeFileSync: jest.fn() };
    writeEnvironment(template, '/unused-test-config', io, fakeRandom());
    expect(io.writeFileSync).toHaveBeenCalledWith('/unused-test-config', expect.any(String), {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
  });

  it('does not retry or overwrite when a file or symlink already exists', () => {
    const exists = Object.assign(new Error('exists'), { code: 'EEXIST' });
    const io = {
      writeFileSync: jest.fn(() => {
        throw exists;
      }),
    };
    expect(() => writeEnvironment(template, '/unused-test-config', io, fakeRandom())).toThrow(
      exists,
    );
    expect(io.writeFileSync).toHaveBeenCalledTimes(1);
  });

  it('does not write a partially configured file if a secret placeholder is missing', () => {
    const io = { writeFileSync: jest.fn() };
    expect(() =>
      writeEnvironment(
        template.replace('JWT_SECRET=', '# JWT_SECRET='),
        '/unused-test-config',
        io,
        fakeRandom(),
      ),
    ).toThrow('Missing blank placeholder: JWT_SECRET');
    expect(io.writeFileSync).not.toHaveBeenCalled();
  });
});

describe('self-host database role setup', () => {
  it('replaces the runtime password without weakening RLS and disables unused logins', async () => {
    const prisma = { $executeRawUnsafe: jest.fn().mockResolvedValue(0) };
    await configureDatabase(prisma, 'a'.repeat(64));
    expect(prisma.$executeRawUnsafe.mock.calls).toEqual([
      [
        `ALTER ROLE customer_ops_app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD '${'a'.repeat(64)}'`,
      ],
      ['ALTER ROLE customer_ops_audit NOLOGIN PASSWORD NULL'],
      ['ALTER ROLE customer_ops_ro NOLOGIN PASSWORD NULL'],
      [
        `UPDATE "workspaces" SET slug = 'local', "displayName" = 'Local workspace', "updatedAt" = now()
     WHERE id = '0190a000-7e57-7000-8000-00000000c007' AND slug = 'bootstrap-placeholder'`,
      ],
    ]);
  });

  it.each([undefined, '', 'change-me', "'; SELECT 1; --", `${'a'.repeat(64)}\n`])(
    'rejects missing, placeholder or unsafe passwords before issuing SQL (%j)',
    async (password) => {
      const prisma = { $executeRawUnsafe: jest.fn() };
      await expect(configureDatabase(prisma, password)).rejects.toThrow('APP_DB_PASSWORD');
      expect(prisma.$executeRawUnsafe).not.toHaveBeenCalled();
    },
  );

  it('propagates setup failure so the dependent API cannot start', async () => {
    const prisma = { $executeRawUnsafe: jest.fn().mockRejectedValue(new Error('unavailable')) };
    await expect(configureDatabase(prisma, 'a'.repeat(64))).rejects.toThrow('unavailable');
    expect(prisma.$executeRawUnsafe).toHaveBeenCalledTimes(1);
  });
});

describe('self-host deployment contract', () => {
  it('publishes only loopback ports with no shared network or proxy requirements', () => {
    expect(compose.services.backend.ports).toEqual(['127.0.0.1:3211:3211']);
    expect(compose.services.frontend.ports).toEqual(['127.0.0.1:3000:3000']);
    expect(compose.services.keycloak.ports).toEqual(['127.0.0.1:8080:8080']);
    for (const service of Object.values(compose.services) as any[]) {
      expect(service.networks).toBeUndefined();
      expect(service.labels).toBeUndefined();
      expect((service.ports || []).every((port: string) => port.startsWith('127.0.0.1:'))).toBe(
        true,
      );
    }
    expect(compose.networks).toBeUndefined();
    expect(compose.services.postgres.ports).toBeUndefined();
    expect(compose.services['keycloak-db'].ports).toBeUndefined();
  });

  it('runs migrations with the retained CLI and gates the runtime on success and identity readiness', () => {
    expect(compose.services.migrate.build.target).toBe('build');
    expect(compose.services.migrate.environment.DATABASE_URL).toContain('customer_ops_admin:');
    expect(compose.services.migrate.command[2]).toContain(
      'migrate deploy && node /selfhost/configure-database.cjs',
    );
    expect(compose.services.backend.command).toEqual(['node', 'dist/main']);
    expect(compose.services.backend.depends_on).toEqual({
      migrate: { condition: 'service_completed_successfully' },
      keycloak: { condition: 'service_healthy' },
    });
    const dockerfile = read('backend/Dockerfile');
    expect(dockerfile.indexOf('FROM build AS production-deps')).toBeLessThan(
      dockerfile.indexOf('RUN npm prune'),
    );
    for (const service of Object.values(compose.services) as any[]) {
      for (const [name, dependency] of Object.entries(service.depends_on || {}) as any[]) {
        expect(compose.services[name]).toBeDefined();
        if (dependency.condition === 'service_healthy') {
          expect(compose.services[name].healthcheck).toBeDefined();
        }
      }
    }
  });

  it('keeps initialization secrets out of the API environment and uses the app role', () => {
    const environment = compose.services.backend.environment;
    expect(environment.DATABASE_URL).toContain('customer_ops_app:');
    expect(environment.CUSTOMER_OPS_TENANCY_ENABLED).toBe('true');
    expect(environment.ADMIN_DATABASE_URL).toBe('');
    for (const name of SECRET_KEYS.filter(
      (key: string) => !['JWT_SECRET', 'KEYCLOAK_CLIENT_SECRET'].includes(key),
    )) {
      expect(environment[name]).toBe('');
    }
  });

  it('keeps federation, inference and registry dormant after initializing the template', () => {
    const values = envValues(createEnvironment(template, () => Buffer.alloc(32, 1)));
    for (const [name, value] of Object.entries(values)) {
      if (
        name.endsWith('_BASE_URL') ||
        [
          'FALKORDB_URL',
          'BRIGADE_TRUSTED_ISSUERS',
          'UC_REGISTRY_URL',
          'ENTITLEMENTS_ENDPOINT_URL',
        ].includes(name)
      ) {
        expect(value).toBe('');
      }
    }
    expect(values.CUSTOMER_OPS_ACCESS_LIST).toBe('admin@example.invalid:OWNER');
    expect(values.CUSTOMER_OPS_SIGNUP_MODE).toBe('open');
  });

  it('imports a closed local realm and one administrator with generated credentials', () => {
    expect(realm.realm).toBe(compose.services.backend.environment.KEYCLOAK_REALM);
    expect(realm.registrationAllowed).toBe(false);
    expect(compose.services.backend.environment.CUSTOMER_OPS_ACCESS_LIST).toBe(
      `${realm.users[0].email}:OWNER`,
    );
    expect(realm.users).toHaveLength(1);
    expect(realm.users[0]).toMatchObject({
      username: 'admin',
      enabled: true,
      emailVerified: true,
      credentials: [
        { type: 'password', value: '${CUSTOMER_OPS_ADMIN_PASSWORD}', temporary: false },
      ],
    });
    const client = realm.clients[0];
    expect(client.clientId).toBe(compose.services.backend.environment.KEYCLOAK_CLIENT_ID);
    expect(client.publicClient).toBe(false);
    expect(client.directAccessGrantsEnabled).toBe(false);
    expect(client.secret).toBe('${KEYCLOAK_CLIENT_SECRET}');
    expect(client.redirectUris).toEqual([
      compose.services.backend.environment.KEYCLOAK_CALLBACK_URL,
    ]);
    expect(client.webOrigins).toEqual([compose.services.backend.environment.FRONTEND_URL]);
    for (const [, key] of JSON.stringify(realm).matchAll(/\$\{([A-Z_]+)\}/g)) {
      expect(compose.services.keycloak.environment[key]).toBeDefined();
    }
  });

  it('never assigns migration memberships by an operator email', () => {
    const sql = read(
      'backend/prisma/migrations/20260603202000_suite_tenancy_rls_roles/migration.sql',
    );
    expect(sql).not.toMatch(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/i);
    expect(sql).not.toContain('INSERT INTO "memberships"');
    expect(sql).toContain("'bootstrap-placeholder'");
  });
});
