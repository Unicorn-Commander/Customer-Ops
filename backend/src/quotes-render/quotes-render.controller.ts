/**
 * The PUBLIC render surface (no auth; rate-limited; single quote per token):
 *
 *   GET  public/quotes/:token/bind                  → 204 + the A10 binding cookie
 *   GET  public/quotes/:token/view                  → the client-safe view as JSON
 *   GET  public/quotes/:token/document              → the share page (HTML)
 *   GET  public/quotes/:token/document.pdf?size=    → the PDF (letter | a4)
 *   POST public/quotes/:token/document/accept        → pending acceptance (202)
 *   POST public/quotes/:token/document/accept/confirm→ commit with the code (200)
 *
 * A10: the first GET sets an HttpOnly cookie bound to the token; both POSTs
 * require it, and honour `Idempotency-Key`. The Next.js share route renders the
 * document itself from `view`, and a React Server Component cannot set a
 * cookie — so that document calls `bind` from the browser on load. Route
 * handlers under `/q/:token` forward cookies both ways.
 */

import { Controller, Get, Headers, Param, Post, Query, Req, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { createHmac, randomBytes } from 'node:crypto';
import type { Request, Response } from 'express';
import { ConfigService } from '@nestjs/config';
import { QuotesRenderService, type DocumentLinks } from './quotes-render.service';
import { QuotePublicSource, type RequestMeta } from './quotes-render.port';
import { PdfUnavailableError } from './quote-pdf.service';
import { AcceptBodySchema, ConfirmBodySchema } from './quotes-render.dto';

const COOKIE = 'q_v';
const TOKEN_RE = /^[A-Za-z0-9_-]{4,128}$/;

export function requestMeta(req: Request): RequestMeta {
  const key = req.headers['idempotency-key'];
  return {
    ip: req.ip ?? null,
    ua: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'].slice(0, 300) : null,
    idempotency_key: typeof key === 'string' && key.length <= 200 ? key : null,
  };
}

@ApiExcludeController()
@Controller('public/quotes/:token')
export class QuotesRenderPublicController {
  private readonly secret: string;

  constructor(
    private readonly render: QuotesRenderService,
    private readonly source: QuotePublicSource,
    config: ConfigService,
  ) {
    // A per-process secret is fine for the mock; L1 sets QUOTES_COOKIE_SECRET so
    // cookies survive restarts and rolling deploys.
    this.secret = config.get<string>('QUOTES_COOKIE_SECRET')?.trim() || randomBytes(32).toString('hex');
  }

  private bind_(token: string): string {
    return createHmac('sha256', this.secret).update(token).digest('hex').slice(0, 40);
  }

  private hasCookie(req: Request, token: string): boolean {
    const raw = req.headers.cookie;
    if (!raw) return false;
    const want = `${COOKIE}=${this.bind_(token)}`;
    return raw.split(';').some((c) => c.trim() === want);
  }

  private links(req: Request, token: string): DocumentLinks {
    const fromProxy = req.headers['x-quote-document-url'];
    const docUrl = typeof fromProxy === 'string' && /^\/[A-Za-z0-9/_-]{1,300}$/.test(fromProxy) ? fromProxy : req.originalUrl.split('?')[0].replace(/\/$/, '');
    if (typeof fromProxy === 'string') return { accept: `${docUrl}/accept`, confirm: `${docUrl}/accept/confirm`, pdf: `${docUrl}/pdf` };
    return { accept: `${docUrl}/accept`, confirm: `${docUrl}/accept/confirm`, pdf: `${docUrl}.pdf` };
  }

  @Get('document')
  async document(@Param('token') token: string, @Req() req: Request, @Res() res: Response): Promise<void> {
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    if (!TOKEN_RE.test(token)) {
      res.status(404).type('html').send(this.render.notFoundPage());
      return;
    }
    const out = await this.render.renderPublic(token, requestMeta(req), this.links(req, token));
    if (out.status === 200) {
      const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
      res.setHeader('Set-Cookie', `${COOKIE}=${this.bind_(token)}; Path=/; Max-Age=3600; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`);
    }
    res.status(out.status).type('html').send(out.html);
  }

  /**
   * Mint the A10 binding cookie for this token and nothing else: 204, no body,
   * no view recorded. The Next.js share route renders server-side, and a React
   * Server Component cannot set a cookie — so the document asks for its binding
   * from the browser, once, on load. The backend-served document keeps setting
   * the cookie on its own GET and never calls this.
   */
  @Get('bind')
  @Throttle({ short: { limit: 20, ttl: 60_000 }, long: { limit: 120, ttl: 3_600_000 } })
  bind(@Param('token') token: string, @Req() req: Request, @Res() res: Response): void {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    if (!TOKEN_RE.test(token)) {
      res.status(404).end();
      return;
    }
    const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
    res.setHeader('Set-Cookie', `${COOKIE}=${this.bind_(token)}; Path=/; Max-Age=3600; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`);
    res.status(204).end();
  }

  /**
   * The client-safe view as JSON, for the Next.js share route which renders
   * the vendored copy of the same template. Sets the same binding cookie the
   * document route does, so the acceptance POSTs that follow are accepted.
   */
  @Get('view')
  async view(@Param('token') token: string, @Req() req: Request, @Res() res: Response): Promise<void> {
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    if (!TOKEN_RE.test(token)) {
      res.status(404).json({ found: false });
      return;
    }
    const out = await this.render.resolvePublic(token, requestMeta(req));
    if (!out) {
      res.status(404).json({ found: false });
      return;
    }
    const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
    res.setHeader('Set-Cookie', `${COOKIE}=${this.bind_(token)}; Path=/; Max-Age=3600; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`);
    res.status(200).json({ found: true, view: out.view, theme: out.theme });
  }

  @Get('document.pdf')
  async pdf(@Param('token') token: string, @Query('size') size: string | undefined, @Req() req: Request, @Res() res: Response): Promise<void> {
    res.setHeader('Cache-Control', 'private, no-store');
    if (!TOKEN_RE.test(token)) {
      res.status(404).type('html').send(this.render.notFoundPage());
      return;
    }
    try {
      const out = await this.render.renderPublicPdf(token, requestMeta(req), size === 'a4' ? 'a4' : 'letter');
      if (!out) {
        res.status(404).type('html').send(this.render.notFoundPage());
        return;
      }
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="${out.filename}"`);
      res.status(200).send(out.pdf);
    } catch (err) {
      if (err instanceof PdfUnavailableError) {
        res.status(503).type('application/problem+json').send(JSON.stringify({ type: 'about:blank', title: 'PDF renderer unavailable', status: 503, detail: err.message }));
        return;
      }
      throw err;
    }
  }

  @Post('document/accept')
  @Throttle({ short: { limit: 6, ttl: 60_000 }, long: { limit: 40, ttl: 3_600_000 } })
  async accept(@Param('token') token: string, @Req() req: Request, @Res() res: Response, @Headers('content-type') contentType?: string): Promise<void> {
    res.setHeader('Cache-Control', 'no-store');
    if (!TOKEN_RE.test(token)) {
      problem(res, 404, 'QUOTE_NOT_FOUND', 'No quote at this link.');
      return;
    }
    if (!this.hasCookie(req, token)) {
      problem(res, 428, 'COOKIE_REQUIRED', 'Open the quote page first, then accept from it.');
      return;
    }
    const parsed = AcceptBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      problem(res, 400, 'ACCEPT_BODY', 'The acceptance body is malformed.');
      return;
    }
    const b = parsed.data;
    let selected: string[] = [];
    if (Array.isArray(b.selected_line_ids)) selected = b.selected_line_ids;
    else if (typeof b.selected_line_ids === 'string') {
      try {
        const j = JSON.parse(b.selected_line_ids);
        selected = Array.isArray(j) ? j.filter((x): x is string => typeof x === 'string') : [];
      } catch {
        selected = [];
      }
    }
    const outcome = await this.source.beginAcceptance(
      token,
      { name: b.name, email: b.email, title: b.title ?? null, accepted: b.accepted === true || b.accepted === '1' || b.accepted === 'true' || b.accepted === 'on', selected_line_ids: selected },
      requestMeta(req),
    );
    void contentType;
    if (outcome.ok) {
      res.status(202).json({ pending_id: outcome.pending_id, expires_at: outcome.expires_at, email_hint: outcome.email_hint });
      return;
    }
    problem(res, outcome.status, outcome.code, outcome.detail);
  }

  @Post('document/accept/confirm')
  @Throttle({ short: { limit: 10, ttl: 60_000 }, long: { limit: 60, ttl: 3_600_000 } })
  async confirm(@Param('token') token: string, @Req() req: Request, @Res() res: Response): Promise<void> {
    res.setHeader('Cache-Control', 'no-store');
    if (!TOKEN_RE.test(token)) {
      problem(res, 404, 'QUOTE_NOT_FOUND', 'No quote at this link.');
      return;
    }
    if (!this.hasCookie(req, token)) {
      problem(res, 428, 'COOKIE_REQUIRED', 'Open the quote page first, then accept from it.');
      return;
    }
    const parsed = ConfirmBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      problem(res, 400, 'CONFIRM_BODY', 'The confirmation body is malformed.');
      return;
    }
    const outcome = await this.source.confirmAcceptance(token, { pending_id: parsed.data.pending_id ?? null, code: parsed.data.code.replace(/\D/g, '') }, requestMeta(req));
    if (outcome.ok) {
      res.status(200).json({ accepted_at: outcome.accepted_at });
      return;
    }
    res.status(outcome.status).type('application/problem+json').send(JSON.stringify({ type: 'about:blank', title: outcome.code, status: outcome.status, detail: outcome.detail, code: outcome.code, ...(outcome.attempts_left !== undefined ? { attempts_left: outcome.attempts_left } : {}) }));
  }
}

function problem(res: Response, status: number, code: string, detail: string): void {
  res.status(status).type('application/problem+json').send(JSON.stringify({ type: 'about:blank', title: code, status, detail, code }));
}
