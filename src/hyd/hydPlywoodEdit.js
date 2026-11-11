// Edits behind the Hyderabad Plywood tab. A brand is "on" at a store when the
// store has a node in that brand's network (read-only: no UI switches it).
// Pure and immutable.

export const isBrandOnAt = (cfg, brand, ds) => !!cfg?.brands?.[brand]?.nodes?.[ds];

export const capacityOf = (nc, ds, kind) => nc?.[ds]?.[kind]?.capacity || 0;

export function setCapacity(nc, ds, kind, value) {
  const node = nc?.[ds] || {};
  return { ...nc, [ds]: { ...node, [kind]: { ...(node[kind] || {}), capacity: value } } };
}
