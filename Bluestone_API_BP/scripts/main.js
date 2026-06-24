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
  "bluestone:splitter": "splitter",
  "bluestone:compressor": "sink",
  "bluestone:extractor": "sink",
  "bluestone:assembler": "sink",
  "bluestone:conveyor": "sink",
  "bluestone:vertical_hopper": "sink"
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

function processMachines(nodes) {
  // Helpers for native container operations
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
      // try clearing slot
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
    // merge into existing
    for (let s = 0; s < size && remaining > 0; s++) {
      const st = containerGet(container, s);
      if (st && st.id === id && st.count < maxStack) {
        const take = Math.min(maxStack - st.count, remaining);
        containerSet(container, s, id, st.count + take);
        remaining -= take;
      }
    }
    // fill empty
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

  // Machine recipes
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
    { result: 'bluestone:bluestone_torch', count: 1, ingredients: ['bluestone:dust','minecraft:stick'] },
    { result: 'bluestone:lamp', count: 1, ingredients: ['bluestone:dust','minecraft:glowstone'] }
  ];

  const COMPRESSOR_RECIPE = { result: 'bluestone:compact_block', count: 1, ingredients: ['bluestone:dust','bluestone:dust','bluestone:dust','bluestone:dust'] };
  const EXTRACTOR_RECIPE = { result: 'bluestone:dust', count: 4, ingredients: ['bluestone:compact_block'] };

  const MACHINE_RECIPES = { assembler: ASSEMBLER_RECIPES, compressor: [COMPRESSOR_RECIPE], extractor: [EXTRACTOR_RECIPE] };
  const CONTAINER_SIZES = { 'bluestone:compressor': 9, 'bluestone:extractor': 9, 'bluestone:assembler': 9, 'bluestone:conveyor': 27, 'bluestone:vertical_hopper': 27 };

  function matchRecipe(container, recipe, size) {
    const required = {};
    for (const ing of recipe.ingredients) required[ing] = (required[ing] ?? 0) + 1;
    for (const key of Object.keys(required)) {
      const have = containerCountItem(container, key, size);
      if (have < required[key]) return false;
    }
    const space = containerAvailableSpaceFor(container, recipe.result, size);
    if (space < recipe.count) return false;
    return true;
  }

  for (const node of nodes.values()) {
    try {
      const block = node.block;
      const id = block?.typeId ?? (block?.type?.id ?? '');
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
          // consume ingredients
          const consumed = containerConsume(cont, recipe.ingredients[0], 0, size); // noop to ensure functions defined
          // perform consumption properly
          const required = {};
          for (const ing of recipe.ingredients) required[ing] = (required[ing] ?? 0) + 1;
          let failed = false;
          for (const key of Object.keys(required)) {
            const ok = containerConsume(cont, key, required[key], size);
            if (!ok) { failed = true; break; }
          }
          if (failed) continue;
          // add result
          const remaining = containerAdd(cont, recipe.result, recipe.count, size);
          if (remaining > 0) {
            // could not place all output; drop remainder via command
            try { block.dimension.runCommand(`give @a ${recipe.result} ${remaining}`); } catch (e) {}
          }
          break; // one craft per tick per machine
        }
      }
    } catch (e) {}
  }
}

function handlePipelines(nodes) {
  function getContainerFromBlock(block) {
    try {
      if (!block || !block.getComponent) return null;
      const comp = block.getComponent("minecraft:container") || block.getComponent("minecraft:inventory") || block.getComponent("container");
      if (!comp) return null;
      return comp.container ?? comp;
    } catch { return null; }
  }

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
          // move first non-empty slot
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

world.afterEvents.scriptEventReceive.subscribe((event) => {
  if (event.id !== "bluestone:register") return;
  const [identifier, kind] = String(event.message ?? "").split(/\s+/);
  registerNode(identifier, kind);
});

system.runInterval(() => {
  try {
    const nodes = collectNodesAroundPlayers();
    simulate(nodes);
    try { processMachines(nodes); } catch (e) {}
    try { handlePipelines(nodes); } catch (e) {}
  } catch (error) {
    console.warn(`[Bluestone API] ${error}`);
  }
}, 5);

world.afterEvents.blockBreak.subscribe((event) => {
  try {
    const block = event.block ?? (event.brokenBlocks && event.brokenBlocks[0]) ?? null;
    const player = event.player ?? event.entity;
    if (!block || !player) return;
    try {
      const type = block?.typeId ?? (block?.type?.id ? block.type.id : undefined) ?? '';
      if (type === "bluestone:ore" || type === "bluestone:bluestone_ore") {
        try {
          const pname = player.name ?? player.nameTag ?? player.__identifier ?? '';
          const cmd = `give "${pname}" bluestone:dust 1`;
          try { block.dimension.runCommand(cmd); } catch (e) { try { world.getDimension("overworld").runCommand(cmd); } catch (e2) {} }
        } catch (e) {}
      }
    } catch (e) {}
  } catch (e) {}
});

console.warn("[Bluestone API] Loaded. Register addon nodes with /scriptevent bluestone:register <identifier> <kind>.");
