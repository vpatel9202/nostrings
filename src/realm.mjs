// The vm context cells run in. Defense in depth only: node:vm is not a
// security boundary (see SECURITY.md). This removes the easy paths: string
// eval, fetch, Buffer, URL, and globalThis.constructor reaching the host
// Function. Host functions handed to cells still reach the host realm.
import vm from "node:vm";

export function createCellContext(globals, options = {}) {
  const sandbox = Object.create(null);
  Object.assign(sandbox, globals, { atob, btoa });
  return vm.createContext(sandbox, {
    ...options,
    codeGeneration: { strings: false, wasm: false },
  });
}
