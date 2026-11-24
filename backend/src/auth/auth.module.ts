import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { JwtStrategy } from './strategies/jwt.strategy';
import { KeycloakStrategy } from './strategies/keycloak.strategy';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { PatController } from './pat/pat.controller';
import { PatService } from './pat/pat.service';
import { WorkspaceModule } from '../common/workspace/workspace.module';
import { ContactOpsMapModule } from '../contact-ops/contact-ops-map.module';
import { RedisModule } from '../common/redis/redis.module';
import { SecurityStoreModule } from '../common/security/security-store.module';

@Module({
  imports: [
    WorkspaceModule,
    ContactOpsMapModule,
    // KeycloakStrategy consumes SingleUseTokenStore (SSO state single use).
    RedisModule,
    SecurityStoreModule,
    PassportModule.register({ defaultStrategy: 'jwt' }),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      useFactory: async (configService: ConfigService) => ({
        secret: configService.get('JWT_SECRET'),
        signOptions: {
          expiresIn: configService.get('JWT_EXPIRES_IN', '1d'),
        },
      }),
      inject: [ConfigService],
    }),
  ],
  controllers: [AuthController, PatController],
  providers: [AuthService, JwtStrategy, KeycloakStrategy, JwtAuthGuard, PatService],
  exports: [AuthService, JwtModule, JwtAuthGuard, PatService],
})
export class AuthModule {}
