import { Injectable } from '@nestjs/common';
import {
  QuotePublicSource,
  AcceptPayload,
  ConfirmPayload,
  RequestMeta,
} from '../quotes-render/quotes-render.port';
import { QuotesLifecycleService } from './quotes-lifecycle.service';

/** Production capability repository; no fixture or authentication bypass. */
@Injectable()
export class PersistedQuotePublicSource extends QuotePublicSource {
  constructor(private readonly lifecycle: QuotesLifecycleService) {
    super();
  }
  lookup(token: string, meta: RequestMeta) {
    return this.lifecycle.lookup(token, meta);
  }
  beginAcceptance(token: string, payload: AcceptPayload, meta: RequestMeta) {
    return this.lifecycle.begin(token, payload, meta);
  }
  confirmAcceptance(token: string, payload: ConfirmPayload, meta: RequestMeta) {
    return this.lifecycle.confirm(token, payload, meta);
  }
}
