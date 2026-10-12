// Redline OCR — raster helpers.
// An image is { width, height, data } with data = Uint8Array of packed RGB (3 bytes/pixel).

export function makeImage(width, height) {
  return { width, height, data: new Uint8Array(width * height * 3) };
}

/** Bilinear resize of an RGB image. */
export function resize(img, dw, dh) {
  dw = Math.max(1, dw | 0);
  dh = Math.max(1, dh | 0);
  const { width: sw, height: sh, data: src } = img;
  const out = makeImage(dw, dh);
  const dst = out.data;
  const xs = sw / dw;
  const ys = sh / dh;
  for (let y = 0; y < dh; y++) {
    const fy = Math.min(sh - 1, (y + 0.5) * ys - 0.5);
    const y0 = Math.max(0, Math.floor(fy));
    const y1 = Math.min(sh - 1, y0 + 1);
    const wy = fy - y0;
    for (let x = 0; x < dw; x++) {
      const fx = Math.min(sw - 1, (x + 0.5) * xs - 0.5);
      const x0 = Math.max(0, Math.floor(fx));
      const x1 = Math.min(sw - 1, x0 + 1);
      const wx = fx - x0;
      const i00 = (y0 * sw + x0) * 3, i01 = (y0 * sw + x1) * 3;
      const i10 = (y1 * sw + x0) * 3, i11 = (y1 * sw + x1) * 3;
      const o = (y * dw + x) * 3;
      for (let c = 0; c < 3; c++) {
        const top = src[i00 + c] * (1 - wx) + src[i01 + c] * wx;
        const bot = src[i10 + c] * (1 - wx) + src[i11 + c] * wx;
        dst[o + c] = top * (1 - wy) + bot * wy + 0.5;
      }
    }
  }
  return out;
}

/** Solve the 3x3 homography mapping src quad -> dst quad (both arrays of 4 [x,y]). */
export function perspectiveTransform(src, dst) {
  // 8 unknowns a..h, matrix row per constraint. Gaussian elimination.
  const A = [];
  const b = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i];
    const [u, v] = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
  }
  const n = 8;
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
    [A[col], A[piv]] = [A[piv], A[col]];
    [b[col], b[piv]] = [b[piv], b[col]];
    const p = A[col][col] || 1e-12;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = A[r][col] / p;
      if (!f) continue;
      for (let c = col; c < n; c++) A[r][c] -= f * A[col][c];
      b[r] -= f * b[col];
    }
  }
  const h = b.map((v, i) => v / (A[i][i] || 1e-12));
  return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
}

function invert3(m) {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C || 1e-12;
  return [
    A / det, -(b * i - c * h) / det, (b * f - c * e) / det,
    B / det, (a * i - c * g) / det, -(a * f - c * d) / det,
    C / det, -(a * h - b * g) / det, (a * e - b * d) / det,
  ];
}

/**
 * Crop a quadrilateral (points ordered tl,tr,br,bl) out of img and warp it to an upright
 * rectangle. Border pixels replicate. Rotates 90° if the crop is tall (vertical text).
 */
export function rotateCrop(img, pts) {
  return rotateCropInfo(img, pts).img;
}

/** As rotateCrop, but also reports whether the crop was turned 90° to read it. */
export function rotateCropInfo(img, pts) {
  const dist = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]);
  const cw = Math.max(1, Math.round(Math.max(dist(pts[0], pts[1]), dist(pts[2], pts[3]))));
  const ch = Math.max(1, Math.round(Math.max(dist(pts[0], pts[3]), dist(pts[1], pts[2]))));
  const dstQuad = [[0, 0], [cw, 0], [cw, ch], [0, ch]];
  const M = invert3(perspectiveTransform(pts, dstQuad)); // dst -> src
  const out = makeImage(cw, ch);
  const { width: sw, height: sh, data: src } = img;
  const dst = out.data;
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const w = M[6] * x + M[7] * y + M[8] || 1e-12;
      let sx = (M[0] * x + M[1] * y + M[2]) / w;
      let sy = (M[3] * x + M[4] * y + M[5]) / w;
      sx = Math.min(sw - 1, Math.max(0, sx));
      sy = Math.min(sh - 1, Math.max(0, sy));
      const x0 = Math.floor(sx), y0 = Math.floor(sy);
      const x1 = Math.min(sw - 1, x0 + 1), y1 = Math.min(sh - 1, y0 + 1);
      const wx = sx - x0, wy = sy - y0;
      const i00 = (y0 * sw + x0) * 3, i01 = (y0 * sw + x1) * 3;
      const i10 = (y1 * sw + x0) * 3, i11 = (y1 * sw + x1) * 3;
      const o = (y * cw + x) * 3;
      for (let c = 0; c < 3; c++) {
        const top = src[i00 + c] * (1 - wx) + src[i01 + c] * wx;
        const bot = src[i10 + c] * (1 - wx) + src[i11 + c] * wx;
        dst[o + c] = top * (1 - wy) + bot * wy + 0.5;
      }
    }
  }
  if (ch / cw >= 1.5) return { img: rot90(out), rotated: true };
  return { img: out, rotated: false };
}

/** Rotate 90° counter-clockwise (numpy rot90 semantics). */
export function rot90(img) {
  const { width: w, height: h, data } = img;
  const out = makeImage(h, w);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // dst[w-1-x][y] = src[y][x]
      const s = (y * w + x) * 3;
      const d = ((w - 1 - x) * h + y) * 3;
      out.data[d] = data[s]; out.data[d + 1] = data[s + 1]; out.data[d + 2] = data[s + 2];
    }
  }
  return out;
}

/** Pack an RGB image as a float32 CHW tensor normalised with mean/std 0.5 (x/255-0.5)/0.5. */
export function toCHW(img, out, offset = 0) {
  const { width: w, height: h, data } = img;
  const plane = w * h;
  for (let i = 0; i < plane; i++) {
    out[offset + i] = (data[i * 3] / 255 - 0.5) / 0.5;
    out[offset + plane + i] = (data[i * 3 + 1] / 255 - 0.5) / 0.5;
    out[offset + 2 * plane + i] = (data[i * 3 + 2] / 255 - 0.5) / 0.5;
  }
}
