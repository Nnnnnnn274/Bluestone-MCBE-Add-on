# Bluestone Bedrock Add-on

Bluestone is a separate blue energy system inspired by redstone, with its own dust, connector, source, lamp, and logic gates.

## Packs

- `Bluestone_API_BP`: reusable simulation/API behavior pack.
- `Bluestone_Logic_BP`: actual Bluestone logic blocks. Depends on the API behavior pack.
- `Bluestone_RP`: block textures. Depends on the logic behavior pack.

## Blocks

- Bluestone Dust
- Redstone-Bluestone Connector
- Bluestone Torch
- Bluestone Lamp
- AND, OR, NOT, XOR, NAND, NOR, XNOR gates
- Diode
- Splitter

## API for Other Add-ons

The API pack runs the Bluestone energy graph. Other packs can register compatible custom blocks with:

```mcfunction
/scriptevent bluestone:register namespace:block_id kind
```

Supported `kind` values:

- `wire`: transmits power from any active neighbor.
- `connector`: bridges vanilla redstone-like blocks into Bluestone logic.
- `source`: always outputs Bluestone power.
- `sink`: reads and displays power.
- `and`, `or`, `not`, `xor`, `nand`, `nor`, `xnor`: logic gates.
- `diode`: one-step powered node.
- `splitter`: one input to multiple outputs.

If a registered block has a boolean block state named `bluestone:powered`, the API updates it automatically.

## Notes

Bedrock custom blocks do not expose full vanilla redstone wire behavior to scripts. The connector reads nearby vanilla redstone blocks, torches, wire, buttons, repeaters, comparators, and levers as inputs into Bluestone. Output back into vanilla redstone is intentionally left for a later machine/component pass.

Import the three folders as development packs, or zip them together as a `.mcaddon`.