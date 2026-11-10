// Edits behind the Hyderabad Plywood tab. A brand is "on" at a store when the
// store has a node in that brand's network; switching it off removes the node.
// Pure and immutable.

export const isBrandOnAt = (cfg, brand, ds) => !!cfg?.brands?.[brand]?.nodes?.[ds];

export function setBrandOnAt(cfg, brand, ds, on) {
  const b = cfg?.brands?.[brand] || {};
  const nodes = { ...(b.nodes || {}) };
  if (on) nodes[ds] = nodes[ds] || { covers: [ds] };
  else delete nodes[ds];
  return { ...cfg, brands: { ...(cfg?.brands || {}), [brand]: { ...b, nodes } } };
}

export const capacityOf = (nc, ds, kind) => nc?.[ds]?.[kind]?.capacity || 0;

export function setCapacity(nc, ds, kind, value) {
  const node = nc?.[ds] || {};
  return { ...nc, [ds]: { ...node, [kind]: { ...(node[kind] || {}), capacity: value } } };
}
