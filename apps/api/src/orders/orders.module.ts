import { Module } from '@nestjs/common';
import { SimulationModule } from '../simulation/simulation.module.js';
import { OrdersController } from './orders.controller.js';
import { OrdersService } from './orders.service.js';

@Module({
  imports: [SimulationModule],
  controllers: [OrdersController],
  providers: [OrdersService],
})
export class OrdersModule {}
