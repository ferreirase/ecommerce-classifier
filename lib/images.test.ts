import assert from "node:assert/strict";
import { test } from "node:test";
import { imageProblem, sniffImage } from "./images.ts";

const png = (w: number, h: number) => {
  const b = new Uint8Array(32);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  new DataView(b.buffer).setUint32(16, w);
  new DataView(b.buffer).setUint32(20, h);
  return b;
};
// SOI, an APP0 segment to skip, then SOF0 with height 830 and width 600.
const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x03, 0x3e, 0x02, 0x58, 0x03, 0, 0, 0]);

test("reads format and size from PNG and JPEG headers", () => {
  assert.deepEqual(sniffImage(png(1500, 1200)), { format: "png", width: 1500, height: 1200 });
  assert.deepEqual(sniffImage(jpeg), { format: "jpeg", width: 600, height: 830 });
  assert.equal(sniffImage(new TextEncoder().encode("RIFF....WEBPVP8 ")), null);
});

test("applies Jev's size limits", () => {
  assert.equal(imageProblem({ format: "jpeg", width: 600, height: 830 }, 35_000), null);
  assert.match(imageProblem(null, 10)!, /formato/);
  assert.match(imageProblem({ format: "png", width: 200, height: 900 }, 10)!, /pequena/);
  assert.match(imageProblem({ format: "png", width: 2000, height: 1000 }, 10)!, /grande/);
});
