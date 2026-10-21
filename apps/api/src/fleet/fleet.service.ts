import { Injectable, NotFoundException } from '@nestjs/common';
import type { FleetStatus, ParkDto, VehicleDto } from '@kolo/contracts';
import { DatabaseService } from '../database/database.service.js';
import { SimulationService } from '../simulation/simulation.service.js';

@Injectable()
export class FleetService {
  constructor(
    private readonly database: DatabaseService,
    private readonly simulation: SimulationService,
  ) {}

  async parks(): Promise<ParkDto[]> {
    const parks = await this.database.orm.Park.include('partner').orderBy((p) => p.id.asc()).all();
    const taxis = [...this.simulation.sim.taxis.values()];
    return parks.map((p) => {
      const mine = taxis.filter((t) => t.info.parkId === p.id);
      return {
        id: p.id,
        code: p.id,
        name: p.name,
        partner: { id: p.partner.id, name: p.partner.name, color: p.partner.color },
        address: p.address,
        capacity: p.capacity,
        serviceBoxes: p.serviceBoxes,
        x: p.x,
        z: p.z,
        counts: {
          total: mine.length,
          onLine: mine.filter((t) => t.fleetStatus === 'ON_LINE').length,
          inPark: mine.filter((t) => t.fleetStatus === 'IN_PARK').length,
          maintenance: mine.filter((t) => t.fleetStatus === 'MAINTENANCE').length,
        },
      };
    });
  }

  async vehicles(parkId?: string): Promise<VehicleDto[]> {
    const base = parkId ? this.database.orm.Vehicle.where({ parkId }) : this.database.orm.Vehicle;
    const rows = await base.include('driver').orderBy((v) => v.id.asc()).all();
    return rows
      .map((v) => ({
        id: v.id,
        plate: v.plate,
        model: v.model,
        color: v.color,
        year: v.year,
        // The simulation is the live source of truth for status.
        fleetStatus: this.simulation.sim.taxis.get(v.id)?.fleetStatus ?? (v.fleetStatus as FleetStatus),
        parkId: v.parkId,
        parkCode: v.parkId,
        driverName: v.driver?.name ?? null,
        mileageKm: v.mileageKm,
      }))
      .sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)));
  }

  setStatus(id: string, status: FleetStatus) {
    if (!this.simulation.sim.setFleetStatus(id, status, 'DISPATCHER')) throw new NotFoundException('Vehicle not found');
    return this.simulation.sim.taxiDetail(id);
  }

  async history(id: string) {
    return this.database.orm.VehicleStatusChange.where({ vehicleId: id })
      .orderBy((c) => c.at.desc())
      .limit(30)
      .all();
  }
}
