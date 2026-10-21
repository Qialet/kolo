import { Body, Controller, Get, NotFoundException, Param, ParseIntPipe, Patch, Post } from '@nestjs/common';
import { LightControlInput, SimControlInput } from '@kolo/contracts';
import { ZodPipe } from '../common/zod.pipe.js';
import { SimulationService } from './simulation.service.js';

@Controller('sim')
export class SimulationController {
  constructor(private readonly simulation: SimulationService) {}

  @Get('state')
  state() {
    const sim = this.simulation.sim;
    return { kpi: sim.kpi(), speed: sim.speed, paused: sim.paused, trafficDensity: sim.trafficDensity, demand: sim.demand, districtVersion: this.simulation.city.version };
  }

  @Post('control')
  control(@Body(new ZodPipe(SimControlInput)) input: SimControlInput) {
    this.simulation.sim.control(input);
    return this.state();
  }

  @Get('events')
  events() {
    return this.simulation.recentEvents;
  }

  @Get('taxis/:id')
  taxi(@Param('id') id: string) {
    return this.simulation.sim.taxiDetail(id) ?? notFound('Taxi');
  }

  @Get('buses/:id')
  bus(@Param('id') id: string) {
    return this.simulation.sim.busDetail(id) ?? notFound('Bus');
  }

  @Get('lights/:id')
  light(@Param('id', ParseIntPipe) id: number) {
    return this.simulation.sim.lightDetail(id) ?? notFound('Traffic light');
  }

  @Patch('lights/:id')
  setLight(@Param('id', ParseIntPipe) id: number, @Body(new ZodPipe(LightControlInput)) input: LightControlInput) {
    if (!this.simulation.sim.setLight(id, input)) notFound('Traffic light');
    const detail = this.simulation.sim.lightDetail(id)!;
    this.simulation.pushEvent({ id: `L${Date.now()}`, at: Date.now(), severity: 'info', title: `Светофор: ${detail.name}`, detail: `Режим ${detail.mode}, зелёный ${detail.phases.map((p) => p.green).join('/')} с` });
    return detail;
  }
}

function notFound(what: string): never {
  throw new NotFoundException(`${what} not found`);
}
