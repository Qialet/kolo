import { Body, Controller, Get, Param, Patch, Query } from '@nestjs/common';
import { SetFleetStatusInput } from '@kolo/contracts';
import { ZodPipe } from '../common/zod.pipe.js';
import { FleetService } from './fleet.service.js';

@Controller('fleet')
export class FleetController {
  constructor(private readonly fleet: FleetService) {}

  @Get('parks')
  parks() {
    return this.fleet.parks();
  }

  @Get('vehicles')
  vehicles(@Query('parkId') parkId?: string) {
    return this.fleet.vehicles(parkId);
  }

  @Patch('vehicles/:id/status')
  setStatus(@Param('id') id: string, @Body(new ZodPipe(SetFleetStatusInput)) input: SetFleetStatusInput) {
    return this.fleet.setStatus(id, input.status);
  }

  @Get('vehicles/:id/history')
  history(@Param('id') id: string) {
    return this.fleet.history(id);
  }
}
