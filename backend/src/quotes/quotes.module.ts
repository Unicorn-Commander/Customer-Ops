import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { WorkspaceModule } from '../common/workspace/workspace.module';
import { PrismaModule } from '../prisma/prisma.module';
import { QuotesService } from './quotes.service';
import { QuotesController } from './quotes.controller';
@Module({
  imports: [AuthModule, WorkspaceModule, PrismaModule],
  providers: [QuotesService],
  controllers: [QuotesController],
  exports: [QuotesService],
})
export class QuotesModule {}
