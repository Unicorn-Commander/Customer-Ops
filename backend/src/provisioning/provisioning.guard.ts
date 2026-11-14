import {
  CanActivate,
  ExecutionContext,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { Request } from 'express';
import { ProvisioningTokenService } from './provisioning-token.service';

/**
 * The only authentication on the provisioning routes: the control plane's
 * per-app service token. No user session or PAT is accepted here.
 *
 * Without a usable secret the routes answer 404 with the same body as an
 * unregistered route, so a half-configured node looks exactly like a disabled one.
 */
@Injectable()
export class ProvisioningGuard implements CanActivate {
  constructor(private readonly tokens: ProvisioningTokenService) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    const secret = this.tokens.secret();
    if (!secret) {
      const path = (req.originalUrl ?? req.url ?? '').split('?')[0];
      throw new NotFoundException(`Cannot ${req.method} ${path}`);
    }
    const header = req.headers?.authorization;
    const match = typeof header === 'string' ? /^Bearer\s+(\S+)$/i.exec(header.trim()) : null;
    if (!match) throw new UnauthorizedException('Provisioning token required.');
    this.tokens.verify(match[1], secret);
    return true;
  }
}
