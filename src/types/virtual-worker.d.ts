declare module "virtual:worker" {
    const workerCode: string;
    export default workerCode;
}

/** ZotFlow Evo: the full-text search worker (src/fulltext/worker.ts), gzipped, base64. */
declare module "virtual:fulltext-worker" {
    const gzippedBase64: string;
    export default gzippedBase64;
}

/** ZotFlow Evo: SQLite's WebAssembly binary, inside the full-text worker. */
declare module "virtual:sqlite-wasm-binary" {
    const wasm: Uint8Array;
    export default wasm;
}
