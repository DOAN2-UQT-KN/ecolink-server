import { notAvailableResult, type CheckRunner } from "./check-runner";

// shortcut: stub NOT_AVAILABLE; check thật ở P06
export const duplicateCheck: CheckRunner = {
  name: "DUPLICATE",
  signalNames: ["phash", "orb", "internet"],
  version: (cfg) => cfg.duplicate.version,
  run: async (ctx) => notAvailableResult(duplicateCheck, ctx.checksConfig),
};
