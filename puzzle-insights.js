export const GENERATOR_VERSION = '2026-09-20.2';
export const GAME_GUIDE = {
  constraint: { title: 'The seating problem', skill: 'Constraint reasoning', standard: '3 seats, 3 attributes, one satisfying arrangement', grandmaster: '4 seats, 3 attributes, one satisfying arrangement' },
  automaton: { title: 'The register machine', skill: 'Program execution', standard: '3 registers, 9–12 instructions', grandmaster: '4 registers, 16–22 instructions; conditions or an inverse problem' },
  walk: { title: 'The midnight walk', skill: 'Spatial state tracking', standard: '9–13 commands; report position', grandmaster: '18–26 commands, possible mirrors; report position and heading' },
  logic: { title: 'The logic circuit', skill: 'Boolean reasoning', standard: '3–4 inputs; AND, OR, XOR and NAND', grandmaster: '6–8 inputs, deeper expressions and NOR' },
  sequence: { title: 'The next move', skill: 'Bounded rule inference', standard: 'One rule from the stated integer-sequence families', grandmaster: 'Two interleaved affine recurrences' },
  induction: { title: 'The hidden operation', skill: 'String transformation', standard: 'Up to 2 stated operations, 3 examples', grandmaster: 'Up to 4 stated operations, 4 examples' },
  cipher: { title: 'The encoded note', skill: 'Encoding fluency', standard: '2–4 layers; encoding order given', grandmaster: '4–6 layers; order hidden' },
};

export function puzzleMetadata(p) {
  const dimensions = {};
  if (p.game === 'automaton') {
    dimensions.instructions = p.prompt.program.length;
    dimensions.mode = p.mode || 'forward';
    dimensions.registers = Object.keys(p.prompt.initialRegisters || p.prompt.knownInitialRegisters).length + (p.mode === 'inverse' ? 1 : 0);
  } else if (p.game === 'walk') dimensions.commands = p.prompt.split(' ').length;
  else if (p.game === 'constraint') { dimensions.seats = p.prompt.codenames.length; dimensions.clues = p.prompt.clues.length; }
  else if (p.game === 'logic') dimensions.inputs = Object.keys(p.inputs).length;
  else if (p.game === 'induction') { dimensions.examples = p.prompt.examples.length; dimensions.maxOperations = p.tier === 'grandmaster' ? 4 : 2; }
  return { generatorVersion: GENERATOR_VERSION, difficulty: { tier: p.tier || 'standard', skill: GAME_GUIDE[p.game].skill, description: GAME_GUIDE[p.game][p.tier || 'standard'], dimensions, calibrated: false } };
}

export function puzzleFeedback(p) {
  if (p.solution) return p.solution;
  if (p.game === 'logic') return { summary: `Substitute ${Object.entries(p.inputs).map(([k,v]) => `${k}=${v}`).join(', ')}. Evaluate parentheses from the inside out; NOT flips a bit, NAND negates AND and NOR negates OR. The circuit evaluates to ${p.answer}.`, expression: p.prompt };
  return { summary: `The accepted answer is ${p.answer}. Apply the stated rules to the supplied prompt.` };
}
