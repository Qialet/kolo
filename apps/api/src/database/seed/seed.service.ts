import { Injectable, Logger } from '@nestjs/common';
import { createRng, driverName, MODELS, taxiPlate, type City } from '@kolo/sim';
import { DatabaseService } from '../database.service.js';

const PARTNERS = [
  { id: 'avala', name: 'Avala Fleet d.o.o.', color: '#7C5CFF', depot: 'P1', cars: 24 },
  { id: 'sava', name: 'Sava Motors d.o.o.', color: '#4F7CFF', depot: 'P2', cars: 18 },
  { id: 'dunav', name: 'Dunav Taxi d.o.o.', color: '#E0679A', depot: 'P3', cars: 18 },
];
const COLORS = ['Жёлтый', 'Жёлтый', 'Жёлтый', 'Белый'];

const numberOf = (id: string) => Number(id.replace(/\D/g, '')) || 0;

/**
 * Brings the database up to the fleet of the district: partners, depots, drivers and cars.
 * An empty database is filled; an existing one gets the missing cars added (ids and plates continue).
 */
@Injectable()
export class SeedService {
  private readonly log = new Logger(SeedService.name);

  constructor(private readonly database: DatabaseService) {}

  async ensureSeeded(city: City) {
    const orm = this.database.orm;
    const rng = createRng(2026);
    const plates = new Set((await orm.Vehicle.select('plate').all()).map((v) => v.plate));
    let carNo = Math.max(0, ...(await orm.Vehicle.select('id').all()).map((v) => numberOf(v.id)));
    let driverNo = Math.max(0, ...(await orm.Driver.select('id').all()).map((d) => numberOf(d.id)));
    let added = 0;
    for (const p of PARTNERS) {
      const depot = city.depots.find((d) => d.id === p.depot);
      if (!depot) throw new Error(`District has no depot ${p.depot}`);
      if (!(await orm.Partner.where({ id: p.id }).first())) await orm.Partner.create({ id: p.id, name: p.name, color: p.color });
      if (!(await orm.Park.where({ id: depot.id }).first())) {
        const address = city.addressById.get(depot.addressId)?.label ?? depot.name;
        await orm.Park.create({ id: depot.id, name: depot.name, address, capacity: depot.slots.length, serviceBoxes: depot.boxes.length, partnerId: p.id });
      }
      const have = await orm.Vehicle.where({ parkId: depot.id }).aggregate((a) => ({ n: a.count() }));
      for (let i = have.n; i < p.cars; i++) {
        carNo++;
        driverNo++;
        let plate = taxiPlate(rng);
        while (plates.has(plate)) plate = taxiPlate(rng);
        plates.add(plate);
        const driverId = `D${driverNo}`;
        await orm.Driver.create({
          id: driverId,
          name: driverName(rng),
          phone: `+381 6${rng.int(0, 9)} ${rng.int(100, 999)} ${rng.int(1000, 9999)}`,
          rating: Math.round(rng.range(4.55, 4.98) * 100) / 100,
          licenseNo: `TX-${10000 + driverNo}`,
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
        added++;
      }
    }
    if (added) this.log.log(`Added ${added} taxis (fleet target ${PARTNERS.reduce((s, p) => s + p.cars, 0)})`);
  }

  /** The district yard is the source of truth for address, position, slots and boxes; keep the park rows in step. */
  async syncParks(city: City) {
    const orm = this.database.orm;
    const parks = await orm.Park.all();
    for (const park of parks) {
      const depot = city.depots.find((d) => d.id === park.id);
      if (!depot) continue;
      const next = {
        address: city.addressById.get(depot.addressId)?.label ?? depot.name,
        x: Math.round(depot.gate.x * 10) / 10,
        z: Math.round(depot.gate.z * 10) / 10,
        capacity: depot.slots.length,
        serviceBoxes: depot.boxes.length,
      };
      if (park.address !== next.address || park.x !== next.x || park.z !== next.z || park.capacity !== next.capacity || park.serviceBoxes !== next.serviceBoxes) {
        await orm.Park.where({ id: park.id }).update(next);
        this.log.log(`Park ${park.id}: ${next.address}, capacity ${park.capacity} → ${next.capacity}, boxes ${park.serviceBoxes} → ${next.serviceBoxes}`);
      }
      const cars = await orm.Vehicle.where({ parkId: park.id }).aggregate((a) => ({ n: a.count() }));
      if (cars.n > next.capacity) this.log.warn(`Park ${park.id} has ${cars.n} cars for ${next.capacity} slots`);
    }
  }
}
