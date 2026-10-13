/**
 * Builds a tiny JPEG whose APP1 segment carries the EXIF a result photo is graded on
 * (DateTimeOriginal + OffsetTimeOriginal, GPS, Model). Only the metadata matters: the image data
 * is a placeholder, Cloudinary is mocked in tests. `seed` changes the bytes (and so the SHA-256).
 */
export interface JpegExifInput {
  /** "YYYY:MM:DD HH:MM:SS" in the camera's local time. */
  takenAt?: string;
  /** "+07:00". */
  offset?: string;
  latitude?: number;
  longitude?: number;
  model?: string;
  seed?: string;
}

type Entry = { tag: number; type: 2 | 3 | 4 | 5; values: number[] | string };

const TYPE_SIZE = { 2: 1, 3: 2, 4: 4, 5: 8 } as const;

function encodeValue(e: Entry): Buffer {
  if (e.type === 2) return Buffer.from(`${e.values as string}\0`, "latin1");
  const nums = e.values as number[];
  const out = Buffer.alloc(nums.length * TYPE_SIZE[e.type]);
  nums.forEach((n, i) => {
    if (e.type === 3) out.writeUInt16LE(n, i * 2);
    else if (e.type === 4) out.writeUInt32LE(n, i * 4);
    else {
      out.writeUInt32LE(Math.round(n * 1_000_000), i * 8);
      out.writeUInt32LE(1_000_000, i * 8 + 4);
    }
  });
  return out;
}

function count(e: Entry): number {
  return e.type === 2 ? (e.values as string).length + 1 : (e.values as number[]).length;
}

/** One IFD at `offset` (from the TIFF header), its out-of-line values right after it. */
function ifd(entries: Entry[], offset: number): Buffer {
  const sorted = [...entries].sort((a, b) => a.tag - b.tag);
  const head = Buffer.alloc(2 + sorted.length * 12 + 4);
  head.writeUInt16LE(sorted.length, 0);
  let dataOffset = offset + head.length;
  const data: Buffer[] = [];
  sorted.forEach((e, i) => {
    const at = 2 + i * 12;
    const value = encodeValue(e);
    head.writeUInt16LE(e.tag, at);
    head.writeUInt16LE(e.type, at + 2);
    head.writeUInt32LE(count(e), at + 4);
    if (value.length <= 4) {
      value.copy(head, at + 8);
    } else {
      head.writeUInt32LE(dataOffset, at + 8);
      data.push(value);
      dataOffset += value.length;
    }
  });
  return Buffer.concat([head, ...data]);
}

const dms = (deg: number) => {
  const a = Math.abs(deg);
  const d = Math.floor(a);
  const m = Math.floor((a - d) * 60);
  const s = (a - d - m / 60) * 3600;
  return [d, m, s];
};

/** Builds the TIFF block in passes: IFD sizes do not depend on the offsets written into them. */
function tiff(input: JpegExifInput): Buffer {
  const exifEntries: Entry[] = [];
  if (input.takenAt) exifEntries.push({ tag: 0x9003, type: 2, values: input.takenAt });
  if (input.offset) exifEntries.push({ tag: 0x9011, type: 2, values: input.offset });
  const hasGps = input.latitude != null && input.longitude != null;
  const gpsEntries: Entry[] = hasGps
    ? [
        { tag: 0x0001, type: 2, values: input.latitude! >= 0 ? "N" : "S" },
        { tag: 0x0002, type: 5, values: dms(input.latitude!) },
        { tag: 0x0003, type: 2, values: input.longitude! >= 0 ? "E" : "W" },
        { tag: 0x0004, type: 5, values: dms(input.longitude!) },
      ]
    : [];
  const build = (exifOffset: number, gpsOffset: number) => {
    const ifd0Entries: Entry[] = [
      { tag: 0x0110, type: 2, values: input.model ?? "Test Camera" },
      { tag: 0x8769, type: 4, values: [exifOffset] },
      ...(hasGps ? [{ tag: 0x8825, type: 4 as const, values: [gpsOffset] }] : []),
      ...(input.seed ? [{ tag: 0x010e, type: 2 as const, values: input.seed }] : []),
    ];
    const ifd0 = ifd(ifd0Entries, 8);
    const exif = ifd(exifEntries, 8 + ifd0.length);
    const gps = hasGps ? ifd(gpsEntries, 8 + ifd0.length + exif.length) : Buffer.alloc(0);
    return { ifd0, exif, gps };
  };
  const first = build(0, 0);
  const exifOffset = 8 + first.ifd0.length;
  const gpsOffset = exifOffset + first.exif.length;
  const { ifd0, exif, gps } = build(exifOffset, gpsOffset);
  const header = Buffer.from([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00]);
  return Buffer.concat([header, ifd0, exif, gps]);
}

export function jpegWithExif(input: JpegExifInput = {}): Buffer {
  const hasExif = input.takenAt || input.latitude != null || input.model || input.offset;
  const soi = Buffer.from([0xff, 0xd8]);
  const eoi = Buffer.from([0xff, 0xd9]);
  // A comment segment carries the seed when there is no EXIF, so the hash still differs.
  const comment = (text: string) => {
    const body = Buffer.from(text, "latin1");
    const len = Buffer.alloc(2);
    len.writeUInt16BE(body.length + 2);
    return Buffer.concat([Buffer.from([0xff, 0xfe]), len, body]);
  };
  if (!hasExif) return Buffer.concat([soi, comment(input.seed ?? "no-exif"), eoi]);
  const payload = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff(input)]);
  const len = Buffer.alloc(2);
  len.writeUInt16BE(payload.length + 2);
  return Buffer.concat([soi, Buffer.from([0xff, 0xe1]), len, payload, eoi]);
}
