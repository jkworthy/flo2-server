import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

/**
 * The open area's rules, read from the same world.json the client uses.
 *
 * One source of truth matters here for the same reason it did for the node
 * graph: if the server's idea of the walkable region differed from the
 * client's, players would either be rubber-banded out of places they can see,
 * or able to stand somewhere nobody else renders them.
 */
// world.json lives inside the server, and the client imports it from here. One
// file, not two: Colyseus Cloud deploys this directory as its own repository, so
// anything outside it simply would not be there - and a copy on each side is a
// pair that silently drifts until the server and client disagree about where
// the walls are.
const here = dirname(fileURLToPath(import.meta.url));
const WORLD_PATH = join(here, "../../shared/world.json");
const raw = JSON.parse(readFileSync(WORLD_PATH, "utf8"));

export const WORLD = raw;
export const BOUNDS = raw.bounds;

/** Generous: the point is to stop teleporting, not to police latency jitter. */
const MAX_SPEED = (raw.move?.runSpeed ?? 5.2) * 1.8;

export function clampToBounds(x, y) {
  return {
    x: Math.max(BOUNDS.minX, Math.min(BOUNDS.maxX, x)),
    y: Math.max(BOUNDS.minY, Math.min(BOUNDS.maxY, y)),
  };
}

const RADIUS = 0.35;

/**
 * The sites, as circles you cannot walk into.
 *
 * Circles rather than boxes because these are buildings you walk around, and a
 * box would stop you at a corner you can plainly see past. This mirrors
 * pushOutOfSites in the client exactly - both read the same world.json, so
 * neither can drift from the other about where a monument is.
 */
const SITES = (raw.sites || []).map((s) => ({ x: s.x, y: s.y, r: s.radius }));

export function ejectFromSites(x, y) {
  for (const s of SITES) {
    const dx = x - s.x, dy = y - s.y;
    const d = Math.hypot(dx, dy);
    const min = s.r + RADIUS;
    if (d >= min) continue;
    if (d < 1e-6) return { x: s.x + min, y: s.y };
    return { x: s.x + (dx / d) * min, y: s.y + (dy / d) * min };
  }
  return { x, y };
}
const BLOCKERS = (raw.walls || []).map((w) => ({
  minX: w.x - w.w / 2 - RADIUS, maxX: w.x + w.w / 2 + RADIUS,
  minY: w.y - w.d / 2 - RADIUS, maxY: w.y + w.d / 2 + RADIUS,
}));

/**
 * Push a point out of any wall it has ended up inside.
 *
 * An honest client never reaches this - OpenArea.resolve stops it first - so it
 * exists only for a doctored one. Ejecting along the shallowest axis is what
 * sliding along a wall would have produced anyway, so a player who clips a
 * corner through latency gets nudged rather than flung.
 */
export function ejectFromWalls(x, y) {
  for (const b of BLOCKERS) {
    if (x <= b.minX || x >= b.maxX || y <= b.minY || y >= b.maxY) continue;
    const out = [
      { d: x - b.minX, x: b.minX, y }, { d: b.maxX - x, x: b.maxX, y },
      { d: y - b.minY, x, y: b.minY }, { d: b.maxY - y, x, y: b.maxY },
    ].sort((p, q) => p.d - q.d)[0];
    return { x: out.x, y: out.y };
  }
  return { x, y };
}

/**
 * Accept a proposed position, or pull it back toward the last known one.
 *
 * Clamping rather than rejecting: a rejected move leaves the client and server
 * disagreeing until the next update, which shows up as rubber-banding. Pulling
 * the move back to the furthest legal point keeps them in step.
 */
export function validateMove(prev, next, dtSeconds) {
  const limit = MAX_SPEED * Math.max(dtSeconds, 0.016) + 0.25;
  const dx = next.x - prev.x, dy = next.y - prev.y;
  const dist = Math.hypot(dx, dy);
  const capped = dist <= limit
    ? { x: next.x, y: next.y }
    : { x: prev.x + dx * (limit / (dist || 1)), y: prev.y + dy * (limit / (dist || 1)) };
  const inside = clampToBounds(capped.x, capped.y);
  const clear = ejectFromWalls(inside.x, inside.y);
  return ejectFromSites(clear.x, clear.y);
}
