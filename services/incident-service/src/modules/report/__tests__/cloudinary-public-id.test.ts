import { cloudinaryPublicId } from "../capture/cloudinary-public-id";

const base = "https://res.cloudinary.com/ecolink/image/upload/";

describe("cloudinaryPublicId", () => {
  it.each([
    [`${base}v1760000000/captures/abc.jpg`, "captures/abc"],
    [`${base}captures/abc.jpg`, "captures/abc"],
    [`${base}v1/captures/abc.png?x=1`, "captures/abc"],
    [`${base}uploads/xyz.png`, "uploads/xyz"],
  ])("%s -> %s", (url, id) => {
    expect(cloudinaryPublicId(url, "ecolink")).toBe(id);
  });

  it.each([
    "https://res.cloudinary.com/other/image/upload/captures/abc.jpg",
    `${base}c_fill,w_200/captures/abc.jpg`,
    `${base}w_200/captures/abc.jpg`,
    "https://example.com/captures/abc.jpg",
  ])("rejects %s", (url) => {
    expect(cloudinaryPublicId(url, "ecolink")).toBeNull();
  });
});
