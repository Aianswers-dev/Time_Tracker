// Liveries. Colours sampled from photos of the Brisbane fleet (2015-2025):
//  - Transport for Brisbane "TransLink" scheme: white body, mid blue skirt and
//    bumper, yellow front panel / A-pillars / mirrors, black window band,
//    yellow+blue swoosh on the rear quarter, white LED destination signs.
//  - Blue CityGlider (60): sky-blue front, deep blue bumper and roof band,
//    silver sides with blue waves, "CityGlider" lettering and possum motif.
//  - Maroon CityGlider (61): maroon with a white wave, blue BT bumper.
//  - Brisbane Metro (M1/M2, HESS lighTram 25): dark navy, white skirt with a
//    blue stripe, gold roof line and gold dotted wave, silver bellows.
//  - City Loop (40/50, Yutong E12): purple with yellow headlamp surrounds.
//  - Contract operators on TransLink routes: blue/green TransLink scheme.
import type { BusType, Route } from '../types';
import { hashString, rgb, type RGB } from './util';

export type LiveryId = 'translink' | 'glider-blue' | 'glider-maroon' | 'metro' | 'cityloop' | 'contract';

export interface Livery {
  id: LiveryId;
  sign: 'white' | 'amber';
  mirror: RGB;
  electric: boolean;
  /** Fleet number painted on the high-detail bus. */
  fleet: string;
  plate: string;
}

export const C = {
  btBlue: '#2462cc',
  btYellow: '#f6c400',
  white: '#f3f4f1',
  navy: '#12306e',
  glass: '#0b0f14',
  gliderSky: '#56b3ea',
  gliderDeep: '#1c4fbf',
  gliderSilver: '#e6ebf0',
  maroon: '#7c1830',
  maroonDark: '#5e0f22',
  maroonPink: '#c24872',
  metroBody: '#1a2130',
  metroBlue: '#1f50d6',
  metroGold: '#f0b20a',
  loopPurple: '#5b3fc6',
  loopLavender: '#9483ea',
  contractBlue: '#1160c4',
  contractGreen: '#7dc243',
};

export function liveryFor(type: BusType, route?: Route): LiveryId {
  if (type === 'metro') return 'metro';
  if (type === 'glider') return route?.id === '61' ? 'glider-maroon' : 'glider-blue';
  if (route) {
    if (route.id === '40' || route.id === '50') return 'cityloop';
    if (route.id === '60') return 'glider-blue';
    if (route.id === '61') return 'glider-maroon';
    if (route.operator && route.operator !== 'BT' && route.operator !== 'MET') return 'contract';
  }
  return 'translink';
}

const LETTERS = 'ABCDEFGHJKLMNPRSTUVWXYZ';

export function makeLivery(id: LiveryId, seedText = ''): Livery {
  const r = hashString(id + seedText);
  const n = (k: number) => Math.floor(((r >>> (k * 3)) % 1000) / 1000 * 10);
  const plate = `${(r % 900) + 100}${LETTERS[(r >>> 8) % LETTERS.length]}${LETTERS[(r >>> 13) % LETTERS.length]}${LETTERS[(r >>> 18) % LETTERS.length]}`;
  switch (id) {
    case 'translink':
      return { id, sign: 'white', mirror: rgb(C.btYellow), electric: false, fleet: `${'VTSGW'[r % 5]}${2290 + (r % 60)}`, plate };
    case 'glider-blue':
      return { id, sign: 'white', mirror: rgb(C.btYellow), electric: false, fleet: `T28${String(17 + (r % 37)).padStart(2, '0')}`, plate };
    case 'glider-maroon':
      return { id, sign: 'amber', mirror: rgb('#e9d27a'), electric: false, fleet: `C20${36 + (r % 13)}`, plate };
    case 'metro':
      return { id, sign: 'white', mirror: rgb('#1b1e24'), electric: true, fleet: `90${String(1 + (r % 60)).padStart(2, '0')}`, plate: `XB${n(1)}${n(2)}${LETTERS[r % LETTERS.length]}${LETTERS[(r >>> 5) % LETTERS.length]}` };
    case 'cityloop':
      return { id, sign: 'white', mirror: rgb(C.btYellow), electric: true, fleet: `E600${1 + (r % 6)}`, plate };
    case 'contract':
      return { id, sign: 'white', mirror: rgb('#1c1f24'), electric: false, fleet: `${1000 + (r % 900)}`, plate };
  }
}
