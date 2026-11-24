/**
 * The one idempotency-key charset rule, shared by the REST DTOs
 * (class-validator `@Matches`) and the MCP tool schemas (zod `.regex`), so an
 * MCP caller cannot pass a key the REST surface would refuse (CUO-MCP-1).
 */
export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]+$/;
export const IDEMPOTENCY_KEY_MAX_LENGTH = 200;
export const IDEMPOTENCY_KEY_MESSAGE =
  'idempotencyKey may contain only letters, digits, and . _ : -';
