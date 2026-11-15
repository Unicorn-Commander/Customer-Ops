import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { Response } from 'express';
import { ProvisioningGuard } from './provisioning.guard';
import { ProvisioningService } from './provisioning.service';

/**
 * Contract D routes, called only by Ops-Center with its per-app service token.
 * Registered only when PROVISIONING_ENABLED is on (see ProvisioningModule).
 */
@ApiExcludeController()
@UseGuards(ProvisioningGuard)
@Controller('provisioning/workspaces')
export class ProvisioningController {
  constructor(private readonly provisioning: ProvisioningService) {}

  @Post()
  async create(
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { created, view } = await this.provisioning.ensureWorkspace(body, idempotencyKey);
    res.status(created ? HttpStatus.CREATED : HttpStatus.OK);
    return view;
  }

  @Get(':workspaceId')
  get(@Param('workspaceId') workspaceId: string) {
    return this.provisioning.getWorkspace(workspaceId);
  }

  @Patch(':workspaceId')
  setState(@Param('workspaceId') workspaceId: string, @Body() body: unknown) {
    return this.provisioning.setState(workspaceId, body);
  }

  @Delete(':workspaceId/members/:subject')
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeMember(
    @Param('workspaceId') workspaceId: string,
    @Param('subject') subject: string,
  ): Promise<void> {
    await this.provisioning.removeMember(workspaceId, subject);
  }
}
