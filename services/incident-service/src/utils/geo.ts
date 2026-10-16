const BASE32 = "0123456789bcdefghjkmnpqrstuvwxyz";

/** Standard geohash; a 7-char cell is about 153 m x 153 m, 8 chars about 38 m x 19 m. */
export function geohashEncode(lat: number, lng: number, precision: number): string {
  let latRange = [-90, 90];
  let lngRange = [-180, 180];
  let hash = "";
  let bits = 0;
  let value = 0;
  let evenBit = true;
  while (hash.length < precision) {
    const range = evenBit ? lngRange : latRange;
    const coord = evenBit ? lng : lat;
    const mid = (range[0] + range[1]) / 2;
    value <<= 1;
    if (coord >= mid) {
      value |= 1;
      range[0] = mid;
    } else {
      range[1] = mid;
    }
    evenBit = !evenBit;
    if (++bits === 5) {
      hash += BASE32[value];
      bits = 0;
      value = 0;
    }
  }
  return hash;
}

/** Centre of a geohash cell. */
export function geohashCellCenter(hash: string): { lat: number; lng: number } {
  const lat = [-90, 90];
  const lng = [-180, 180];
  let evenBit = true;
  for (const char of hash) {
    const value = BASE32.indexOf(char);
    for (let bit = 4; bit >= 0; bit--) {
      const range = evenBit ? lng : lat;
      const mid = (range[0] + range[1]) / 2;
      if ((value >> bit) & 1) range[0] = mid;
      else range[1] = mid;
      evenBit = !evenBit;
    }
  }
  return { lat: (lat[0] + lat[1]) / 2, lng: (lng[0] + lng[1]) / 2 };
}

/** Lower-case Vietnamese text without diacritics, for keyword matching ("Chợ" -> "cho"). */
export function normalizeVi(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}
