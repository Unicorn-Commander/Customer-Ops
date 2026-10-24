const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');

const SECRET_KEYS = [
  'POSTGRES_PASSWORD',
  'APP_DB_PASSWORD',
  'KEYCLOAK_DB_PASSWORD',
  'KEYCLOAK_CLIENT_SECRET',
  'KEYCLOAK_ADMIN_PASSWORD',
  'CUSTOMER_OPS_ADMIN_PASSWORD',
  'JWT_SECRET',
];

// Compose's env_file parser keeps a trailing `# comment` as the value when the
// value before it is blank (`KEY=   # note` becomes `KEY=# note`), which broke
// boot on M365_TOKEN_ENC_KEY. Move every inline comment onto its own line.
function hoistInlineComments(template) {
  return template.replace(
    /^([A-Z0-9_]+)=([^#\n]*?)[ \t]+#[ \t]?([^\n]*)$/gm,
    (_, key, value, comment) => `# ${key}: ${comment}\n${key}=${value.trim()}`,
  );
}

function createEnvironment(template, random = randomBytes) {
  let result = hoistInlineComments(template);
  for (const key of SECRET_KEYS) {
    const placeholder = new RegExp(`^${key}=$`, 'm');
    if (!placeholder.test(result)) throw new Error(`Missing blank placeholder: ${key}`);
    // Hex needs no shell, dotenv, JSON or database-URL escaping.
    result = result.replace(placeholder, `${key}=${random(32).toString('hex')}`);
  }
  return result;
}

function writeEnvironment(template, destination, io = fs, random = randomBytes) {
  // Exclusive creation also rejects symlinks and concurrent initializers.
  io.writeFileSync(destination, createEnvironment(template, random), {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  });
}

if (require.main === module) {
  try {
    writeEnvironment(
      fs.readFileSync(path.join(__dirname, '..', '.env.example'), 'utf8'),
      path.join(__dirname, '..', '.env'),
    );
    console.log('Created deploy/.env with private permissions. Credentials were not printed.');
    console.log('Sign in as admin; read CUSTOMER_OPS_ADMIN_PASSWORD in deploy/.env locally.');
  } catch (error) {
    console.error(
      error.code === 'EEXIST'
        ? 'deploy/.env already exists; left unchanged. Continue with docker compose.'
        : 'Could not initialize deploy/.env. Check template placeholders and directory permissions.',
    );
    process.exitCode = 1;
  }
}

module.exports = { hoistInlineComments, SECRET_KEYS, createEnvironment, writeEnvironment };
