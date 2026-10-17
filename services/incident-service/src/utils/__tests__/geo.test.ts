import { geohashCellCenter, geohashEncode, normalizeVi } from "../geo";

describe("geohash", () => {
  it("matches the reference vector", () => {
    expect(geohashEncode(57.64911, 10.40744, 11)).toBe("u4pruydqqvj");
    expect(geohashEncode(57.64911, 10.40744, 7)).toBe("u4pruyd");
  });

  it("cell centre encodes back to the same cell", () => {
    for (const [lat, lng] of [
      [10.7725, 106.698],
      [-33.8688, 151.2093],
      [57.64911, 10.40744],
    ]) {
      const hash = geohashEncode(lat, lng, 7);
      const c = geohashCellCenter(hash);
      expect(geohashEncode(c.lat, c.lng, 7)).toBe(hash);
    }
  });
});

describe("normalizeVi", () => {
  it("drops diacritics, đ and extra spaces", () => {
    expect(normalizeVi("Đường Kênh Tẻ")).toBe("duong kenh te");
    expect(normalizeVi("  Chợ  Bến Thành ")).toBe("cho ben thanh");
  });
});
