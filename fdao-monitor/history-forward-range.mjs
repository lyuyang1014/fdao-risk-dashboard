export function inferThroughBlock(state) {
  if (Number.isFinite(state?.throughBlock)) return state.throughBlock;
  const eventBlocks = (state?.events || [])
    .map((event) => Number(event.block))
    .filter(Number.isFinite);
  if (eventBlocks.length) return Math.max(...eventBlocks);
  return Number.isFinite(state?.floor) ? state.floor - 1 : null;
}

export function nextForwardRange({ state, targetBlock, span }) {
  if (!state?.done) return null;
  const throughBlock = inferThroughBlock(state);
  if (!Number.isFinite(throughBlock) || throughBlock >= targetBlock) {
    return null;
  }
  return {
    from: throughBlock + 1,
    to: Math.min(targetBlock, throughBlock + span),
  };
}
