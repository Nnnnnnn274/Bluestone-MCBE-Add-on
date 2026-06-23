import { world, system } from "@minecraft/server";

const NODE_TYPES = {
  "bluestone:dust": "wire",
  "bluestone:redstone_connector": "connector",
  "bluestone:bluestone_torch": "source",
  "bluestone:lamp": "sink",
  "bluestone:and_gate": "and",
  "bluestone:or_gate": "or",
  "bluestone:not_gate": "not",
  "bluestone:xor_gate": "xor",
  "bluestone:nand_gate": "nand",
  "bluestone:nor_gate": "nor",
  "bluestone:xnor_gate": "xnor",
  "bluestone:diode": "diode",
  "bluestone:splitter": "splitter"
};

const REDSTONE_INPUTS = new Set([
  "minecraft:redstone_block",
  "minecraft:redstone_torch",
  "minecraft:unlit_redstone_torch",
  "minecraft:redstone_wire",
  "minecraft:lever",
  "minecraft:stone_button",
  "minecraft:oak_button",
  "minecraft:repeater",
  "minecraft:comparator"
]);

const SIDES = [
  { x: 1, y: 0, z: 0 },
  { x: -1, y: 0, z: 0 },
  { x: 0, y: 0, z: 1 },
  { x: 0, y: 0, z: -1 },
  { x: 0, y: 1, z: 0 },
  { x: 0, y: -1, z: 0 }
];

function key(location) {
  return `${location.x},${location.y},${location.z}`;
}

function blockKey(block) {
  return `${block.dimension.id}:${key(block.location)}`;
}

function offset(location, delta) {
  return { x: location.x + delta.x, y: location.y + delta.y, z: location.z + delta.z };
}

function getNodeType(block) {
  return NODE_TYPES[block?.typeId] ?? undefined;
}

function getNeighbors(block) {
  const result = [];
  for (const side of SIDES) {
    const neighbor = block.dimension.getBlock(offset(block.location, side));
    if (neighbor) result.push(neighbor);
  }
  return result;
}

function canReadVanillaRedstone(block) {
  return REDSTONE_INPUTS.has(block?.typeId);
}

// Counts neighbors powered by the bluestone network only (no vanilla redstone).
// Used by wire (dust), sinks, gates — keeping bluestone isolated from redstone.
// Sources (torch/lantern) should only power wires, so ignore powered source neighbors
// when evaluating non-wire targets.
function bluestoneActiveNeighborCount(block, powerMap) {
  let active = 0;
  const targetType = getNodeType(block);
  for (const neighbor of getNeighbors(block)) {
    const nbKey = blockKey(neighbor);
    if (!powerMap.get(nbKey)) continue;
    const neighborType = getNodeType(neighbor);
    // If neighbor is a source and the target is not a wire, it should not supply power.
    if (neighborType === 'source' && targetType !== 'wire') continue;
    active++;
  }
  return active;
}

// Counts neighbors powered by bluestone OR vanilla redstone.
// Used only by the connector block, which is the explicit redstone bridge.
// Similarly, powered sources should not count toward non-wire targets.
function activeNeighborCount(block, powerMap) {
  let active = 0;
  const targetType = getNodeType(block);
  for (const neighbor of getNeighbors(block)) {
    const nbKey = blockKey(neighbor);
    const nbPowered = !!powerMap.get(nbKey);
    const vanilla = canReadVanillaRedstone(neighbor);
    if (nbPowered) {
      const neighborType = getNodeType(neighbor);
      if (!(neighborType === 'source' && targetType !== 'wire')) {
        active++;
        continue;
      }
    }
    if (vanilla) active++;
  }
  return active;
}

// Compute which horizontal neighbors are connectable (used for wire visuals)
function computeConnections(block) {
  const conns = { north: false, south: false, east: false, west: false };
  try {
    const x = Math.floor(block.location.x);
    const y = Math.floor(block.location.y);
    const z = Math.floor(block.location.z);
    const dim = block.dimension;
    const checks = [
      { dx: 0, dz: -1, dir: 'north' },
      { dx: 0, dz: 1, dir: 'south' },
      { dx: 1, dz: 0, dir: 'east' },
      { dx: -1, dz: 0, dir: 'west' }
    ];
    for (const c of checks) {
      const nb = dim.getBlock({ x: x + c.dx, y, z: z + c.dz });
      if (!nb) continue;
      if (getNodeType(nb)) conns[c.dir] = true;
    }
  } catch {}
  return conns;
}

