import { notAvailableResult, type CheckRunner } from "./check-runner";

// shortcut: stub NOT_AVAILABLE; check thật ở P08
export const contextCheck: CheckRunner = {
  name: "CONTEXT",
  signalNames: ["category_fit"],
  version: (cfg) => cfg.context.version,
  run: async (ctx) => notAvailableResult(contextCheck, ctx.checksConfig),
};
