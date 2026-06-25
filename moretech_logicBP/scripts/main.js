import { world, system } from "@minecraft/server";

// ============================================================================
// NODE TYPE REGISTRY
// ============================================================================
const NODE_TYPES = {
  "bluestone:dust": "wire",
  "bluestone:redstone_connector": "connector",
  "bluestone:bluestone_torch": "source",
  "bluestone:energy_engine": "engine",          // coal-powered bluestone source
  "bluestone:lamp": "sink",
  "bluestone:and_gate": "and",
  "bluestone:or_gate": "or",
  "bluestone:not_gate": "not",
  "bluestone:xor_gate": "xor",
  "bluestone:nand_gate": "nand",
  "bluestone:nor_gate": "nor",
  "bluestone:xnor_gate": "xnor",
  "bluestone:diode": "diode",
  "bluestone:splitter": "splitter",
  "bluestone:compressor": "sink",
  "bluestone:extractor": "sink",
  "bluestone:assembler": "sink",
  "bluestone:conveyor": "sink",
  "bluestone:vertical_hopper": "sink",
  // Greenstone wireless system
  "bluestone:greenstone_energy_engine": "gengine",  // coal-powered greenstone source
  "bluestone:greenstone_transmitter": "gtransmitter",
  "bluestone:greenstone_receiver": "sink",          // emits bluestone power when wireless signal received
  "bluestone:greenstone_connector": "gconnector"    // bidirectional bluestone<->greenstone bridge
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

// Engine fuel config: how much charge (ticks) each coal item adds.
// Greenstone burns faster, so each coal adds less runtime.
const ENGINE_FUEL = {
  "bluestone:energy_engine": { charge_per_coal: 600, drain_per_tick: 1 },
  "bluestone:greenstone_energy_engine": { charge_per_coal: 300, drain_per_tick: 2 }
};
const FUEL_ITEMS = new Set(["minecraft:coal", "minecraft:charcoal"]);
const MAX_RECEIVERS_PER_TX = 5;
const LINKING_TOOL = "bluestone:linking_tool";

// ============================================================================
// HELPERS — geometry / keys / neighbors
// ============================================================================
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

// ============================================================================
// CONTAINER HELPERS (used by machines, pipelines, and engines)
// ============================================================================
function getContainerFromBlock(block) {
  try {
    if (!block || !block.getComponent) return null;
    const comp = block.getComponent("minecraft:container") || block.getComponent("minecraft:inventory") || block.getComponent("container");
    if (!comp) return null;
    return comp.container ?? comp;
  } catch { return null; }
}

function normalizeStack(raw) {
  if (!raw) return null;
  let id = raw?.id ?? raw?.item ?? raw?.typeId ?? raw?.__identifier ?? null;
  let count = raw?.count ?? raw?.amount ?? raw?.quantity ?? raw?.stackSize ?? 0;
  if (typeof count !== 'number') count = Number(count) || 0;
  if (typeof id === 'object') id = id?.id ?? id?.typeId ?? String(id);
  if (!id) return null;
  return { id: String(id), count };
}

function containerGet(container, slot) {
  try {
    if (!container) return null;
    if (typeof container.getItem === 'function') return normalizeStack(container.getItem(slot));
    if (typeof container.getItemStack === 'function') return normalizeStack(container.getItemStack(slot));
    if (typeof container.get === 'function') return normalizeStack(container.get(slot));
    return null;
  } catch { return null; }
}

function containerSet(container, slot, id, count) {
  try {
    if (!container) return false;
    const attempts = [ { item: id, count }, { id: id, count }, { typeId: id, amount: count } ];
    for (const it of attempts) {
      try {
        if (typeof container.setItem === 'function') { container.setItem(slot, it); return true; }
        if (typeof container.setItemStack === 'function') { container.setItemStack(slot, it); return true; }
        if (typeof container.set === 'function') { container.set(slot, it); return true; }
      } catch (e) {}
    }
    try {
      if (typeof container.setItem === 'function') { container.setItem(slot, null); return true; }
      if (typeof container.set === 'function') { container.set(slot, null); return true; }
    } catch (e) {}
    return false;
  } catch { return false; }
}

function containerCountItem(container, id, size) {
  let total = 0;
  for (let s = 0; s < size; s++) {
    const st = containerGet(container, s);
    if (st && st.id === id) total += st.count;
  }
  return total;
}

function containerAvailableSpaceFor(container, id, size) {
  const maxStack = 64;
  let space = 0;
  for (let s = 0; s < size; s++) {
    const st = containerGet(container, s);
    if (!st) space += maxStack;
    else if (st.id === id) space += Math.max(0, maxStack - st.count);
  }
  return space;
}

function containerAdd(container, id, amount, size) {
  let remaining = amount;
  const maxStack = 64;
  for (let s = 0; s < size && remaining > 0; s++) {
    const st = containerGet(container, s);
    if (st && st.id === id && st.count < maxStack) {
      const take = Math.min(maxStack - st.count, remaining);
      containerSet(container, s, id, st.count + take);
      remaining -= take;
    }
  }
  for (let s = 0; s < size && remaining > 0; s++) {
    const st = containerGet(container, s);
    if (!st || st.count <= 0) {
      const put = Math.min(maxStack, remaining);
      containerSet(container, s, id, put);
      remaining -= put;
    }
  }
  return remaining;
}

function containerConsume(container, id, amount, size) {
  let remaining = amount;
  for (let s = 0; s < size && remaining > 0; s++) {
    const st = containerGet(container, s);
    if (st && st.id === id && st.count > 0) {
      const take = Math.min(st.count, remaining);
      containerSet(container, s, id, st.count - take);
      remaining -= take;
    }
  }
  return remaining === 0;
}

// ============================================================================
// POWER EVALUATION (bluestone network)
// ============================================================================

// Counts neighbors powered by the bluestone network only (no vanilla redstone).
// Sources only power wires, so ignore powered source neighbors for non-wire targets.
function bluestoneActiveNeighborCount(block, powerMap) {
  let active = 0;
  const targetType = getNodeType(block);
  for (const neighbor of getNeighbors(block)) {
    const nbKey = blockKey(neighbor);
    if (!powerMap.get(nbKey)) continue;
    const neighborType = getNodeType(neighbor);
    if (neighborType === 'source' && targetType !== 'wire') continue;
    // Engines (bluestone) only power wires too
    if (neighborType === 'engine' && targetType !== 'wire') continue;
    active++;
  }
  return active;
}

// Counts neighbors powered by bluestone OR vanilla redstone (connector only).
function activeNeighborCount(block, powerMap) {
  let active = 0;
  const targetType = getNodeType(block);
  for (const neighbor of getNeighbors(block)) {
    const nbKey = blockKey(neighbor);
    const nbPowered = !!powerMap.get(nbKey);
    const vanilla = canReadVanillaRedstone(neighbor);
    if (nbPowered) {
      const neighborType = getNodeType(neighbor);
      if (!(neighborType === 'source' && targetType !== 'wire') && !(neighborType === 'engine' && targetType !== 'wire')) {
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

    // Coal-powered engines act as sources only while they have charge
    // (charge handled in processEngines; here we read bluestone:powered as
    //  the engine's own on/off visual state, set by the fuel loop).
    case "engine":
      return engineHasCharge(block);

    case "wire":
    case "sink":
    case "diode":
    case "splitter":
      return bluestoneActiveNeighborCount(block, previousPower) > 0;

    case "connector":
      return activeNeighborCount(block, previousPower) > 0 ||
             getNeighbors(block).some(canReadVanillaRedstone);

    // Greenstone-Bluestone bridge: powered on the bluestone side if the
    // greenstone side OR a bluestone neighbor is active.
    case "gconnector":
      return bluestoneActiveNeighborCount(block, previousPower) > 0 ||
             getGreenstoneState(block);

    // Greenstone transmitter: powered (bluestone side) by adjacent bluestone
    // wires. Its bluestone:powered state is what gets broadcast wirelessly.
    case "gtransmitter":
      return bluestoneActiveNeighborCount(block, previousPower) > 0;

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

// ============================================================================
// ENGINE FUEL SYSTEM
// ============================================================================
// Charge is persisted as a world dynamic property keyed by block location,
// so engines keep their stored energy across reloads.
function engineChargeKey(block) {
  return `mt:charge:${blockKey(block)}`;
}

function getEngineCharge(block) {
  try {
    const v = world.getDynamicProperty(engineChargeKey(block));
    return typeof v === 'number' ? v : 0;
  } catch { return 0; }
}

function setEngineCharge(block, value) {
  try {
    world.setDynamicProperty(engineChargeKey(block), Math.max(0, Math.floor(value)));
  } catch {}
}

function engineHasCharge(block) {
  return getEngineCharge(block) > 0;
}

// Burn fuel and drain charge for every engine in range. Returns nothing;
// side effect is updating charge dynamic properties. An engine "is a source"
// for the bluestone sim only while charge > 0 (see evaluateNode "engine").
function processEngines(nodes) {
  for (const node of nodes.values()) {
    try {
      const block = node.block;
      const id = block?.typeId ?? '';
      const cfg = ENGINE_FUEL[id];
      if (!cfg) continue;

      let charge = getEngineCharge(block);

      // Refuel: pull one fuel item from the engine's container if charge is
      // running low. This keeps engines topped up automatically.
      if (charge < cfg.charge_per_coal) {
        const cont = getContainerFromBlock(block);
        if (cont) {
          for (let s = 0; s < 9; s++) {
            const st = containerGet(cont, s);
            if (st && FUEL_ITEMS.has(st.id) && st.count > 0) {
              containerConsume(cont, st.id, 1, 9);
              charge += cfg.charge_per_coal;
              break;
            }
          }
        }
      }

      // Drain: engines always drain while placed (even with nothing attached),
      // representing idle consumption. Greenstone drains faster (drain_per_tick).
      if (charge > 0) {
        charge -= cfg.drain_per_tick;
      }
      setEngineCharge(block, charge);

      // Update the engine's own bluestone:powered visual state.
      const on = charge > 0;
      try {
        const cur = block.permutation.getState("bluestone:powered");
        if (cur !== on) block.setPermutation(block.permutation.withState("bluestone:powered", on));
      } catch {}

      // Greenstone engine also sets greenstone:powered so transmitters can read it.
      if (id === "bluestone:greenstone_energy_engine") {
        try {
          const cur = block.permutation.getState("greenstone:powered");
          if (cur !== on) block.setPermutation(block.permutation.withState("greenstone:powered", on));
        } catch {}
      }
    } catch (e) {}
  }
}

// ============================================================================
// GREENSTONE WIRELESS SYSTEM
// ============================================================================

// --- Greenstone state read/write (separate from bluestone:powered) ---
function getGreenstoneState(block) {
  try {
    return block.permutation.getState("greenstone:powered") === true;
  } catch { return false; }
}

function setGreenstoneState(block, powered) {
  try {
    const cur = block.permutation.getState("greenstone:powered");
    if (cur === powered) return;
    block.setPermutation(block.permutation.withState("greenstone:powered", powered));
  } catch {}
}

// --- Pairing storage ---
// Transmitter stores a ";"-separated list of receiver blockKeys.
// Receiver stores its transmitter blockKey.
function getPairedReceivers(block) {
  try {
    const v = world.getDynamicProperty(`mt:tx:${blockKey(block)}`);
    if (typeof v === 'string' && v.length > 0) return v.split(';').filter(Boolean);
  } catch {}
  return [];
}

function setPairedReceivers(block, list) {
  try { world.setDynamicProperty(`mt:tx:${blockKey(block)}`, list.join(';')); } catch {}
}

function getPairedTransmitter(block) {
  try {
    const v = world.getDynamicProperty(`mt:rx:${blockKey(block)}`);
    return typeof v === 'string' ? v : '';
  } catch { return ''; }
}

function setPairedTransmitter(block, txKey) {
  try { world.setDynamicProperty(`mt:rx:${blockKey(block)}`, txKey ?? ''); } catch {}
}

// Parse a blockKey ("dim:x,y,z") back into a fetchable block.
function parseBlockKey(keyStr) {
  try {
    const [dimId, coords] = keyStr.split(':');
    const [x, y, z] = coords.split(',').map(Number);
    const dim = world.getDimension(dimId);
    return dim.getBlock({ x: Math.floor(x), y: Math.floor(y), z: Math.floor(z) });
  } catch { return null; }
}

// Does a greenstone energy engine (or the greenstone side of a connector)
// feed THIS block? Transmitters activate when an adjacent greenstone engine
// is running OR when they receive bluestone power via dust.
function transmitterIsActive(block) {
  // Primary activation: bluestone dust next to the transmitter is powered.
  try {
    if (block.permutation.getState("bluestone:powered") === true) return true;
  } catch {}
  // Also activate if an adjacent greenstone engine is running.
  for (const nb of getNeighbors(block)) {
    if (nb?.typeId === "bluestone:greenstone_energy_engine" && getGreenstoneState(nb)) return true;
  }
  return false;
}

// Run one wireless propagation pass across all greenstone blocks in range.
function simulateGreenstone(nodes) {
  // 1. Gather transmitters and receivers seen this cycle.
  const transmitters = [];
  const receivers = [];
  for (const node of nodes.values()) {
    const t = node.nodeType;
    if (t === 'gtransmitter') transmitters.push(node.block);
    else if (t === 'sink' && node.block?.typeId === 'bluestone:greenstone_receiver') receivers.push(node.block);
  }

  // 2. For each transmitter, set the greenstone:powered state to match its
  //    activation, then propagate to all paired receivers.
  for (const tx of transmitters) {
    const active = transmitterIsActive(tx);
    setGreenstoneState(tx, active);

    const paired = getPairedReceivers(tx);
    for (const rxKey of paired) {
      const rx = parseBlockKey(rxKey);
      if (!rx) continue;
      // Receiver emits bluestone power (so it can drive bluestone dust/lamps)
      setPoweredState(rx, active);
      setGreenstoneState(rx, active);
    }
  }

  // 3. Greenstone connector: bridge between the two networks.
  //    If greenstone side is powered, push bluestone power to the connector
  //    (and vice versa) so it can be read by adjacent dust.
  for (const node of nodes.values()) {
    if (node.nodeType !== 'gconnector') continue;
    const block = node.block;
    // greenstone side active -> it should appear powered to bluestone neighbors
    const gActive = getGreenstoneState(block);
    if (gActive) setPoweredState(block, true);
  }
}

// ============================================================================
// NODE COLLECTION
// ============================================================================
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

// ============================================================================
// MACHINES (assembler / compressor / extractor)
// ============================================================================
function processMachines(nodes) {
  const ASSEMBLER_RECIPES = [
    { result: 'bluestone:and_gate', count: 1, ingredients: ['minecraft:redstone','minecraft:redstone','minecraft:stone'] },
    { result: 'bluestone:or_gate', count: 1, ingredients: ['minecraft:redstone','minecraft:redstone','minecraft:stick'] },
    { result: 'bluestone:not_gate', count: 1, ingredients: ['minecraft:redstone','minecraft:stone'] },
    { result: 'bluestone:xor_gate', count: 1, ingredients: ['minecraft:redstone','minecraft:stone','minecraft:stick'] },
    { result: 'bluestone:nand_gate', count: 1, ingredients: ['minecraft:redstone','minecraft:stone','minecraft:iron_ingot'] },
    { result: 'bluestone:nor_gate', count: 1, ingredients: ['minecraft:redstone','minecraft:stone','minecraft:gold_ingot'] },
    { result: 'bluestone:xnor_gate', count: 1, ingredients: ['minecraft:redstone','minecraft:stone','minecraft:diamond'] },
    { result: 'bluestone:diode', count: 1, ingredients: ['minecraft:redstone','minecraft:stone'] },
    { result: 'bluestone:splitter', count: 1, ingredients: ['minecraft:redstone','minecraft:stone','minecraft:stick'] },
    { result: 'bluestone:redstone_connector', count: 1, ingredients: ['minecraft:redstone','minecraft:stone','minecraft:stick'] },
    { result: 'bluestone:energy_engine', count: 1, ingredients: ['minecraft:coal','minecraft:iron_ingot','bluestone:dust'] },
    { result: 'bluestone:lamp', count: 1, ingredients: ['bluestone:dust','minecraft:glowstone'] }
  ];

  const COMPRESSOR_RECIPE = { result: 'bluestone:compact_block', count: 1, ingredients: ['bluestone:dust','bluestone:dust','bluestone:dust','bluestone:dust'] };
  const EXTRACTOR_RECIPE = { result: 'bluestone:dust', count: 4, ingredients: ['bluestone:compact_block'] };

  const MACHINE_RECIPES = { assembler: ASSEMBLER_RECIPES, compressor: [COMPRESSOR_RECIPE], extractor: [EXTRACTOR_RECIPE] };
  const CONTAINER_SIZES = { 'bluestone:compressor': 9, 'bluestone:extractor': 9, 'bluestone:assembler': 9, 'bluestone:conveyor': 27, 'bluestone:vertical_hopper': 27 };

  function matchRecipe(container, recipe, size) {
    const required = {};
    for (const ing of recipe.ingredients) required[ing] = (required[ing] ?? 0) + 1;
    for (const k of Object.keys(required)) {
      if (containerCountItem(container, k, size) < required[k]) return false;
    }
    if (containerAvailableSpaceFor(container, recipe.result, size) < recipe.count) return false;
    return true;
  }

  for (const node of nodes.values()) {
    try {
      const block = node.block;
      const id = block?.typeId ?? '';
      const machineKey = id.replace('bluestone:', '');
      if (!MACHINE_RECIPES[machineKey]) continue;
      const powered = !!(block.permutation && block.permutation.getState && block.permutation.getState('bluestone:powered') === true);
      if (!powered) continue;
      const cont = getContainerFromBlock(block);
      const size = CONTAINER_SIZES[id] ?? 9;
      if (!cont) continue;
      const recipes = MACHINE_RECIPES[machineKey];
      for (const recipe of recipes) {
        if (matchRecipe(cont, recipe, size)) {
          const required = {};
          for (const ing of recipe.ingredients) required[ing] = (required[ing] ?? 0) + 1;
          let failed = false;
          for (const k of Object.keys(required)) {
            if (!containerConsume(cont, k, required[k], size)) { failed = true; break; }
          }
          if (failed) continue;
          const remaining = containerAdd(cont, recipe.result, recipe.count, size);
          if (remaining > 0) {
            try { block.dimension.runCommand(`give @a ${recipe.result} ${remaining}`); } catch (e) {}
          }
          break;
        }
      }
    } catch (e) {}
  }
}

// ============================================================================
// PIPELINES (conveyor / vertical hopper)
// ============================================================================
function handlePipelines(nodes) {
  const CONTAINER_SIZES = { 'bluestone:compressor': 9, 'bluestone:extractor': 9, 'bluestone:assembler': 9, 'bluestone:conveyor': 27, 'bluestone:vertical_hopper': 27 };
  const facingOffsets = { north: { x: 0, z: -1 }, south: { x: 0, z: 1 }, east: { x: 1, z: 0 }, west: { x: -1, z: 0 } };
  for (const node of nodes.values()) {
    try {
      const block = node.block;
      const id = block?.typeId ?? '';
      if (id === 'bluestone:conveyor') {
        try {
          const powered = !!(block.permutation && block.permutation.getState && block.permutation.getState('bluestone:powered') === true);
          if (!powered) continue;
          const facing = (block.permutation && block.permutation.getState) ? block.permutation.getState('bluestone:facing') : 'north';
          const off = facingOffsets[facing] ?? facingOffsets.north;
          const srcCont = getContainerFromBlock(block);
          if (!srcCont) continue;
          const srcSize = CONTAINER_SIZES[id] ?? 27;
          const destPos = { x: Math.floor(block.location.x) + off.x, y: Math.floor(block.location.y), z: Math.floor(block.location.z) + off.z };
          const destBlock = block.dimension.getBlock(destPos);
          const destCont = getContainerFromBlock(destBlock);
          const destSize = CONTAINER_SIZES[destBlock?.typeId] ?? 27;
          if (!destCont) continue;
          for (let s = 0; s < srcSize; s++) {
            const st = containerGet(srcCont, s);
            if (st && st.count > 0) {
              const moved = st.count;
              const remainingAfter = containerAdd(destCont, st.id, moved, destSize);
              const actuallyMoved = moved - remainingAfter;
              if (actuallyMoved > 0) containerConsume(srcCont, st.id, actuallyMoved, srcSize);
              break;
            }
          }
        } catch (e) {}
      } else if (id === 'bluestone:vertical_hopper') {
        try {
          const powered = !!(block.permutation && block.permutation.getState && block.permutation.getState('bluestone:powered') === true);
          if (!powered) continue;
          const myCont = getContainerFromBlock(block);
          if (!myCont) continue;
          const mySize = CONTAINER_SIZES[id] ?? 27;
          const aboveBlock = block.dimension.getBlock({ x: Math.floor(block.location.x), y: Math.floor(block.location.y) + 1, z: Math.floor(block.location.z) });
          const aboveCont = getContainerFromBlock(aboveBlock);
          const aboveSize = CONTAINER_SIZES[aboveBlock?.typeId] ?? 27;
          if (aboveCont) {
            for (let s = 0; s < aboveSize; s++) {
              const st = containerGet(aboveCont, s);
              if (st && st.count > 0) {
                const moved = st.count;
                const remainingAfter = containerAdd(myCont, st.id, moved, mySize);
                const actuallyMoved = moved - remainingAfter;
                if (actuallyMoved > 0) containerConsume(aboveCont, st.id, actuallyMoved, aboveSize);
                break;
              }
            }
          }
          const belowBlock = block.dimension.getBlock({ x: Math.floor(block.location.x), y: Math.floor(block.location.y) - 1, z: Math.floor(block.location.z) });
          const belowCont = getContainerFromBlock(belowBlock);
          const belowSize = CONTAINER_SIZES[belowBlock?.typeId] ?? 27;
          if (belowCont) {
            for (let s = 0; s < mySize; s++) {
              const st = containerGet(myCont, s);
              if (st && st.count > 0) {
                const moved = st.count;
                const remainingAfter = containerAdd(belowCont, st.id, moved, belowSize);
                const actuallyMoved = moved - remainingAfter;
                if (actuallyMoved > 0) containerConsume(myCont, st.id, actuallyMoved, mySize);
                break;
              }
            }
          }
        } catch (e) {}
      }
    } catch (e) {}
  }
}

// ============================================================================
// LINKING TOOL — pairing transmitters and receivers
// ============================================================================
// Flow:
//   1. Hold linking tool, right-click a transmitter  -> start pairing mode
//   2. Right-click up to 5 receivers                 -> link each to the TX
//   3. Sneak + right-click transmitter               -> clear all pairings
// Pairing source is remembered per-player via a dynamic property.
world.afterEvents.playerInteractWithBlock.subscribe((event) => {
  try {
    const player = event.player;
    const block = event.block;
    if (!player || !block) return;

    // Only react when holding the linking tool.
    const equ = player.getComponent?.("minecraft:equippable") || player.getComponent?.("equippable");
    const hand = equ?.getEquipment?.("Mainhand");
    if (!hand || hand.typeId !== LINKING_TOOL) return;

    const id = block?.typeId ?? '';
    const isSneaking = !!(player.isSneaking);

    // --- Clear pairings (sneak-click transmitter) ---
    if (isSneaking && id === 'bluestone:greenstone_transmitter') {
      setPairedReceivers(block, []);
      // also clear back-references from old receivers
      player.sendMessage("§aCleared all pairings from this transmitter.");
      try { player.playSound("random.orb"); } catch {}
      event.cancel = true;
      return;
    }

    // --- Start pairing mode (click transmitter) ---
    if (id === 'bluestone:greenstone_transmitter') {
      try { player.setDynamicProperty("mt:pairing_tx", blockKey(block)); } catch {}
      const count = getPairedReceivers(block).length;
      player.sendMessage(`§aPairing mode started for transmitter. Right-click receivers to link (${count}/${MAX_RECEIVERS_PER_TX}).`);
      try { player.playSound("random.click"); } catch {}
      event.cancel = true;
      return;
    }

    // --- Link receiver to the selected transmitter ---
    if (id === 'bluestone:greenstone_receiver') {
      let txKey = '';
      try { txKey = player.getDynamicProperty("mt:pairing_tx") ?? ''; } catch {}
      if (!txKey) {
        player.sendMessage("§cRight-click a transmitter first to start pairing.");
        return;
      }
      const tx = parseBlockKey(txKey);
      if (!tx || tx.typeId !== 'bluestone:greenstone_transmitter') {
        player.sendMessage("§cThe selected transmitter is gone. Start again.");
        try { player.setDynamicProperty("mt:pairing_tx", ''); } catch {}
        return;
      }

      const paired = getPairedReceivers(tx);
      const rxKey = blockKey(block);
      if (paired.includes(rxKey)) {
        player.sendMessage("§eThis receiver is already linked to the transmitter.");
        return;
      }
      if (paired.length >= MAX_RECEIVERS_PER_TX) {
        player.sendMessage(`§cTransmitter is full (${MAX_RECEIVERS_PER_TX}/${MAX_RECEIVERS_PER_TX} receivers).`);
        return;
      }
      paired.push(rxKey);
      setPairedReceivers(tx, paired);
      setPairedTransmitter(block, txKey);
      player.sendMessage(`§aReceiver linked! (${paired.length}/${MAX_RECEIVERS_PER_TX})`);
      try { player.playSound("random.levelup"); } catch {}
      event.cancel = true;
      return;
    }
  } catch (e) {
    try { console.warn(`[Moretech API] linking tool error: ${e}`); } catch {}
  }
});

// ============================================================================
// EVENT SUBSCRIPTIONS
// ============================================================================
world.afterEvents.scriptEventReceive.subscribe((event) => {
  if (event.id !== "bluestone:register") return;
  const [identifier, kind] = String(event.message ?? "").split(/\s+/);
  registerNode(identifier, kind);
});

// Main simulation loop
system.runInterval(() => {
  try {
    const nodes = collectNodesAroundPlayers();
    processEngines(nodes);
    simulate(nodes);
    simulateGreenstone(nodes);
    try { processMachines(nodes); } catch (e) {}
    try { handlePipelines(nodes); } catch (e) {}
  } catch (error) {
    console.warn(`[Moretech API] ${error}`);
  }
}, 5);

console.warn("[Moretech API] Loaded. Register addon nodes with /scriptevent bluestone:register <identifier> <kind>.");
