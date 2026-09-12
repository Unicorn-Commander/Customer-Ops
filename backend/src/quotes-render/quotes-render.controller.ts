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

import { Controller, UseFilters, Get, Headers, Param, Post, Query, Req, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { createHmac, randomBytes } from 'node:crypto';
import type { Request, Response } from 'express';
import { ConfigService } from '@nestjs/config';
import { QuotesRenderService, type DocumentLinks } from './quotes-render.service';
import { QuotePublicSource, type RequestMeta } from './quotes-render.port';
import { PdfUnavailableError } from './quote-pdf.service';
import { AcceptBodySchema, ConfirmBodySchema } from './quotes-render.dto';
import { QuotePendingFilter } from '../quotes/quote-pending.filter';
import { TokenRateLimiter } from './token-rate-limit';

const COOKIE = 'q_v';
const TOKEN_RE = /^[A-Za-z0-9_-]{4,128}$/;

/** An address we are willing to write into an acceptance record. */
const IP_RE = /^(?:\d{1,3}(?:\.\d{1,3}){3}|[0-9a-f:]{2,45})$/i;

/**
 * The client address, taken from the TRUSTED hop only.
 *
 * `X-Forwarded-For` arrives as `<whatever the browser sent>, <what each proxy
 * saw>`. Everything to the left of our own edge is attacker-controlled: a
 * browser can post `X-Forwarded-For: 8.8.8.8` and Traefik will happily forward
 * it with the real address appended. So we count `hops` in from the RIGHT —
 * with the default of one hop (Traefik alone) that is the last entry, the
 * address our own edge observed. Two hops covers an edge behind Cloudflare.
 *
 * `hops = 0` means "no trusted proxy": use the socket peer and ignore the
 * header entirely. Anything unparseable yields null rather than a guess —
 * an acceptance record with a forged IP is worse than one with no IP.
 */
export function clientIp(req: Request, hops: number): string | null {
  const peer = req.socket?.remoteAddress ?? null;
  if (hops <= 0) return peer && IP_RE.test(peer) ? peer : null;
  const raw = req.headers['x-forwarded-for'];
  const chain = (Array.isArray(raw) ? raw.join(',') : (raw ?? ''))
    .split(',')
    .map((entry) => {
      const v = entry.trim().replace(/^\[|\]$/g, '');
      // `1.2.3.4:5678` is an IPv4 with a port; a bare IPv6 is all colons and
      // must keep them. Only strip a trailing port from the dotted form.
      return /^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(v) ? v.slice(0, v.lastIndexOf(':')) : v;
    })
    .filter(Boolean);
  if (!chain.length) return peer && IP_RE.test(peer) ? peer : null;
  const candidate = chain[Math.max(0, chain.length - hops)];
  return candidate && IP_RE.test(candidate) ? candidate : null;
}

export function requestMeta(req: Request, hops: number): RequestMeta {
  const key = req.headers['idempotency-key'];
  return {
    ip: clientIp(req, hops),
    ua:
      typeof req.headers['user-agent'] === 'string'
        ? req.headers['user-agent'].slice(0, 300)
        : null,
    idempotency_key: typeof key === 'string' && key.length <= 200 ? key : null,
  };
}

@ApiExcludeController()
@UseFilters(QuotePendingFilter)
@Controller('public/quotes/:token')
export class QuotesRenderPublicController {
  private readonly secret: string;
  private readonly trustedHops: number;
  private readonly tokenLimiter: TokenRateLimiter;
  private readonly ipLimiter: TokenRateLimiter;

  constructor(
    private readonly render: QuotesRenderService,
    private readonly source: QuotePublicSource,
    config: ConfigService,
  ) {
    // A per-process secret is fine for the mock; L1 sets QUOTES_COOKIE_SECRET so
    // cookies survive restarts and rolling deploys.
    this.secret =
      config.get<string>('QUOTES_COOKIE_SECRET')?.trim() || randomBytes(32).toString('hex');
    const hops = Number(config.get('QUOTES_TRUSTED_PROXY_HOPS') ?? 1);
    this.trustedHops = Number.isInteger(hops) && hops >= 0 ? hops : 1;
    this.ipLimiter = new TokenRateLimiter(
      Number(config.get('QUOTES_IP_RATE_LIMIT') ?? 60),
      Number(config.get('QUOTES_TOKEN_RATE_WINDOW_MS') ?? 60_000),
    );
    this.tokenLimiter = new TokenRateLimiter(
      Number(config.get('QUOTES_TOKEN_RATE_LIMIT') ?? 30),
      Number(config.get('QUOTES_TOKEN_RATE_WINDOW_MS') ?? 60_000),
    );
  }

  private meta(req: Request): RequestMeta {
    return requestMeta(req, this.trustedHops);
  }

  /**
   * Per-TOKEN limit, alongside the per-IP `@Throttle`. They catch different
   * attacks: the throttler stops one address hammering everything, this stops a
   * distributed grind against ONE share link — which is the shape that matters
   * when the prize is a six-digit code. L1 replaces the in-memory counter with
   * the shared Redis store; the call site does not change.
   */
  private tokenLimited(token: string, res: Response, weight = 1, req?: Request): boolean {
    const ipVerdict = req ? this.ipLimiter.hit(this.meta(req).ip ?? 'unattributed', weight) : null;
    const verdict = ipVerdict && !ipVerdict.ok ? ipVerdict : this.tokenLimiter.hit(token, weight);
    if (verdict.ok) return false;
    res.setHeader('Retry-After', String(verdict.retry_after_s));
    problem(
      res,
      429,
      'TOO_MANY_REQUESTS',
      'Too many requests for this quote link. Wait a moment and try again.',
    );
    return true;
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
    const docUrl =
      typeof fromProxy === 'string' && /^\/[A-Za-z0-9/_-]{1,300}$/.test(fromProxy)
        ? fromProxy
        : req.originalUrl.split('?')[0].replace(/\/$/, '');
    if (typeof fromProxy === 'string')
      return {
        accept: `${docUrl}/accept`,
        confirm: `${docUrl}/accept/confirm`,
        pdf: `${docUrl}/pdf`,
      };
    const base = docUrl.replace(/\/document$/, '');
    return { accept: `${base}/accept`, confirm: `${base}/accept/confirm`, pdf: `${base}/pdf` };
  }

  @Get(['', 'document'])
  async document(
    @Param('token') token: string,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    if (!TOKEN_RE.test(token)) {
      res.status(404).type('html').send(this.render.notFoundPage());
      return;
    }
    if (this.tokenLimited(token, res, 1, req)) return;
    const out = await this.render.renderPublic(token, this.meta(req), this.links(req, token));
    if (out.status === 200) {
      const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
      res.setHeader(
        'Set-Cookie',
        `${COOKIE}=${this.bind_(token)}; Path=/; Max-Age=3600; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`,
      );
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
  async bind(
    @Param('token') token: string,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    if (!TOKEN_RE.test(token)) {
      res.status(404).end();
      return;
    }
    if (this.tokenLimited(token, res, 1, req)) return;
    if (!(await this.source.lookup(token, this.meta(req))).found) {
      res.status(404).end();
      return;
    }
    const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
    res.setHeader(
      'Set-Cookie',
      `${COOKIE}=${this.bind_(token)}; Path=/; Max-Age=3600; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`,
    );
    res.status(204).end();
  }

  /**
   * The client-safe view as JSON, for the Next.js share route which renders
   * the vendored copy of the same template. Sets the same binding cookie the
   * document route does, so the acceptance POSTs that follow are accepted.
   */
  @Get('view')
  async view(
    @Param('token') token: string,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    if (!TOKEN_RE.test(token)) {
      res.status(404).json({ found: false });
      return;
    }
    if (this.tokenLimited(token, res, 1, req)) return;
    const out = await this.render.resolvePublic(token, this.meta(req));
    if (!out) {
      res.status(404).json({ found: false });
      return;
    }
    const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
    res.setHeader(
      'Set-Cookie',
      `${COOKIE}=${this.bind_(token)}; Path=/; Max-Age=3600; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`,
    );
    res.status(200).json({ found: true, view: out.view, theme: out.theme });
  }

  @Get(['pdf', 'document.pdf'])
  async pdf(
    @Param('token') token: string,
    @Query('size') size: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    res.setHeader('Cache-Control', 'private, no-store');
    if (!TOKEN_RE.test(token)) {
      res.status(404).type('html').send(this.render.notFoundPage());
      return;
    }
    // A PDF costs a browser page; weight it so a burst of them is rate-limited
    // long before the concurrency gate has to start refusing.
    if (this.tokenLimited(token, res, 5, req)) return;
    try {
      const out = await this.render.renderPublicPdf(
        token,
        this.meta(req),
        size === 'a4' ? 'a4' : 'letter',
      );
      if (!out) {
        res.status(404).type('html').send(this.render.notFoundPage());
        return;
      }
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="${out.filename}"`);
      res.status(200).send(out.pdf);
    } catch (err) {
      if (err instanceof PdfUnavailableError) {
        res
          .status(503)
          .type('application/problem+json')
          .send(
            JSON.stringify({
              type: 'about:blank',
              title: 'PDF renderer unavailable',
              status: 503,
              detail: err.message,
            }),
          );
        return;
      }
      throw err;
    }
  }

  @Post(['accept', 'document/accept'])
  @Throttle({ short: { limit: 6, ttl: 60_000 }, long: { limit: 40, ttl: 3_600_000 } })
  async accept(
    @Param('token') token: string,
    @Req() req: Request,
    @Res() res: Response,
    @Headers('content-type') contentType?: string,
  ): Promise<void> {
    res.setHeader('Cache-Control', 'no-store');
    if (!TOKEN_RE.test(token)) {
      problem(res, 404, 'QUOTE_NOT_FOUND', 'No quote at this link.');
      return;
    }
    if (this.tokenLimited(token, res, 3, req)) return;
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
      {
        name: b.name,
        email: b.email,
        title: b.title ?? null,
        accepted:
          b.accepted === true || b.accepted === '1' || b.accepted === 'true' || b.accepted === 'on',
        selected_line_ids: selected,
      },
      this.meta(req),
    );
    void contentType;
    if (outcome.ok) {
      res
        .status(202)
        .json({
          pending_id: outcome.pending_id,
          expires_at: outcome.expires_at,
          email_hint: outcome.email_hint,
        });
      return;
    }
    problem(res, outcome.status, outcome.code, outcome.detail);
  }

  @Post(['accept/confirm', 'document/accept/confirm'])
  @Throttle({ short: { limit: 10, ttl: 60_000 }, long: { limit: 60, ttl: 3_600_000 } })
  async confirm(
    @Param('token') token: string,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    res.setHeader('Cache-Control', 'no-store');
    if (!TOKEN_RE.test(token)) {
      problem(res, 404, 'QUOTE_NOT_FOUND', 'No quote at this link.');
      return;
    }
    if (this.tokenLimited(token, res, 3, req)) return;
    if (!this.hasCookie(req, token)) {
      problem(res, 428, 'COOKIE_REQUIRED', 'Open the quote page first, then accept from it.');
      return;
    }
    const parsed = ConfirmBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      problem(res, 400, 'CONFIRM_BODY', 'The confirmation body is malformed.');
      return;
    }
    const outcome = await this.source.confirmAcceptance(
      token,
      { pending_id: parsed.data.pending_id ?? null, code: parsed.data.code.replace(/\D/g, '') },
      this.meta(req),
    );
    if (outcome.ok) {
      res.status(200).json({ accepted_at: outcome.accepted_at });
      return;
    }
    res
      .status(outcome.status)
      .type('application/problem+json')
      .send(
        JSON.stringify({
          type: 'about:blank',
          title: outcome.code,
          status: outcome.status,
          detail: outcome.detail,
          code: outcome.code,
          ...(outcome.attempts_left !== undefined ? { attempts_left: outcome.attempts_left } : {}),
        }),
      );
  }
}

function problem(res: Response, status: number, code: string, detail: string): void {
  res
    .status(status)
    .type('application/problem+json')
    .send(JSON.stringify({ type: 'about:blank', title: code, status, detail, code }));
}
