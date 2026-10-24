// Ground height for everything the game places in the world (stops,
// platforms, guidance, AI cars). The world is flat for now; when elevation
// lands, wire the real terrain/road height in here and everything follows.

/** Height of the road/ground surface at map (x, y), metres. */
export function heightAt(_x: number, _y: number): number {
  return 0;
}
