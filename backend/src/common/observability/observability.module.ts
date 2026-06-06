import { Global, Module } from '@nestjs/common';
import { ErrorTrackingService } from './error-tracking.service';

/**
 * The observability seam — bundles the cross-cutting error-tracking hook.
 *
 * Global so the globally-bound AllExceptionsFilter (registered in app.module via
 * APP_FILTER) can inject ErrorTrackingService without app.module re-declaring it.
 * ConfigModule is already global, so ErrorTrackingService resolves its
 * (optional) SENTRY_DSN everywhere.
 *
 * The request-id middleware, the RFC-7807 filter, and the request-logging
 * interceptor are wired in app.module (middleware via `configure()`, filter +
 * interceptor via APP_FILTER/APP_INTERCEPTOR) so they apply to every route.
 */
@Global()
@Module({
  providers: [ErrorTrackingService],
  exports: [ErrorTrackingService],
})
export class ObservabilityModule {}
