import { AsyncLocalStorage } from "node:async_hooks";
export const commandInput = new AsyncLocalStorage<string | undefined>();
