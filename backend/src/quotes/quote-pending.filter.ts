import { ArgumentsHost, Catch, ExceptionFilter } from '@nestjs/common';
import { QuoteNotAvailable } from './quotes-lifecycle.service';

/** No document, identifiers, or customer data leave the server before approval. */
@Catch(QuoteNotAvailable)
export class QuotePendingFilter implements ExceptionFilter {
  catch(_error: QuoteNotAvailable, host: ArgumentsHost) {
    const http = host.switchToHttp(),
      req = http.getRequest(),
      res = http.getResponse();
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    res.setHeader('Retry-After', '60');
    if (/\/(view|bind)$/.test(req.path))
      return res.status(503).json({
        found: false,
        code: 'QUOTE_NOT_AVAILABLE',
        message: 'This quote is not available yet.',
      });
    return res
      .status(503)
      .type('html')
      .send(
        '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Quote link</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#faf9f6;color:#282823;font:18px system-ui}main{max-width:32rem;padding:2rem}h1{font:42px Georgia,serif}p{line-height:1.6;color:#62625c}</style></head><body><main><h1>Not available yet</h1><p>This proposal is awaiting approval. Please check this link again later.</p></main></body></html>',
      );
  }
}
