/**
 * Kolo identity. The city is a monotone cool-slate world with soft gradients;
 * only meaningful objects get accent colours so they read at any zoom level.
 */
export const palette = {
  // World
  sky: '#E9EEF5',
  asphalt: '#BEC6D2',
  asphaltDark: '#BCC4D0',
  sidewalk: '#E0E5ED',
  block: '#EAEEF4',
  marking: '#FFFFFF',
  median: '#D7DEE6',
  buildingTop: '#FFFFFF',
  buildingBase: '#AFB9C8',
  buildingTints: ['#FFFFFF', '#F3F5F9', '#E9EDF3', '#F7F4EF'],
  poiTint: '#E4EAF6',
  tree: '#B7C8C1',
  treeDark: '#9DB3AA',
  trunk: '#8E8A84',
  park: '#DCE6E1',
  lawn: '#D3E2D9',
  forest: '#C8D9CF',
  pitch: '#CFE1D2',
  water: '#C6D9EA',
  plaza: '#E8EBF0',
  // Pedestrian streets and paths: warm paving, apart from the cool sidewalks and the asphalt.
  paving: '#E8E0D2',
  path: '#D6CCBA',
  parking: '#D8DDE5',
  shed: '#DDE2EA',
  // Courtyard playgrounds: warm sand and muted pastel equipment, quiet next to the accents.
  playPad: '#EEE4D4',
  playSand: '#E6D3A6',
  playFrame: '#A9B4C4',
  playSlide: '#9CC9C1',
  playSeat: '#E8A98F',
  // Accents
  taxi: '#FFC21A',
  taxiDeep: '#E5A400',
  taxiSign: '#1B1D22',
  bus: '#2F6BFF',
  busDeep: '#1F4FD1',
  trolley: '#169DBF',
  minibus: '#6E98FF',
  /** Trams: deep indigo, the darkest of the transit blues. */
  tram: '#3347B8',
  /** Overhead wires (trolleybus and tram), poles and the pantograph. */
  wire: '#3B4250',
  rail: '#7F8898',
  /** Gravel bed where a track runs on its own, off the street lanes. */
  ballast: '#CBC6BD',
  /** Tram platforms: raised islands, lighter than the sidewalk. */
  platform: '#F1F3F7',
  /** Bridge decks and tunnel portals: light concrete parapets and lintels, darker slab sides and piers. */
  deck: '#DCE1E8',
  deckSide: '#A9B3C1',
  /** The dark end of a tunnel mouth. */
  tunnelMouth: '#363C47',
  depot: '#7C5CFF',
  depotLot: '#D9D8EC',
  service: '#FF6B3D',
  pickup: '#12B886',
  dropoff: '#1B1D22',
  danger: '#F0445B',
  // Signals (emissive)
  red: '#FF3B47',
  amber: '#FFB020',
  /** Turn signals of moving vehicles: oranger than the taxi pick-up amber. */
  blinker: '#FF8A1C',
  green: '#22D47A',
  lampOff: '#3A3F4A',
  pole: '#5B6372',
  // Road signs: matte, the classic red, white and yellow of Serbian signs.
  signRed: '#D8343F',
  signWhite: '#FFFFFF',
  signYellow: '#F6C343',
  signBack: '#A3ACB9',
  // Civilian cars stay neutral so taxis pop.
  cars: ['#FFFFFF', '#E7EAF0', '#B9C1CD', '#8C96A5', '#5E6878', '#3A4250', '#C9C2B8'],
  glass: '#55637C',
} as const;

export const ACTIVITY_LABEL: Record<string, string> = {
  PARKED: 'В парке',
  LEAVING_PARK: 'Выезд из парка',
  FREE: 'Свободен',
  TO_PICKUP: 'Едет к клиенту',
  AT_PICKUP: 'Ожидает клиента',
  ON_TRIP: 'С пассажиром',
  TO_PARK: 'Возвращается в парк',
  TO_SERVICE: 'Едет в сервис',
  IN_SERVICE: 'В сервисном боксе',
};

export const FLEET_LABEL: Record<string, string> = {
  ON_LINE: 'На линии',
  IN_PARK: 'В парке',
  MAINTENANCE: 'Ремонт',
};

export const ORDER_LABEL: Record<string, string> = {
  SEARCHING: 'Поиск',
  ASSIGNED: 'Назначен',
  ARRIVED: 'Машина на месте',
  IN_PROGRESS: 'В пути',
  COMPLETED: 'Выполнен',
  CANCELLED: 'Отменён',
  NO_SHOW: 'Неявка',
  EXPIRED: 'Не найдена машина',
};

export const EVENT_LABEL: Record<string, string> = {
  CREATED: 'Заказ создан',
  OFFERED: 'Предложение водителю',
  OFFER_MISSED: 'Предложение пропущено',
  ASSIGNED: 'Водитель назначен',
  ARRIVED: 'Машина на месте',
  PICKED_UP: 'Пассажир в машине',
  COMPLETED: 'Поездка завершена',
  CANCELLED: 'Отмена',
  NO_SHOW: 'Неявка пассажира',
  EXPIRED: 'Нет машин',
  DISPUTE_OPENED: 'Возражение',
  DISPUTE_RESOLVED: 'Возражение решено',
};

export const ACTOR_LABEL: Record<string, string> = {
  PASSENGER: 'пассажир',
  DRIVER: 'водитель',
  DISPATCHER: 'диспетчер',
  SYSTEM: 'система',
};

/** Badge tone for statuses (maps onto Badge variants + accent classes). */
export type Tone = 'taxi' | 'bus' | 'depot' | 'service' | 'success' | 'danger' | 'muted' | 'info';

export const activityTone = (a: string): Tone =>
  a === 'FREE' ? 'success' : a === 'ON_TRIP' || a === 'TO_PICKUP' || a === 'AT_PICKUP' ? 'taxi' : a === 'IN_SERVICE' || a === 'TO_SERVICE' ? 'service' : 'depot';

export const orderTone = (s: string): Tone =>
  s === 'COMPLETED' ? 'success' : s === 'CANCELLED' || s === 'NO_SHOW' || s === 'EXPIRED' ? 'danger' : s === 'SEARCHING' ? 'info' : 'taxi';

export const fleetTone = (s: string): Tone => (s === 'ON_LINE' ? 'success' : s === 'MAINTENANCE' ? 'service' : 'depot');
