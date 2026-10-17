/**
 * public_id of an untransformed Cloudinary image URL of `cloudName`, e.g.
 * https://res.cloudinary.com/ecolink/image/upload/v1760000000/captures/abc.jpg -> "captures/abc".
 * Null for another account or a URL with transformations (a live capture is always the original).
 */
export function cloudinaryPublicId(url: string, cloudName: string): string | null {
  const prefix = `https://res.cloudinary.com/${cloudName}/image/upload/`;
  if (!url.startsWith(prefix)) return null;
  const path = url.slice(prefix.length).split(/[?#]/)[0].replace(/^v\d+\//, "");
  const firstSegment = path.split("/")[0];
  if (!path || firstSegment.includes(",") || /^[a-z]{1,3}_/.test(firstSegment)) return null;
  return path.replace(/\.[a-z0-9]+$/i, "");
}
