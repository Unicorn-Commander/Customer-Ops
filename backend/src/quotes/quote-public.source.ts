import { Injectable } from '@nestjs/common';
import {
  AcceptOutcome,
  AcceptPayload,
  ConfirmOutcome,
  ConfirmPayload,
  PublicLookup,
  QuotePublicSource,
  RequestMeta,
} from '../quotes-render/quotes-render.port';

/**
 * M1 has draft CRUD, but cannot issue a persisted share token. Bind a closed
 * production source rather than the renderer's dev fixture. M2 replaces this
 * implementation with version/token/pending-acceptance persistence; none of
 * those operations can report success before that repository exists.
 */
@Injectable()
export class M1QuotePublicSource extends QuotePublicSource {
  async lookup(_token: string, _meta: RequestMeta): Promise<PublicLookup> {
    return { found: false };
  }

  async beginAcceptance(
    _token: string,
    _payload: AcceptPayload,
    _meta: RequestMeta,
  ): Promise<AcceptOutcome> {
    return {
      ok: false,
      status: 503,
      code: 'QUOTE_SHARING_UNAVAILABLE',
      detail: 'Quote sharing is not available yet.',
    };
  }

  async confirmAcceptance(
    _token: string,
    _payload: ConfirmPayload,
    _meta: RequestMeta,
  ): Promise<ConfirmOutcome> {
    return {
      ok: false,
      status: 503,
      code: 'QUOTE_SHARING_UNAVAILABLE',
      detail: 'Quote sharing is not available yet.',
    };
  }
}
