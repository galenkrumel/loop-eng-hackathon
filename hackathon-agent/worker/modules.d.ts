// Non-JS module imports handled by wrangler's bundler:
// - *.ttf via the wrangler.jsonc Data rule (raw bytes)
// - *.wasm as pre-compiled WebAssembly modules (native wrangler behavior)
declare module "*.ttf" {
  const data: ArrayBuffer;
  export default data;
}

declare module "*.wasm" {
  const wasmModule: WebAssembly.Module;
  export default wasmModule;
}
