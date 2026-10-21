import type { Rng } from '../rng.js';

const FIRST = ['Marko', 'Nikola', 'Stefan', 'Luka', 'Miloš', 'Aleksandar', 'Nemanja', 'Dušan', 'Vuk', 'Filip', 'Jelena', 'Milica', 'Ana', 'Jovana', 'Marija', 'Teodora', 'Katarina', 'Ivana', 'Sara', 'Tijana', 'Đorđe', 'Petar', 'Uroš', 'Bojan', 'Dragan', 'Zoran', 'Goran', 'Snežana', 'Vesna', 'Dragana'];
const LAST = ['Petrović', 'Jovanović', 'Nikolić', 'Marković', 'Đorđević', 'Stojanović', 'Ilić', 'Stanković', 'Pavlović', 'Milošević', 'Kovačević', 'Popović', 'Tomić', 'Lazić', 'Savić', 'Ristić', 'Vasić', 'Mitrović', 'Simić', 'Obradović'];

export const MODELS = ['Škoda Octavia', 'Toyota Corolla Hybrid', 'Hyundai i30', 'Kia Ceed', 'Dacia Logan', 'Volkswagen Passat', 'Toyota Prius+', 'Škoda Superb', 'Renault Megane'];

export const passengerName = (rng: Rng) => `${rng.pick(FIRST)} ${rng.pick(LAST).charAt(0)}.`;
export const driverName = (rng: Rng) => `${rng.pick(FIRST)} ${rng.pick(LAST)}`;
/** Belgrade taxi plates end in "TX". */
export const taxiPlate = (rng: Rng) => `BG ${rng.int(100, 9999)}-TX`;

export const CANCEL_REASONS_PASSENGER = ['Пассажир передумал', 'Слишком долгое ожидание', 'Нашёл другую машину', 'Изменились планы'];
export const CANCEL_REASONS_DRIVER = ['Не могу подъехать к адресу', 'Пробка, не успеваю', 'Неисправность автомобиля'];
export const DISPUTE_REASONS = ['Неоптимальный маршрут', 'Завышенная стоимость', 'Водитель был груб', 'Грязный салон', 'Списание за неявку'];
