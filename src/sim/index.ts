/**
 * Driving subsystem: input, vehicle physics, collisions, camera rig and audio.
 * main.ts uses the classes below; everything else here is optional extras.
 */
export { InputManager, KEY_ACTIONS, type InputOptions } from './input';
export { BusPhysics, type PhysicsResult } from './physics';
export { BusControls } from './controls';
export { buildCollider, isSimCollider, WallKind, type SimCollider, type ResolveResult, type RoadSnap, type ColliderOptions } from './collider';
export { CameraRig, type CameraMode } from './camera';
export { BusAudio } from './audio';
export { TouchControls } from './touch';
export { telemetry, onSimEvent, isSimInput, type SimEvent, type SimInput, type Telemetry } from './hub';
