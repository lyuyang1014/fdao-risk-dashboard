if (!process.env.NODEREAL_RPC_URL) {
  throw new Error("NODEREAL_RPC_URL is required");
}
await import("./indexer5.mjs");
