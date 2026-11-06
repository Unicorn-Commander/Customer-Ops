import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { IngestLeadDto } from './lead-intake.dto';

/**
 * The global ValidationPipe (transform + whitelist) is what POST /leads/ingest
 * runs. These tests replay that: plainToInstance applies @Transform, then
 * validate() applies class-validator. A bad email is a 400 whose message names
 * the field. The idempotency key (source + sourceDedupKey) is not rewritten.
 */
async function check(plain: Record<string, unknown>) {
  const dto = plainToInstance(IngestLeadDto, plain);
  const errors = await validate(dto);
  return { dto, errors };
}

describe('IngestLeadDto — email', () => {
  const base = { source: 'northwind', sourceDedupKey: 'L-1', displayName: 'Pat Example' };

  it('rejects "not-an-email" and names the email field', async () => {
    const { errors } = await check({ ...base, email: 'not-an-email' });
    const email = errors.find((e) => e.property === 'email');
    expect(email).toBeDefined();
    expect(JSON.stringify(email?.constraints)).toContain('email must be an email');
  });

  it('trims and lowercases a valid email and leaves the idempotency key unchanged', async () => {
    const { dto, errors } = await check({
      ...base,
      sourceDedupKey: 'Dedup-Key',
      email: '  Lead@Example.com ',
    });
    expect(errors).toHaveLength(0);
    expect(dto.email).toBe('lead@example.com');
    expect(dto.source).toBe('northwind');
    expect(dto.sourceDedupKey).toBe('Dedup-Key');
  });

  it('treats a blank email as absent so another identity key can still resolve', async () => {
    const { dto, errors } = await check({ ...base, email: '   ' });
    expect(errors).toHaveLength(0);
    expect(dto.email).toBeUndefined();
  });
});
