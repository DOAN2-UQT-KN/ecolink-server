import { notAvailableResult, type CheckRunner } from "./check-runner";

// shortcut: stub NOT_AVAILABLE; check thật ở P07
export const trustCheck: CheckRunner = {
  name: "TRUST",
  signalNames: ["capture", "reject_history", "account_age"],
  version: (cfg) => cfg.trust.version,
  run: async (ctx) => notAvailableResult(trustCheck, ctx.checksConfig),
};
