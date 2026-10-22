import { generateOrderCode, normalizeOrderCode, ORDER_CODE_PATTERN } from "../order-code.util";

describe("generateOrderCode", () => {
  it("always matches EL- + 8 unambiguous characters", () => {
    for (let i = 0; i < 1000; i++) {
      const code = generateOrderCode();
      expect(code).toMatch(ORDER_CODE_PATTERN);
      expect(code.slice(3)).not.toMatch(/[0O1IL]/);
    }
  });
});

describe("normalizeOrderCode", () => {
  it("accepts any case, spaces and a missing prefix", () => {
    expect(normalizeOrderCode(" el-7f3k 2qxm ")).toBe("EL-7F3K2QXM");
    expect(normalizeOrderCode("7f3k2qxm")).toBe("EL-7F3K2QXM");
    expect(normalizeOrderCode("EL-7F3K2QXM")).toBe("EL-7F3K2QXM");
  });

  it("returns null for anything that cannot be a code", () => {
    expect(normalizeOrderCode("EL-0000000")).toBeNull();
    expect(normalizeOrderCode("EL-0OOOOOOO")).toBeNull();
    expect(normalizeOrderCode("abc")).toBeNull();
    expect(normalizeOrderCode("")).toBeNull();
  });
});
