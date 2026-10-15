const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** A Build ID: 8 random base62 characters, about 47 bits (docs/design.md#build-pages). */
export function newBuildId(): string {
  let id = "";
  while (id.length < 8) {
    for (const byte of crypto.getRandomValues(new Uint8Array(16))) {
      // 248 = 4 × 62: rejecting the bytes above it keeps every character equally likely.
      if (byte < 248 && id.length < 8) id += BASE62[byte % 62];
    }
  }
  return id;
}
