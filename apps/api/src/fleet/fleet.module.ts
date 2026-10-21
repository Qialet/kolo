import { Module } from '@nestjs/common';
import { SimulationModule } from '../simulation/simulation.module.js';
import { FleetController } from './fleet.controller.js';
import { FleetService } from './fleet.service.js';

@Module({
  imports: [SimulationModule],
  controllers: [FleetController],
  providers: [FleetService],
})
export class FleetModule {}
