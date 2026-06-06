import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import compression from 'compression';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { helmetOptions, bodyLimit } from './common/security/security.config';

async function bootstrap() {
  // Typed as NestExpressApplication so we can cap body sizes via the platform's
  // own bundled body-parser (useBodyParser) — no direct express dependency, so
  // no parser-version drift. bodyParser is DISABLED here so Nest does not also
  // register its default (unbounded-by-our-config) parsers ahead of ours; the
  // useBodyParser calls below are then the ONLY json/urlencoded parsers and
  // their size limit actually takes effect (a default parser would otherwise run
  // first, populate req.body, and shadow our limit).
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bodyParser: false,
  });
  const configService = app.get(ConfigService);
  const logger = new Logger('Bootstrap');

  // Security — CSP + HSTS tuned for a JSON API + its Swagger UI (see
  // common/security/security.config). Defaults to a safe production posture.
  app.use(helmet(helmetOptions()));
  app.use(compression());

  // Body-size limits — a small cap is a cheap DoS guard for a metadata API that
  // never receives large uploads (those federate to the file engines). Tunable
  // via BODY_LIMIT; default 1mb. Uses the platform body-parser so the version
  // always matches @nestjs/platform-express.
  const limit = bodyLimit();
  app.useBodyParser('json', { limit });
  app.useBodyParser('urlencoded', { limit, extended: true });

  // CORS
  app.enableCors({
    origin: configService.get('CORS_ORIGIN', 'http://localhost:3001'),
    credentials: true,
  });

  // Global prefix
  const apiPrefix = configService.get('API_PREFIX', 'api/v1');
  app.setGlobalPrefix(apiPrefix);

  // Global validation pipe
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  // Graceful shutdown — let Nest fire onModuleDestroy hooks (Prisma $disconnect,
  // throttler storage, in-flight federation) on SIGTERM/SIGINT so a rolling
  // deploy drains cleanly instead of dropping live connections.
  app.enableShutdownHooks();

  // Swagger documentation — ON in non-production; in production it is OFF unless
  // SWAGGER_ENABLED=true (don't expose the API surface map by default in prod).
  const nodeEnv = configService.get('NODE_ENV', 'development');
  const swaggerEnabled =
    nodeEnv !== 'production' || configService.get('SWAGGER_ENABLED') === 'true';
  if (swaggerEnabled) {
    const config = new DocumentBuilder()
      .setTitle('Customer-Ops API')
      .setDescription(
        'The relationship / funnel cockpit of the Unicorn Commander suite (Phase 1 foundation).',
      )
      .setVersion('0.1')
      .addBearerAuth(
        {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          name: 'JWT',
          description: 'Enter JWT token',
          in: 'header',
        },
        'JWT-auth',
      )
      .addTag('auth', 'Authentication + SSO')
      .addTag('health', 'Health check endpoints')
      .addTag('mcp', 'MCP server (agents)')
      .build();
    const document = SwaggerModule.createDocument(app, config);
    SwaggerModule.setup(`${apiPrefix}/docs`, app, document, {
      swaggerOptions: { persistAuthorization: true },
    });
  }

  const port = configService.get('PORT', 3211);
  await app.listen(port, '0.0.0.0');

  logger.log(`Customer-Ops API running on http://0.0.0.0:${port}/${apiPrefix}`);
  if (swaggerEnabled) {
    logger.log(`Swagger docs: http://0.0.0.0:${port}/${apiPrefix}/docs`);
  }
}

bootstrap();