function setConnectionStates(block, conns) {
  try {
    let perm = block.permutation;
    perm = perm.withState('bluestone:connect_north', !!conns.north);
    perm = perm.withState('bluestone:connect_south', !!conns.south);
    perm = perm.withState('bluestone:connect_east', !!conns.east);
    perm = perm.withState('bluestone:connect_west', !!conns.west);
    block.setPermutation(perm);
  } catch {}
}

function evaluateNode(block, nodeType, previousPower) {
  switch (nodeType) {
    case "source":
      return true;

    // Dust (wire) and other bluestone-only components:
    // they only receive power from the bluestone network,
    // so they will NOT be activated by vanilla redstone.
    case "wire":
    case "sink":
    case "diode":
    case "splitter":
      return bluestoneActiveNeighborCount(block, previousPower) > 0;

    // Connector is the explicit bridge — it reads vanilla redstone too.
    case "connector":
      return activeNeighborCount(block, previousPower) > 0 ||
             getNeighbors(block).some(canReadVanillaRedstone);

    case "and":
      return bluestoneActiveNeighborCount(block, previousPower) >= 2;
    case "or":
      return bluestoneActiveNeighborCount(block, previousPower) >= 1;
    case "not":
      return bluestoneActiveNeighborCount(block, previousPower) === 0;
    case "xor":
      return bluestoneActiveNeighborCount(block, previousPower) % 2 === 1;
    case "nand":
      return bluestoneActiveNeighborCount(block, previousPower) < 2;
    case "nor":
      return bluestoneActiveNeighborCount(block, previousPower) === 0;
    case "xnor":
      return bluestoneActiveNeighborCount(block, previousPower) % 2 === 0;
    default:
      return false;
  }
}

function setPoweredState(block, powered) {
  try {
    const current = block.permutation.getState("bluestone:powered");
    if (current === powered) return;
    block.setPermutation(block.permutation.withState("bluestone:powered", powered));
  } catch {
    // Third-party blocks can use the API conventions without implementing this visual state.
  }
}

function collectNodesAroundPlayers(radius = 20) {
  const nodes = new Map();
  for (const player of world.getPlayers()) {
    const dimension = player.dimension;
    const center = player.location;
    const minX = Math.floor(center.x - radius);
    const maxX = Math.floor(center.x + radius);
    const minY = Math.max(-64, Math.floor(center.y - 8));
    const maxY = Math.min(320, Math.floor(center.y + 8));
    const minZ = Math.floor(center.z - radius);
    const maxZ = Math.floor(center.z + radius);
    for (let x = minX; x <= maxX; x++) {
      for (let y = minY; y <= maxY; y++) {
        for (let z = minZ; z <= maxZ; z++) {
          const block = dimension.getBlock({ x, y, z });
          const nodeType = getNodeType(block);
          if (nodeType) nodes.set(blockKey(block), { block, nodeType });
        }
      }
    }
  }
  return nodes;
}

function simulate(nodes) {
  let power = new Map();
  for (const node of nodes.values()) {
    try {
      power.set(blockKey(node.block), node.block.permutation.getState("bluestone:powered") === true);
    } catch {
      power.set(blockKey(node.block), false);
    }
  }

  for (let pass = 0; pass < 8; pass++) {
    const next = new Map(power);
    for (const node of nodes.values()) {
      next.set(blockKey(node.block), evaluateNode(node.block, node.nodeType, power));
    }
    power = next;
  }

  for (const node of nodes.values()) {
    try {
      if (node.nodeType === 'wire') {
        const conns = computeConnections(node.block);
        setConnectionStates(node.block, conns);
      }
    } catch {}
    setPoweredState(node.block, power.get(blockKey(node.block)) === true);
  }
}

function registerNode(identifier, kind) {
  if (!identifier || !kind) return;
  NODE_TYPES[identifier] = kind;
}

world.afterEvents.scriptEventReceive.subscribe((event) => {
  if (event.id !== "bluestone:register") return;
  const [identifier, kind] = String(event.message ?? "").split(/\s+/);
  registerNode(identifier, kind);
});

system.runInterval(() => {
  try {
    simulate(collectNodesAroundPlayers());
  } catch (error) {
    console.warn(`[Bluestone API] ${error}`);
  }
}, 5);

console.warn("[Bluestone API] Loaded. Register addon nodes with /scriptevent bluestone:register <identifier> <kind>.");
