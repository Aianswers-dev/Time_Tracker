// Tiny shared state between the player's (high detail) bus and its cab:
// the cab's passenger display and ticket console show the bus's route.
import type { DestinationSign } from '../types';

export const playerSign: DestinationSign = { route: '', headsign: '' };
