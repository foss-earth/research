/** Honest boundary for a legacy comparison without an admitted public contract. */
export function pendingContract(name) {
  throw new Error(`Research tool blocked: ${name}. No experiment ran. See tools-manifest.json; the original source and recorded results are retained at their immutable revision.`);
}
