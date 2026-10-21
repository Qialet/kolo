import { Injectable, Logger } from '@nestjs/common';
import { createRng, driverName, MODELS, taxiPlate, type City } from '@kolo/sim';
import { DatabaseService } from '../database.service.js';

const PARTNERS = [
  { id: 'avala', name: 'Avala Fleet d.o.o.', color: '#7C5CFF', depot: 'P1', cars: 12 },
  { id: 'sava', name: 'Sava Motors d.o.o.', color: '#4F7CFF', depot: 'P2', cars: 9 },
  { id: 'dunav', name: 'Dunav Taxi d.o.o.', color: '#E0679A', depot: 'P3', cars: 9 },
];
const COLORS = ['Жёлтый', 'Жёлтый', 'Жёлтый', 'Белый'];

/** Fills an empty database with partners, depots, drivers and cars matching the generated city. */
@Injectable()
export class SeedService {
  private readonly log = new Logger(SeedService.name);

  constructor(private readonly database: DatabaseService) {}

  async ensureSeeded(city: City) {
    const orm = this.database.orm;
    const existing = await orm.Park.aggregate((a) => ({ n: a.count() }));
    if (existing.n > 0) return;
    const rng = createRng(2026);
    const usedPlates = new Set<string>();
    let carNo = 0;
    for (const p of PARTNERS) {
      const depot = city.depots.find((d) => d.id === p.depot)!;
      const address = city.addressById.get(depot.addressId)?.label ?? depot.name;
      await orm.Partner.create({ id: p.id, name: p.name, color: p.color });
      await orm.Park.create({ id: depot.id, name: depot.name, address, capacity: depot.slots.length, serviceBoxes: depot.boxes.length, partnerId: p.id });
      for (let i = 0; i < p.cars; i++) {
        carNo++;
        let plate = taxiPlate(rng);
        while (usedPlates.has(plate)) plate = taxiPlate(rng);
        usedPlates.add(plate);
        const driverId = `D${carNo}`;
        await orm.Driver.create({
          id: driverId,
          name: driverName(rng),
          phone: `+381 6${rng.int(0, 9)} ${rng.int(100, 999)} ${rng.int(1000, 9999)}`,
          rating: Math.round(rng.range(4.55, 4.98) * 100) / 100,
          licenseNo: `TX-${10000 + carNo}`,
          parkId: depot.id,
        });
        // Most cars work the line, a few wait for a driver, one or two are being repaired.
        const fleetStatus = i < p.cars - 3 ? 'ON_LINE' : i < p.cars - 1 ? 'IN_PARK' : carNo % 2 ? 'MAINTENANCE' : 'IN_PARK';
        await orm.Vehicle.create({
          id: `T${carNo}`,
          plate,
          model: rng.pick(MODELS),
          color: rng.pick(COLORS),
          year: rng.int(2017, 2025),
          mileageKm: rng.int(18_000, 240_000),
          fleetStatus,
          parkId: depot.id,
          driverId,
        });
      }
    }
    this.log.log(`Seeded ${PARTNERS.length} partners and ${carNo} taxis`);
  }
}
