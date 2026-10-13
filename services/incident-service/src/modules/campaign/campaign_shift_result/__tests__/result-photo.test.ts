import { jpegWithExif } from "../../../../__it__/setup/jpeg-exif";
import {
  gradePhoto,
  parseExifDate,
  pointLayer1,
  readPhotoExif,
  sha256Hex,
  sniffImageType,
  type PointPhoto,
} from "../result-photo.service";

const HOUR = 60 * 60 * 1000;
const NOW = new Date("2026-10-05T03:00:00Z"); // 10:00 in Vietnam
const POINT = { latitude: 10.77, longitude: 106.7 };
/** ~55 m north of the point. */
const NEAR = { latitude: 10.7705, longitude: 106.7 };
/** ~1.1 km north. */
const FAR = { latitude: 10.78, longitude: 106.7 };

const grade = (exif: { takenAt?: Date | null; latitude?: number | null; longitude?: number | null }, pin = NEAR, point: typeof POINT | null = POINT) =>
  gradePhoto({
    uploadedAt: NOW,
    exif: { takenAt: exif.takenAt ?? null, latitude: exif.latitude ?? null, longitude: exif.longitude ?? null },
    pin,
    point,
  });

describe("gradePhoto (Layer 1, library photo)", () => {
  it("passes with recent EXIF time, GPS near the pin, pin near the point", () => {
    const g = grade({ takenAt: new Date(NOW.getTime() - 2 * HOUR), ...NEAR });
    expect(g).toMatchObject({ timeCheck: "pass", exifLocationCheck: "pass", pinCheck: "pass", level: "pass" });
    expect(g.pinDistanceM).toBeGreaterThan(40);
    expect(g.pinDistanceM).toBeLessThan(70);
    expect(g.exifDistanceM).toBe(0);
  });

  it("warns without EXIF time or GPS (photos from the internet)", () => {
    expect(grade({})).toMatchObject({ timeCheck: "warn", exifLocationCheck: "warn", pinCheck: "pass", level: "warn" });
  });

  it("fails an old photo, one taken after sending, or EXIF GPS far from the pin", () => {
    expect(grade({ takenAt: new Date(NOW.getTime() - 49 * HOUR), ...NEAR })).toMatchObject({ timeCheck: "fail", level: "fail" });
    expect(grade({ takenAt: new Date(NOW.getTime() - 30 * 24 * HOUR) }).timeCheck).toBe("fail");
    expect(grade({ takenAt: new Date(NOW.getTime() + HOUR) }).timeCheck).toBe("fail");
    // A camera clock a minute ahead is not "after sending".
    expect(grade({ takenAt: new Date(NOW.getTime() + 60_000) }).timeCheck).toBe("pass");
    const g = grade({ takenAt: NOW, ...FAR });
    expect(g).toMatchObject({ exifLocationCheck: "fail", level: "fail" });
    expect(g.exifDistanceM).toBeGreaterThan(1000);
  });

  it("fails a pin far from the trash point; warns when the point has no coordinates", () => {
    expect(grade({ takenAt: NOW, ...FAR }, FAR)).toMatchObject({ exifLocationCheck: "pass", pinCheck: "fail", level: "fail" });
    expect(grade({ takenAt: NOW, ...NEAR }, NEAR, null)).toMatchObject({ pinCheck: "warn", pinDistanceM: null, level: "warn" });
  });
});

