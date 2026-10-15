import { normalizeCreateReportInput } from "../report-create.input";

const base = { title: "t", latitude: 10.79, longitude: 106.68 };

describe("normalizeCreateReportInput", () => {
  it("passes the new images shape through, keeping captureId", () => {
    const out = normalizeCreateReportInput({
      ...base,
      images: [{ url: " https://a/1.jpg ", captureId: "c1" }, { url: "https://a/2.jpg" }],
    });
    expect(out.images).toEqual([
      { url: "https://a/1.jpg", captureId: "c1" },
      { url: "https://a/2.jpg", captureId: null },
    ]);
  });

  it("maps legacy imageUrls to gallery images", () => {
    const out = normalizeCreateReportInput({ ...base, imageUrls: ["https://a/1.jpg"] });
    expect(out.images).toEqual([{ url: "https://a/1.jpg", captureId: null }]);
  });

  it("parses the legacy CSV wasteType, dropping unknown and duplicate values", () => {
    const out = normalizeCreateReportInput({ ...base, wasteType: "household, Construction,abc,household" });
    expect(out.wasteTypes).toEqual(["HOUSEHOLD", "CONSTRUCTION"]);
    expect(out.wasteTypeCsv).toBe("household,construction");
  });

  it("prefers wasteTypes over the legacy field and de-duplicates", () => {
    const out = normalizeCreateReportInput({
      ...base,
      wasteType: "industrial",
      wasteTypes: ["HAZARDOUS", "HAZARDOUS", "HOUSEHOLD"],
    });
    expect(out.wasteTypes).toEqual(["HAZARDOUS", "HOUSEHOLD"]);
    expect(out.wasteTypeCsv).toBe("hazardous,household");
  });

  it("defaults category to OTHER and an empty waste list to a null CSV", () => {
    const out = normalizeCreateReportInput({ ...base, imageUrls: [] });
    expect(out.category).toBe("OTHER");
    expect(out.wasteTypes).toEqual([]);
    expect(out.wasteTypeCsv).toBeNull();
  });

  it("keeps an explicit category", () => {
    expect(normalizeCreateReportInput({ ...base, category: "MARKET" }).category).toBe("MARKET");
  });
});
