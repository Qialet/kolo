import { Module } from '@nestjs/common';
import { LiveGateway } from './live/live.gateway.js';
import { SimulationController } from './simulation.controller.js';
import { SimulationService } from './simulation.service.js';

@Module({
  providers: [SimulationService, LiveGateway],
  controllers: [SimulationController],
  exports: [SimulationService],
})
export class SimulationModule {}
