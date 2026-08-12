import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

/**
 * The node graph, loaded from the same JSON the client uses.
 *
 * One source of truth is not a tidiness point here - it is the whole security
 * model. The server rejects any move that is not an edge, so if the two ever
 * disagreed, players would be desynced or able to reach nodes they should not.
 */
const here = dirname(fileURLToPath(import.meta.url));

// Locally the server sits under flo2/server/, so shared/ is three levels up.
// Colyseus Cloud deploys with package.json at the repo root, which makes the
// server the root and shared/ two levels up instead. Try both rather than
// letting the layout difference show up as a boot crash in production only.
const CANDIDATES = ["../../../shared/graph.json", "../../shared/graph.json"];
let raw = null, tried = [];
for (const rel of CANDIDATES) {
  const p = join(here, rel);
  tried.push(p);
  try { raw = JSON.parse(readFileSync(p, "utf8")); break; } catch { /* try the next */ }
}
if (!raw) throw new Error("graph.json not found; looked in:\n  " + tried.join("\n  "));

export const GRAPH = raw;
export const NODES = raw.nodes;
export const CLIP_MS = Math.round((raw.clipSeconds ?? 2.5) * 1000);

/** node id -> Set of node ids reachable in one hop */
export const NEIGHBOURS = (() => {
  const m = {};
  for (const id of Object.keys(raw.nodes)) m[id] = new Set();
  for (const [u, v] of raw.edges) { m[u].add(v); m[v].add(u); }
  return m;
})();

export const MEDITATION_NODES = new Set(
  Object.entries(raw.nodes).filter(([, n]) => n.meditation).map(([id]) => id)
);

export const START_NODE = Object.keys(raw.nodes)[0];

export function isNode(id) {
  return Object.prototype.hasOwnProperty.call(raw.nodes, id);
}

export function isEdge(from, to) {
  return isNode(from) && isNode(to) && NEIGHBOURS[from].has(to);
}
