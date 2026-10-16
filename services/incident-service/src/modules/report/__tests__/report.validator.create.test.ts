import { validationResult } from "express-validator";
import { addReportImagesValidators, createReportValidators } from "../report.validator";

const OK_URL = "https://res.cloudinary.com/ecolink/image/upload/v1/uploads/a.jpg";

async function errorsFor(body: Record<string, unknown>): Promise<string[]> {
  const req = { body } as never;
  await Promise.all(createReportValidators.map((v) => v.run(req)));
  return validationResult(req)
    .array()
    .map((e) => e.msg as string);
}

const valid = {
  title: "Rác ven kênh",
  latitude: 10.79,
  longitude: 106.68,
  category: "WATERWAY",
  wasteTypes: ["HOUSEHOLD"],
  images: [{ url: OK_URL }],
};

describe("createReportValidators", () => {
  const previous = process.env.CLOUDINARY_CLOUD_NAME;
  beforeAll(() => {
    process.env.CLOUDINARY_CLOUD_NAME = "ecolink";
  });
  afterAll(() => {
    process.env.CLOUDINARY_CLOUD_NAME = previous;
  });

  it("accepts the new body", async () => {
    expect(await errorsFor(valid)).toEqual([]);
  });

  it("accepts a legacy body without category (transition)", async () => {
    expect(
      await errorsFor({ title: "t", latitude: 1, longitude: 2, wasteType: "household", imageUrls: [OK_URL] }),
    ).toEqual([]);
  });

  it.each([
    ["unknown category", { ...valid, category: "FOO" }, "Invalid category"],
    ["unknown waste type", { ...valid, wasteTypes: ["PLASTIC"] }, "Invalid waste type"],
    ["11 images", { ...valid, images: Array.from({ length: 11 }, () => ({ url: OK_URL })) }, "images must contain 1 to 10 items"],
    ["foreign image host", { ...valid, images: [{ url: "https://example.com/a.jpg" }] }, "Image URL must be an Ecolink Cloudinary upload"],
    ["another Cloudinary account", { ...valid, images: [{ url: "https://res.cloudinary.com/other/image/upload/a.jpg" }] }, "Image URL must be an Ecolink Cloudinary upload"],
    ["legacy imageUrls on a foreign host", { ...valid, images: undefined, imageUrls: ["https://example.com/a.jpg"] }, "Image URL must be an Ecolink Cloudinary upload"],
    ["captureId not a UUID", { ...valid, images: [{ url: OK_URL, captureId: "x" }] }, "captureId must be a UUID"],
    ["no images at all", { ...valid, images: undefined }, "images is required"],
  ])("rejects %s", async (_name, body, message) => {
    expect(await errorsFor(body)).toContain(message);
  });
});

describe("addReportImagesValidators", () => {
  const previous = process.env.CLOUDINARY_CLOUD_NAME;
  beforeAll(() => {
    process.env.CLOUDINARY_CLOUD_NAME = "ecolink";
  });
  afterAll(() => {
    process.env.CLOUDINARY_CLOUD_NAME = previous;
  });

  const run = async (body: Record<string, unknown>) => {
    const req = { body } as never;
    await Promise.all(addReportImagesValidators.map((v) => v.run(req)));
    return validationResult(req).array().map((e) => e.msg as string);
  };

  it("uses the same image rules as create (P10)", async () => {
    expect(await run({ images: [{ url: OK_URL }] })).toEqual([]);
    expect(await run({ imageUrls: [OK_URL] })).toEqual([]);
    expect(await run({ images: [{ url: "https://example.com/a.jpg" }] })).toContain(
      "Image URL must be an Ecolink Cloudinary upload",
    );
    expect(await run({})).toContain("images is required");
  });
});
