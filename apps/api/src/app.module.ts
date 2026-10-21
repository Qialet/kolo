import { Module } from '@nestjs/common';
import { DatabaseModule } from './database/database.module.js';
import { FleetModule } from './fleet/fleet.module.js';
import { HealthController } from './health.controller.js';
import { OrdersModule } from './orders/orders.module.js';
import { SimulationModule } from './simulation/simulation.module.js';

@Module({
  imports: [DatabaseModule, SimulationModule, FleetModule, OrdersModule],
  controllers: [HealthController],
})
export class AppModule {}