describe("EXIF reading", () => {
  it("reads time with its offset (Vietnam by default), GPS and model", async () => {
    const exif = await readPhotoExif(
      jpegWithExif({ takenAt: "2026:10:05 09:30:00", offset: "+07:00", latitude: 10.7712, longitude: 106.7012, model: "Pixel 8" }),
    );
    expect(exif.takenAt?.toISOString()).toBe("2026-10-05T02:30:00.000Z");
    expect(exif.latitude).toBeCloseTo(10.7712, 4);
    expect(exif.longitude).toBeCloseTo(106.7012, 4);
    expect(exif.cameraModel).toBe("Pixel 8");
    expect((await readPhotoExif(jpegWithExif({ takenAt: "2026:10:05 09:30:00" }))).takenAt?.toISOString()).toBe(
      "2026-10-05T02:30:00.000Z",
    );
  });

  it("finds nothing in a photo without EXIF or a file that is not an image", async () => {
    expect(await readPhotoExif(jpegWithExif({ seed: "plain" }))).toEqual({
      takenAt: null,
      latitude: null,
      longitude: null,
      cameraModel: null,
    });
    expect((await readPhotoExif(Buffer.from("not an image"))).takenAt).toBeNull();
  });

  it("parses EXIF dates strictly", () => {
    expect(parseExifDate("2026:10:05 09:30:00", "-03:00")?.toISOString()).toBe("2026-10-05T12:30:00.000Z");
    expect(parseExifDate("garbage")).toBeNull();
    expect(parseExifDate(undefined)).toBeNull();
  });

  it("sniffs the real type and hashes the bytes", () => {
    expect(sniffImageType(jpegWithExif({ seed: "a" }))).toBe("image/jpeg");
    expect(sniffImageType(Buffer.from("GIF89a....."))).toBeNull();
    expect(sha256Hex(jpegWithExif({ seed: "a" }))).not.toBe(sha256Hex(jpegWithExif({ seed: "b" })));
  });
});

const photo = (p: Partial<PointPhoto> & Pick<PointPhoto, "url" | "side">): PointPhoto => ({
  level: "pass",
  sha256: p.url,
  exifTakenAt: null,
  ...p,
});

describe("pointLayer1", () => {
  const t = (h: number) => new Date(NOW.getTime() - h * HOUR);

  it("is the worst of the photos; legacy photos warn", () => {
    expect(pointLayer1([photo({ url: "b", side: "before" })], [photo({ url: "a", side: "after" })])).toEqual({
      level: "pass",
      issues: [],
    });
    const warn = pointLayer1([], [photo({ url: "a", side: "after", level: "warn" }), photo({ url: "l", side: "after", level: null, sha256: null })]);
    expect(warn.level).toBe("warn");
    expect(warn.issues.map((i) => i.code)).toEqual(["photo_warn", "legacy_photo"]);
    const fail = pointLayer1([photo({ url: "b", side: "before", level: "fail" })], [photo({ url: "a", side: "after" })]);
    expect(fail).toMatchObject({ level: "fail", issues: [{ code: "photo_fail", side: "before", url: "b" }] });
  });

  it("fails when a photo before is not taken earlier than every photo after", () => {
    const ok = pointLayer1([photo({ url: "b", side: "before", exifTakenAt: t(3) })], [photo({ url: "a", side: "after", exifTakenAt: t(1) })]);
    expect(ok.level).toBe("pass");
    const wrong = pointLayer1(
      [photo({ url: "b", side: "before", exifTakenAt: t(1) })],
      [photo({ url: "a", side: "after", exifTakenAt: t(3) }), photo({ url: "c", side: "after", exifTakenAt: t(0) })],
    );
    expect(wrong).toMatchObject({ level: "fail", issues: [{ code: "before_not_earlier" }] });
    const same = pointLayer1([photo({ url: "b", side: "before", exifTakenAt: t(1) })], [photo({ url: "a", side: "after", exifTakenAt: t(1) })]);
    expect(same.level).toBe("fail");
  });

  it("fails the same file before and after, and a file used elsewhere", () => {
    const dup = pointLayer1([photo({ url: "b", side: "before", sha256: "h1" })], [photo({ url: "a", side: "after", sha256: "h1" })]);
    expect(dup).toMatchObject({ level: "fail", issues: [{ code: "before_after_same", url: "b" }] });
    const reused = pointLayer1([], [photo({ url: "a", side: "after", sha256: "h2" })], new Set(["h2"]));
    expect(reused).toMatchObject({ level: "fail", issues: [{ code: "hash_reused", side: "after", url: "a" }] });
  });
});
