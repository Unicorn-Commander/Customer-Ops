// Runs only after Prisma migrations, under the admin connection in a one-shot
// container. The API receives the separate NOBYPASSRLS connection afterward.
async function configureDatabase(prisma, password) {
  // ALTER ROLE does not accept bind parameters. Accept only bootstrap hex;
  // reject malformed values before constructing SQL, without logging them.
  if (!/^[a-f0-9]{64}$/.test(password || '')) {
    throw new Error('APP_DB_PASSWORD must be a 32-byte hexadecimal bootstrap value');
  }
  await prisma.$executeRawUnsafe(
    `ALTER ROLE customer_ops_app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD '${password}'`,
  );
  // Historical migrations create these unused roles with development passwords.
  await prisma.$executeRawUnsafe('ALTER ROLE customer_ops_audit NOLOGIN PASSWORD NULL');
  await prisma.$executeRawUnsafe('ALTER ROLE customer_ops_ro NOLOGIN PASSWORD NULL');
  // Name only the fresh migration placeholder; preserve any operator rename.
  // The configured local admin receives OWNER membership on first SSO login.
  await prisma.$executeRawUnsafe(
    `UPDATE "workspaces" SET slug = 'local', "displayName" = 'Local workspace', "updatedAt" = now()
     WHERE id = '0190a000-7e57-7000-8000-00000000c007' AND slug = 'bootstrap-placeholder'`,
  );
}

if (require.main === module) {
  const { PrismaClient } = require('/app/node_modules/@prisma/client');
  const prisma = new PrismaClient();
  configureDatabase(prisma, process.env.APP_DB_PASSWORD)
    .catch(() => {
      // Prisma errors can include the SQL. Never print an ALTER ROLE password.
      console.error('Self-host database role setup failed; the API will not start.');
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}

module.exports = { configureDatabase };
