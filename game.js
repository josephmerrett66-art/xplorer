const canvas = document.getElementById("game");
const ctx = canvas.getContext("2d");

const TILE_W = 82;
const TILE_H = 41;
const CHUNK_SIZE = 12;
const DRAW_RADIUS = 3;
const WORLD_SEED = 88421;
const HEIGHT_STEP = 22;
const MAX_CLIMB = 1;

const keys = new Set();
const chunks = new Map();

const player = {
  x: 0.5,
  y: 0.5,
  z: 0,
  vx: 0,
  vy: 0,
  facing: 1,
  step: 0,
  gait: 0,
  moving: false,
  heading: Math.PI * 0.25, // world-space travel direction, for the minimap arrow
};

const camera = {
  x: 0,
  y: 0,
};

let width = 0;
let height = 0;
let dpr = 1;
let lastTime = performance.now();
let vignette = null;
let animTime = 0; // always-advancing clock for idle breathing / blinking

function resize() {
  // Cap at 2 so the chunky block art stays integer-scaled and crisp on Retina displays.
  dpr = Math.max(1, Math.min(window.devicePixelRatio || 1, 2));
  width = Math.floor(window.innerWidth);
  height = Math.floor(window.innerHeight);
  canvas.width = Math.floor(width * dpr);
  canvas.height = Math.floor(height * dpr);
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.imageSmoothingEnabled = false;
  buildVignette();
}

// The vignette is a static overlay, so it's rasterised once per resize and blitted each frame
// instead of evaluating two full-screen radial gradients every single frame.
function buildVignette() {
  vignette = document.createElement("canvas");
  vignette.width = width;
  vignette.height = height;
  const vctx = vignette.getContext("2d");

  const glow = vctx.createRadialGradient(width * 0.66, height * 0.26, 10, width * 0.66, height * 0.26, Math.max(width, height) * 0.62);
  glow.addColorStop(0, "rgba(255, 188, 112, 0.16)");
  glow.addColorStop(0.45, "rgba(255, 168, 96, 0.05)");
  glow.addColorStop(1, "rgba(255, 168, 96, 0)");
  vctx.fillStyle = glow;
  vctx.fillRect(0, 0, width, height);

  const cx = width * 0.5;
  const cy = height * 0.46;
  const inner = Math.min(width, height) * 0.42;
  const outer = Math.max(width, height) * 0.82;
  const frame = vctx.createRadialGradient(cx, cy, inner, cx, cy, outer);
  frame.addColorStop(0, "rgba(12, 7, 11, 0)");
  frame.addColorStop(0.7, "rgba(12, 7, 11, 0.28)");
  frame.addColorStop(1, "rgba(8, 5, 9, 0.74)");
  vctx.fillStyle = frame;
  vctx.fillRect(0, 0, width, height);
}

function hash2(x, y, seed = WORLD_SEED) {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(seed, 1442695041);
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

function smoothNoise(x, y, scale, seedOffset = 0) {
  const fx = x / scale;
  const fy = y / scale;
  const ix = Math.floor(fx);
  const iy = Math.floor(fy);
  const tx = fx - ix;
  const ty = fy - iy;
  const sx = tx * tx * (3 - 2 * tx);
  const sy = ty * ty * (3 - 2 * ty);
  const a = hash2(ix, iy, WORLD_SEED + seedOffset);
  const b = hash2(ix + 1, iy, WORLD_SEED + seedOffset);
  const c = hash2(ix, iy + 1, WORLD_SEED + seedOffset);
  const d = hash2(ix + 1, iy + 1, WORLD_SEED + seedOffset);
  const top = a + (b - a) * sx;
  const bottom = c + (d - c) * sx;
  return top + (bottom - top) * sy;
}

function isPathTile(x, y) {
  const roadBandA = Math.abs(y - Math.sin(x * 0.12) * 4);
  const roadBandB = Math.abs(x + Math.cos(y * 0.12) * 5 - 8);
  const roadBandC = Math.abs(y + x * 0.42 - Math.sin(x * 0.08) * 5 + 18);
  return roadBandA < 2.5 || roadBandB < 2 || roadBandC < 1.8;
}

function waterStrength(x, y) {
  const riverA = Math.abs(y - Math.sin(x * 0.09 + 2.2) * 7 - 8);
  const riverB = Math.abs(x + Math.sin(y * 0.08 - 1.4) * 7 + 20);
  const lakeA = Math.hypot(x - 18, y + 10);
  const lakeB = Math.hypot(x + 28, y - 18);
  const stream = riverA < 2.3 || riverB < 1.9;
  const lake = lakeA < 8.5 || lakeB < 9.5;
  return stream || lake ? 1 : 0;
}

function terrainLevel(x, y) {
  const hills = smoothNoise(x, y, 20, 301) * 2.7 + smoothNoise(x, y, 8, 302) * 1.35;
  const ridges = smoothNoise(x + 35, y - 10, 13, 303);
  let level = Math.floor(hills + (ridges > 0.68 ? 1 : 0));

  if (isPathTile(x, y)) {
    level = Math.floor(smoothNoise(x, y, 28, 320) * 2.1) + 1;
  }

  const gullyA = Math.abs(y + Math.sin(x * 0.13) * 5 - 22);
  const gullyB = Math.abs(x - Math.cos(y * 0.1) * 6 + 18);
  if (gullyA < 2.6 || gullyB < 2.4) level -= 1;
  if (waterStrength(x, y)) level = Math.min(level, 1);

  return Math.max(0, Math.min(4, level));
}

function tileType(x, y) {
  const lane = isPathTile(x, y);
  const moisture = smoothNoise(x, y, 18, 99);
  const clutter = smoothNoise(x, y, 7, 18);

  if (lane) return "cobble";
  if (waterStrength(x, y)) return "water";
  if (moisture > 0.68 && clutter > 0.45) return "moss";
  if (moisture < 0.24) return "dry";
  return "grass";
}

function isNearRoad(x, y) {
  return tileType(x, y) === "cobble" || tileType(x + 1, y) === "cobble" || tileType(x, y + 1) === "cobble";
}

function createChunk(cx, cy) {
  const tiles = [];
  const props = [];

  for (let ly = 0; ly < CHUNK_SIZE; ly += 1) {
    for (let lx = 0; lx < CHUNK_SIZE; lx += 1) {
      const x = cx * CHUNK_SIZE + lx;
      const y = cy * CHUNK_SIZE + ly;
      const type = tileType(x, y);
      const n = hash2(x, y, 33);
      const forest = smoothNoise(x + 100, y - 40, 10, 146);
      const scrub = smoothNoise(x - 90, y + 120, 6, 212);
      const stone = smoothNoise(x + 60, y + 15, 9, 260);
      const forage = smoothNoise(x - 20, y - 80, 8, 340);
      const pebble = smoothNoise(x + 200, y + 60, 5, 470);
      const level = terrainLevel(x, y);
      const shade = hash2(x, y, 5);
      const tile = {
        x,
        y,
        type,
        level,
        shade,
        fill: colorForTile(type, shade),
        // Neighbour heights cached once so the draw loop never recomputes terrain.
        lvlRight: terrainLevel(x + 1, y),
        lvlDown: terrainLevel(x, y + 1),
        lvlLeft: terrainLevel(x - 1, y),
        lvlUp: terrainLevel(x, y - 1),
      };
      if (type === "cobble") {
        const flecks = [];
        const count = 2 + Math.floor(shade * 3);
        for (let i = 0; i < count; i += 1) {
          const n = hash2(x * 11 + i, y * 7 - i, 17);
          const q = hash2(x * 5 - i, y * 13 + i, 19);
          flecks.push([(n - 0.5) * TILE_W * 0.7, TILE_H * 0.5 + (q - 0.5) * TILE_H * 0.55]);
        }
        tile.flecks = flecks;
        tile.fleckColor = shade > 0.5 ? "rgba(235, 154, 95, 0.24)" : "rgba(68, 46, 52, 0.2)";
      } else if (type === "grass" || type === "moss") {
        tile.detail = buildGrassDetail(x, y, shade, type === "moss" ? MOSS_PALETTE : GRASS_PALETTE);
      } else if (type === "dry") {
        tile.detail = buildDirtDetail(x, y, shade);
      }

      // Texture the exposed soil sides; grassy tiles also get an overhanging grass lip.
      if (type !== "water") {
        const grassy = type === "grass" || type === "moss";
        if (level > tile.lvlRight) tile.cliffR = buildCliffDetail(x, y, 1, (level - tile.lvlRight) * HEIGHT_STEP, grassy);
        if (level > tile.lvlDown) tile.cliffL = buildCliffDetail(x, y, -1, (level - tile.lvlDown) * HEIGHT_STEP, grassy);
      }
      tiles.push(tile);

      if (type !== "cobble" && type !== "water" && !isNearRoad(x, y) && forest > 0.6 && n > 0.78) {
        props.push({ x, y, level, kind: "tree", tint: hash2(x, y, 124), yield: "wood", yieldCount: 2, tool: "axe" });
      } else if (type !== "cobble" && type !== "water" && !isNearRoad(x, y) && stone > 0.68 && n > 0.86) {
        props.push({ x, y, level, kind: "rock", tint: hash2(x, y, 261), variant: Math.floor(hash2(x, y, 262) * 3), yield: "stone", yieldCount: 2, tool: "pickaxe" });
      } else if (type !== "cobble" && type !== "water" && !isNearRoad(x, y) && forage > 0.65 && n > 0.88) {
        props.push({ x, y, level, kind: "stickBush", tint: hash2(x, y, 341), variant: Math.floor(hash2(x, y, 342) * 3), yield: "stick", yieldCount: 1 });
      } else if (type !== "cobble" && type !== "water" && !isNearRoad(x, y) && pebble > 0.58 && hash2(x, y, 471) > 0.9) {
        props.push({ x, y, level, kind: "looseStone", tint: hash2(x, y, 472), yield: "stone", yieldCount: 1 });
      } else if (type !== "cobble" && type !== "water" && scrub > 0.5 && n > 0.74) {
        props.push({ x, y, level, kind: "bush", tint: hash2(x, y, 218), variant: Math.floor(hash2(x, y, 219) * 4) });
      }
    }
  }

  return { tiles, props };
}

function chunkKey(cx, cy) {
  return `${cx},${cy}`;
}

function getChunk(cx, cy) {
  const key = chunkKey(cx, cy);
  if (!chunks.has(key)) chunks.set(key, createChunk(cx, cy));
  return chunks.get(key);
}

function worldToScreen(x, y, z = 0) {
  return {
    x: Math.round((x - y) * (TILE_W / 2) - Math.round(camera.x) + width / 2),
    y: Math.round((x + y) * (TILE_H / 2) - z - Math.round(camera.y) + height / 2),
  };
}

function drawDiamond(x, y, fill, stroke) {
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + TILE_W / 2, y + TILE_H / 2);
  ctx.lineTo(x, y + TILE_H);
  ctx.lineTo(x - TILE_W / 2, y + TILE_H / 2);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  if (stroke) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 1;
    ctx.stroke();
  }
}

function drawCliffFace(top, bottom, side, ops) {
  if (bottom >= top) return;
  const drop = (top - bottom) * HEIGHT_STEP;
  const color = side === "right" ? "#42352b" : "#584537";
  ctx.fillStyle = color;
  const p1 = side === "right" ? { x: TILE_W / 2, y: TILE_H / 2 } : { x: -TILE_W / 2, y: TILE_H / 2 };
  const p2 = { x: 0, y: TILE_H };
  const p3 = { x: 0, y: TILE_H + drop };
  const p4 = side === "right" ? { x: TILE_W / 2, y: TILE_H / 2 + drop } : { x: -TILE_W / 2, y: TILE_H / 2 + drop };
  ctx.beginPath();
  ctx.moveTo(p1.x, p1.y);
  ctx.lineTo(p2.x, p2.y);
  ctx.lineTo(p3.x, p3.y);
  ctx.lineTo(p4.x, p4.y);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = "rgba(28, 20, 19, 0.45)";
  ctx.stroke();

  ctx.strokeStyle = "rgba(222, 188, 132, 0.14)";
  for (let z = HEIGHT_STEP; z < drop; z += HEIGHT_STEP) {
    ctx.beginPath();
    ctx.moveTo(p1.x, p1.y + z);
    ctx.lineTo(p2.x, p2.y + z);
    ctx.stroke();
  }

  if (ops) {
    for (let i = 0; i < ops.length; i += 1) {
      const o = ops[i];
      ctx.fillStyle = o[4];
      ctx.fillRect(o[0], o[1], o[2], o[3]);
    }
  }
}

function colorForTile(type, shade) {
  if (type === "water") return shade > 0.5 ? "#2f8e8d" : "#246f7f";
  if (type === "cobble") {
    const v = 92 + Math.floor(shade * 34);
    return `rgb(${v + 48},${v + 28},${v + 16})`;
  }
  if (type === "moss") return shade > 0.52 ? "#536434" : "#46562c";
  if (type === "dry") return shade > 0.48 ? "#806346" : "#71553d";
  return shade > 0.52 ? "#5e713a" : "#506431";
}

// ---- Ground surface texturing -------------------------------------------------
// Per-tile detail (positions + colours) is generated once at chunk creation and
// replayed as cheap fillRects in the draw loop, so the textured look is free per frame.

const GRASS_PALETTE = { dark: "#3c5125", mid: "#6c8a3a", bright: "#8cb04a", tip: "#bcd862", grain: "#7a9a40" };
const MOSS_PALETTE = { dark: "#2c3b1b", mid: "#536f2c", bright: "#789740", tip: "#9cbb4e", grain: "#5d7a33" };

function pointInDiamond(dx, dy, margin = 0.92) {
  return Math.abs(dx) / (TILE_W / 2) + Math.abs(dy - TILE_H / 2) / (TILE_H / 2) <= margin;
}

function buildGrassDetail(x, y, shade, pal) {
  const ops = [];
  const blades = 6 + Math.floor(hash2(x, y, 711) * 3); // 6-8 tufts
  for (let i = 0; i < blades; i += 1) {
    const a = hash2(x * 13 + i, y * 7 - i * 3, 712);
    const b = hash2(x * 5 - i * 2, y * 11 + i, 713);
    const dx = Math.round((a - 0.5) * TILE_W * 0.82);
    const dy = Math.round(TILE_H * 0.5 + (b - 0.5) * TILE_H * 0.72);
    if (!pointInDiamond(dx, dy)) continue;
    const r = hash2(x * 3 + i, y * 9 - i, 714);
    const h = 3 + Math.floor(r * 4); // 3-6 px tall
    ops.push([dx, dy - h, 1, h, pal.dark]); // shadowed blade body
    ops.push([dx, dy - h, 1, 2, r > 0.5 ? pal.bright : pal.mid]); // lit tip
    if (r > 0.45) ops.push([dx + 1, dy - h + 1, 1, h - 1, pal.mid]);
    if (r > 0.8) ops.push([dx - 1, dy - h, 1, 2, pal.tip]); // sparse golden highlight
  }
  const grains = 3 + Math.floor(shade * 3); // fine speckle for a grainy lawn
  for (let i = 0; i < grains; i += 1) {
    const a = hash2(x * 7 - i, y * 3 + i * 2, 715);
    const b = hash2(x * 9 + i * 3, y * 5 - i, 716);
    const dx = Math.round((a - 0.5) * TILE_W * 0.8);
    const dy = Math.round(TILE_H * 0.5 + (b - 0.5) * TILE_H * 0.66);
    if (!pointInDiamond(dx, dy)) continue;
    ops.push([dx, dy, 1, 1, a > 0.55 ? pal.grain : pal.dark]);
  }
  return ops;
}

function buildDirtDetail(x, y, shade) {
  const ops = [];
  const pebbles = 4 + Math.floor(hash2(x, y, 721) * 4); // 4-7 embedded stones
  for (let i = 0; i < pebbles; i += 1) {
    const a = hash2(x * 13 + i, y * 7 - i, 722);
    const b = hash2(x * 5 - i, y * 11 + i, 723);
    const s = hash2(x * 3 + i, y * 9 - i, 724);
    const dx = Math.round((a - 0.5) * TILE_W * 0.76);
    const dy = Math.round(TILE_H * 0.5 + (b - 0.5) * TILE_H * 0.66);
    if (!pointInDiamond(dx, dy)) continue;
    const w = 3 + Math.floor(s * 3); // 3-5 wide
    const h = 2 + Math.floor(s * 2); // 2-3 tall
    ops.push([dx - 1, dy + 1, w + 2, h, "#4a3c2c"]); // contact shadow
    ops.push([dx, dy, w, h, s < 0.5 ? "#8d8475" : "#a3957c"]); // stone body
    ops.push([dx + 1, dy - 1, Math.max(1, w - 2), 1, "#c8bca0"]); // sunlit top
  }
  const grains = 4 + Math.floor(shade * 3); // soil flecks
  for (let i = 0; i < grains; i += 1) {
    const a = hash2(x * 7 - i, y * 3 + i, 725);
    const b = hash2(x * 9 + i, y * 5 - i, 726);
    const dx = Math.round((a - 0.5) * TILE_W * 0.8);
    const dy = Math.round(TILE_H * 0.5 + (b - 0.5) * TILE_H * 0.66);
    if (!pointInDiamond(dx, dy)) continue;
    ops.push([dx, dy, 1, 1, a > 0.5 ? "#5c4631" : "#9c8c6c"]);
  }
  if (hash2(x, y, 727) > 0.62) { // a stray grass tuft breaking through the dirt
    const a = hash2(x, y, 728);
    const dx = Math.round((a - 0.5) * TILE_W * 0.45);
    const dy = Math.round(TILE_H * 0.56);
    ops.push([dx, dy - 4, 1, 4, "#46602a"]);
    ops.push([dx + 1, dy - 3, 1, 3, "#7a9a3c"]);
    ops.push([dx - 1, dy - 2, 1, 2, "#688838"]);
  }
  return ops;
}

function buildCliffDetail(x, y, dir, dropPx, grassy) {
  // dir = +1 (right face) or -1 (left face); ops are in the tile's local cliff space.
  const ops = [];
  const hw = TILE_W / 2;
  const hh = TILE_H / 2;
  const seed = dir > 0 ? 0 : 50;
  const stones = 2 + Math.floor(hash2(x, y, 730 + seed) * 3); // 2-4 stones in the soil
  for (let i = 0; i < stones; i += 1) {
    const a = hash2(x * 13 + i, y * 7 - i, 731 + seed);
    const b = hash2(x * 5 - i, y * 11 + i, 732 + seed);
    const s = hash2(x * 3 + i, y * 9 - i, 733 + seed);
    const u = 0.14 + a * 0.72; // along the top edge
    const v = 7 + b * Math.max(3, dropPx - 14); // depth down the face
    const px = Math.round(dir * hw * (1 - u));
    const py = Math.round(hh + hh * u + v);
    const w = 2 + Math.floor(s * 3);
    const h = 2 + Math.floor(s * 2);
    ops.push([px, py + 1, w, h, "#241b14"]);
    ops.push([px, py, w, h, s < 0.5 ? "#6c5945" : "#7c6a53"]);
    ops.push([px, py - 1, Math.max(1, w - 1), 1, "#9c8869"]);
  }
  if (grassy) { // tidy grassy fringe overhanging the top of the dirt face
    const tufts = 8;
    for (let i = 0; i <= tufts; i += 1) {
      const u = i / tufts;
      const px = Math.round(dir * hw * (1 - u));
      const py = Math.round(hh + hh * u);
      const h = 2 + Math.floor(hash2(x * 7 + i, y * 3 - i, 736 + seed) * 3); // short 2-4
      ops.push([px, py, 1, h, "#3c5125"]);
      ops.push([px + (dir > 0 ? 1 : -1), py, 1, Math.max(1, h - 1), "#6c8a3a"]);
      if (hash2(x - i, y + i, 738 + seed) > 0.45) ops.push([px, py, 1, 1, "#8cb04a"]);
    }
  }
  return ops;
}

function drawTile(tile) {
  const p = worldToScreen(tile.x, tile.y, tile.level * HEIGHT_STEP);
  ctx.save();
  ctx.translate(p.x, p.y);
  drawCliffFace(tile.level, tile.lvlRight, "right", tile.cliffR);
  drawCliffFace(tile.level, tile.lvlDown, "left", tile.cliffL);
  ctx.restore();

  // Water reads as a continuous surface, so it skips the per-tile grid outline.
  drawDiamond(p.x, p.y, tile.fill, tile.type === "water" ? null : "rgba(35, 24, 24, 0.32)");

  if (tile.type === "water") {
    const glint = Math.sin((tile.x - tile.y) * 0.7 + performance.now() * 0.0015) * 0.5 + 0.5;
    ctx.fillStyle = `rgba(139, 220, 206, ${0.18 + glint * 0.16})`;
    ctx.fillRect(Math.round(p.x - 14), Math.round(p.y + TILE_H * 0.48), 28, 2);
    ctx.fillStyle = "rgba(14, 48, 61, 0.28)";
    ctx.fillRect(Math.round(p.x - TILE_W * 0.28), Math.round(p.y + TILE_H * 0.66), Math.round(TILE_W * 0.56), 3);
  } else if (tile.type === "cobble") {
    ctx.fillStyle = tile.fleckColor;
    for (let i = 0; i < tile.flecks.length; i += 1) {
      const f = tile.flecks[i];
      ctx.fillRect(Math.round(p.x + f[0]), Math.round(p.y + f[1]), 2, 1);
    }
  } else if (tile.detail) {
    const d = tile.detail;
    for (let i = 0; i < d.length; i += 1) {
      const o = d[i];
      ctx.fillStyle = o[4];
      ctx.fillRect(p.x + o[0], p.y + o[1], o[2], o[3]);
    }
  }

  if (tile.level > tile.lvlLeft + 1 || tile.level > tile.lvlUp + 1) {
    ctx.strokeStyle = "rgba(21, 16, 16, 0.45)";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(p.x - TILE_W / 2 + 3, p.y + TILE_H / 2);
    ctx.lineTo(p.x, p.y + TILE_H - 2);
    ctx.lineTo(p.x + TILE_W / 2 - 3, p.y + TILE_H / 2);
    ctx.stroke();
    ctx.lineWidth = 1;
  }
}

function drawShadow(x, y, w, h, alpha = 0.25) {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(1, 0.45);
  ctx.fillStyle = `rgba(20, 11, 14, ${alpha})`;
  ctx.beginPath();
  ctx.ellipse(0, 0, w, h, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawPixelBlob(cx, cy, blocks, color) {
  ctx.fillStyle = color;
  blocks.forEach(([x, y, w, h]) => {
    ctx.fillRect(Math.round(cx + x), Math.round(cy + y), w, h);
  });
}

function drawTree(p, tint) {
  const lean = tint > 0.55 ? 5 : -3;
  const crownY = p.y - 78;
  const crownX = p.x + lean;

  ctx.fillStyle = "rgba(26, 17, 20, 0.34)";
  ctx.fillRect(Math.round(p.x - 8), Math.round(p.y + 24), 78, 12);
  ctx.fillRect(Math.round(p.x + 22), Math.round(p.y + 30), 42, 9);
  drawShadow(p.x + 18, p.y + 34, 44, 13, 0.25);

  ctx.fillStyle = "#442918";
  ctx.fillRect(Math.round(p.x - 8), Math.round(p.y - 36), 15, 66);
  ctx.fillStyle = "#5a331d";
  ctx.fillRect(Math.round(p.x - 15), Math.round(p.y - 8), 10, 35);
  ctx.fillRect(Math.round(p.x + 4), Math.round(p.y - 24), 9, 52);
  ctx.fillStyle = "#2d1d18";
  ctx.fillRect(Math.round(p.x + 6), Math.round(p.y - 32), 7, 61);
  ctx.fillRect(Math.round(p.x - 4), Math.round(p.y - 5), 5, 32);
  ctx.fillStyle = "#6d4327";
  ctx.fillRect(Math.round(p.x - 11), Math.round(p.y - 26), 5, 35);
  ctx.fillRect(Math.round(p.x - 21), Math.round(p.y + 18), 19, 8);
  ctx.fillStyle = "#3a2419";
  ctx.fillRect(Math.round(p.x + 6), Math.round(p.y + 20), 28, 8);

  ctx.fillStyle = "#4e321f";
  ctx.fillRect(Math.round(p.x - 8), Math.round(p.y - 48), 8, 32);
  ctx.fillRect(Math.round(p.x + 5), Math.round(p.y - 55), 8, 34);
  ctx.fillRect(Math.round(p.x - 22), Math.round(p.y - 43), 24, 8);
  ctx.fillRect(Math.round(p.x + 6), Math.round(p.y - 48), 27, 8);

  const darkBlocks = [
    [-38, -46, 74, 28],
    [-49, -31, 97, 38],
    [-58, -4, 108, 37],
    [-46, 25, 82, 26],
    [-20, 50, 42, 18],
    [24, -56, 33, 76],
    [40, -19, 28, 42],
  ];
  const midBlocks = [
    [-46, -62, 64, 32],
    [-70, -32, 72, 45],
    [-62, 2, 76, 44],
    [-31, 22, 78, 43],
    [-11, -73, 54, 38],
    [14, -50, 47, 43],
    [28, -11, 42, 36],
  ];
  const lightBlocks = [
    [-57, -37, 32, 24],
    [-35, -59, 34, 29],
    [-24, -18, 42, 30],
    [-47, 11, 36, 28],
    [7, -64, 30, 22],
    [13, -21, 38, 26],
    [2, 19, 33, 26],
  ];
  const goldBlocks = [
    [-60, -24, 18, 16],
    [-40, -51, 18, 16],
    [-11, -43, 18, 14],
    [18, -36, 20, 16],
    [-34, 14, 20, 17],
    [7, 4, 21, 16],
  ];

  drawPixelBlob(crownX, crownY, darkBlocks, "#14271d");
  drawPixelBlob(crownX - 4, crownY - 2, midBlocks, tint > 0.5 ? "#556235" : "#4d5a31");
  drawPixelBlob(crownX - 8, crownY - 5, lightBlocks, "#6e763e");
  drawPixelBlob(crownX - 10, crownY - 8, goldBlocks, "#a17336");

  ctx.fillStyle = "rgba(20, 31, 21, 0.5)";
  ctx.fillRect(Math.round(crownX + 32), Math.round(crownY - 43), 25, 65);
  ctx.fillRect(Math.round(crownX + 11), Math.round(crownY + 29), 30, 20);
  ctx.fillStyle = "rgba(233, 157, 67, 0.26)";
  ctx.fillRect(Math.round(crownX - 47), Math.round(crownY - 48), 29, 11);
  ctx.fillRect(Math.round(crownX - 22), Math.round(crownY - 19), 24, 10);
}

function drawBush(p, tint, variant) {
  const baseY = p.y + TILE_H * 0.62;
  drawShadow(p.x + 3, baseY + 8, variant === 3 ? 22 : 15, 7, 0.22);

  const dark = variant === 1 ? "#173321" : "#1e3b25";
  const mid = variant === 2 ? "#3f6a31" : "#49662f";
  const light = variant === 3 ? "#d4cf66" : "#6f8d42";
  const flower = tint > 0.72 ? "#b77db7" : tint < 0.2 ? "#d9d280" : "#8aa94f";

  if (variant === 0) {
    drawPixelBlob(p.x, baseY - 12, [[-18, 4, 36, 12], [-14, -4, 28, 13], [-7, -10, 20, 10], [8, 0, 15, 13]], dark);
    drawPixelBlob(p.x - 2, baseY - 15, [[-15, 3, 24, 12], [-8, -6, 18, 12], [6, -1, 14, 10]], mid);
    drawPixelBlob(p.x - 5, baseY - 18, [[-9, 2, 12, 7], [3, -4, 12, 7]], light);
  } else if (variant === 1) {
    ctx.fillStyle = dark;
    for (let i = 0; i < 9; i += 1) {
      const dx = -18 + i * 5;
      ctx.fillRect(Math.round(p.x + dx), Math.round(baseY - 8 - (i % 3) * 4), 5, 20 + (i % 2) * 6);
    }
    ctx.fillStyle = light;
    for (let i = 0; i < 5; i += 1) {
      ctx.fillRect(Math.round(p.x - 13 + i * 7), Math.round(baseY - 18 - (i % 2) * 3), 4, 8);
    }
  } else if (variant === 2) {
    drawPixelBlob(p.x, baseY - 10, [[-23, 5, 20, 12], [-11, -1, 25, 16], [9, 4, 21, 12], [-4, -10, 16, 11]], dark);
    drawPixelBlob(p.x - 3, baseY - 13, [[-18, 5, 18, 10], [-5, -2, 20, 12], [12, 5, 13, 9]], mid);
    ctx.fillStyle = flower;
    ctx.fillRect(Math.round(p.x - 9), Math.round(baseY - 17), 5, 5);
    ctx.fillRect(Math.round(p.x + 8), Math.round(baseY - 10), 5, 5);
  } else {
    drawPixelBlob(p.x, baseY - 12, [[-16, 1, 31, 17], [-10, -7, 24, 15], [5, 6, 18, 12]], "#4a6b2f");
    drawPixelBlob(p.x - 4, baseY - 13, [[-11, 4, 17, 10], [4, -3, 13, 10]], light);
    ctx.fillStyle = "#efe37b";
    ctx.fillRect(Math.round(p.x - 10), Math.round(baseY - 10), 6, 5);
    ctx.fillRect(Math.round(p.x), Math.round(baseY - 18), 6, 5);
    ctx.fillRect(Math.round(p.x + 10), Math.round(baseY - 7), 6, 5);
  }
}

function drawStickBush(p, tint, variant) {
  const baseY = p.y + TILE_H * 0.66;
  const scale = variant === 1 ? 1.35 : variant === 2 ? 1.15 : 1.25;
  const sx = (value) => value * scale;

  drawShadow(p.x + 4, baseY + 12, 32 * scale, 11, 0.28);

  const dark = tint > 0.5 ? "#1d3a23" : "#263f25";
  const mid = tint > 0.5 ? "#4f7434" : "#5b7839";
  const light = tint > 0.5 ? "#86a64c" : "#9ab458";
  const flowerDark = "#b45198";
  const flowerMid = "#e17ac5";
  const flowerLight = "#ffd1ef";

  drawPixelBlob(p.x, baseY - sx(24), [
    [-32, 11, 64, 22],
    [-25, -2, 52, 24],
    [-12, -16, 39, 22],
    [16, 2, 28, 23],
    [-42, 5, 26, 22],
  ].map(([x, y, w, h]) => [sx(x), sx(y), sx(w), sx(h)]), dark);

  drawPixelBlob(p.x - sx(4), baseY - sx(29), [
    [-25, 12, 45, 18],
    [-18, -3, 38, 20],
    [3, -13, 30, 19],
    [18, 8, 22, 18],
    [-35, 6, 22, 17],
  ].map(([x, y, w, h]) => [sx(x), sx(y), sx(w), sx(h)]), mid);

  drawPixelBlob(p.x - sx(9), baseY - sx(33), [
    [-21, 14, 21, 10],
    [-10, -2, 24, 11],
    [8, -12, 19, 10],
    [14, 9, 18, 10],
  ].map(([x, y, w, h]) => [sx(x), sx(y), sx(w), sx(h)]), light);

  const flowers = [
    [-25, -20],
    [-8, -31],
    [12, -25],
    [25, -9],
    [-34, 1],
    [4, -4],
  ];

  flowers.forEach(([x, y], index) => {
    const fx = Math.round(p.x + sx(x));
    const fy = Math.round(baseY + sx(y));
    ctx.fillStyle = flowerDark;
    ctx.fillRect(fx - 4, fy, 9, 6);
    ctx.fillStyle = flowerMid;
    ctx.fillRect(fx - 2, fy - 2, 8, 6);
    ctx.fillStyle = index % 2 === 0 ? flowerLight : "#f4a7dd";
    ctx.fillRect(fx + 1, fy - 1, 3, 3);
  });
}

function rockPalette(tint) {
  if (tint < 0.33) return { deep: "#181a1b", dark: "#282b2c", mid: "#414445", face: "#5b5e5e", light: "#858888" };
  if (tint < 0.66) return { deep: "#1d1d1f", dark: "#303235", mid: "#4a4d50", face: "#686b6b", light: "#969998" };
  return { deep: "#151719", dark: "#25282b", mid: "#393d40", face: "#55595c", light: "#7f8385" };
}

function drawRockBlock(x, y, w, h, colors, cut = 0) {
  const rx = Math.round(x);
  const ry = Math.round(y);
  ctx.fillStyle = colors.deep;
  ctx.fillRect(rx - 3, ry + 8, w + 6, h - 2);
  ctx.fillStyle = colors.dark;
  ctx.fillRect(rx, ry + 4, w, h);
  ctx.fillStyle = colors.mid;
  ctx.fillRect(rx + 2 + cut, ry, Math.max(4, w - 5 - cut), Math.max(5, h - 5));
  ctx.fillStyle = colors.face;
  ctx.fillRect(rx + 6 + cut, ry + 3, Math.max(5, Math.floor(w * 0.45)), Math.max(3, Math.floor(h * 0.28)));
  ctx.fillStyle = colors.light;
  ctx.fillRect(rx + 8 + cut, ry + 2, Math.max(7, Math.floor(w * 0.38)), 3);
  ctx.fillStyle = "rgba(12, 13, 14, 0.36)";
  ctx.fillRect(rx + w - 6, ry + 10, 4, Math.max(8, h - 10));
}

function drawRock(p, tint, variant) {
  const colors = rockPalette(tint);
  const baseY = p.y + TILE_H * 0.72;
  const scale = variant === 1 ? 1.15 : variant === 2 ? 0.92 : 1;
  const sx = (value) => value * scale;

  drawShadow(p.x + 3, baseY + 8, 36 * scale, 13, 0.34);
  ctx.fillStyle = "rgba(11, 12, 13, 0.32)";
  ctx.fillRect(Math.round(p.x - sx(43)), Math.round(baseY + 4), Math.round(sx(88)), 8);

  drawRockBlock(p.x - sx(37), baseY - sx(30), sx(29), sx(42), colors, 0);
  drawRockBlock(p.x + sx(14), baseY - sx(34), sx(31), sx(43), colors, 2);
  drawRockBlock(p.x - sx(13), baseY - sx(44), sx(36), sx(48), colors, 1);
  drawRockBlock(p.x - sx(2), baseY - sx(68), sx(31), sx(31), colors, 3);
  drawRockBlock(p.x - sx(25), baseY - sx(11), sx(33), sx(31), colors, 1);

  ctx.fillStyle = colors.deep;
  ctx.fillRect(Math.round(p.x - sx(18)), Math.round(baseY - sx(40)), Math.round(sx(9)), Math.round(sx(30)));
  ctx.fillRect(Math.round(p.x + sx(18)), Math.round(baseY - sx(51)), Math.round(sx(8)), Math.round(sx(35)));
  ctx.fillRect(Math.round(p.x - sx(2)), Math.round(baseY - sx(18)), Math.round(sx(7)), Math.round(sx(28)));

  ctx.fillStyle = colors.light;
  ctx.fillRect(Math.round(p.x - sx(8)), Math.round(baseY - sx(61)), Math.round(sx(23)), 4);
  ctx.fillRect(Math.round(p.x - sx(25)), Math.round(baseY - sx(27)), Math.round(sx(18)), 4);
  ctx.fillRect(Math.round(p.x + sx(15)), Math.round(baseY - sx(21)), Math.round(sx(19)), 4);

  ctx.fillStyle = "rgba(180, 184, 184, 0.18)";
  ctx.fillRect(Math.round(p.x - sx(2)), Math.round(baseY - sx(34)), Math.round(sx(10)), 4);
  ctx.fillRect(Math.round(p.x - sx(31)), Math.round(baseY - sx(17)), Math.round(sx(8)), 4);
}

function drawProp(prop) {
  const p = worldToScreen(prop.x, prop.y, prop.level * HEIGHT_STEP);
  const gone = isDepleted(prop.x, prop.y);
  if (prop.kind === "tree") {
    if (gone) drawTreeStump(p);
    else drawTree(p, prop.tint);
  }
  if (prop.kind === "bush") drawBush(p, prop.tint, prop.variant);
  if (prop.kind === "stickBush") {
    if (gone) drawPickedBush(p);
    else drawStickBush(p, prop.tint, prop.variant);
  }
  if (prop.kind === "looseStone" && !gone) drawLooseStone(p, prop.tint);
  if (prop.kind === "rock") {
    if (gone) drawRockRubble(p, prop.tint);
    else drawRock(p, prop.tint, prop.variant);
  }
}

// Left behind after a tree is chopped; regrows on the resource timer.
function drawTreeStump(p) {
  const baseY = p.y + 26;
  drawShadow(p.x + 6, baseY + 6, 20, 8, 0.28);
  ctx.fillStyle = "#3a2419";
  ctx.fillRect(Math.round(p.x - 10), Math.round(baseY - 10), 22, 16);
  ctx.fillStyle = "#5a371d";
  ctx.fillRect(Math.round(p.x - 10), Math.round(baseY - 13), 22, 6);
  ctx.fillStyle = "#7a4d27";
  ctx.fillRect(Math.round(p.x - 8), Math.round(baseY - 13), 18, 3); // cut top
  ctx.fillStyle = "#caa05a"; // rings
  ctx.fillRect(Math.round(p.x - 3), Math.round(baseY - 12), 8, 1);
  ctx.fillStyle = "#9a6a32";
  ctx.fillRect(Math.round(p.x - 1), Math.round(baseY - 12), 3, 1);
  ctx.fillStyle = "#3a2419"; // chips on the ground
  ctx.fillRect(Math.round(p.x - 16), Math.round(baseY + 3), 4, 2);
  ctx.fillRect(Math.round(p.x + 14), Math.round(baseY + 1), 4, 2);
}

// Left behind after a rock is mined.
function drawRockRubble(p, tint) {
  const colors = rockPalette(tint);
  const baseY = p.y + TILE_H * 0.66;
  drawShadow(p.x + 2, baseY + 6, 22, 7, 0.3);
  const r = (x, y, w, h, c) => {
    ctx.fillStyle = c;
    ctx.fillRect(Math.round(p.x + x), Math.round(baseY + y), w, h);
  };
  r(-16, -1, 13, 8, colors.dark);
  r(-16, -4, 13, 6, colors.mid);
  r(-14, -4, 6, 2, colors.light);
  r(1, 1, 12, 7, colors.dark);
  r(1, -2, 12, 6, colors.mid);
  r(3, -2, 5, 2, colors.light);
  r(-4, 4, 7, 3, colors.mid);
}

function drawPlayer() {
  const p = worldToScreen(player.x, player.y, player.z);
  const dir = player.facing;
  const gait = player.gait || 0;

  const cycle = player.step * 0.8; // walk phase
  const stride = Math.sin(cycle);
  const breath = Math.sin(animTime * 2.3); // idle breathing

  // Body rises twice per stride while walking; gentle breathing while idle.
  const bodyBob = -Math.abs(Math.sin(cycle)) * 2.6 * gait + (1 - gait) * (breath * 0.9 - 0.3);
  const sway = stride * 1.5 * gait + (1 - gait) * breath * 0.5; // weight shift
  const lean = dir * 1.1 * gait; // lean into the direction of travel

  const px = Math.round(p.x + sway + lean);
  const py = Math.round(p.y - 40 + bodyBob);

  const shadowScale = 1 - gait * 0.12 - Math.abs(bodyBob) * 0.02;
  drawShadow(p.x, p.y + 1, 13 * shadowScale, 6.5 * shadowScale, 0.32);

  const rect = (c, x, y, w, h) => {
    ctx.fillStyle = c;
    ctx.fillRect(Math.round(x), Math.round(y), w, h);
  };

  // ---- Legs (behind the torso) ----------------------------------------------
  const drawLeg = (hipX, phase) => {
    const lift = Math.max(0, Math.sin(phase)) * 7 * gait;
    const shift = Math.cos(phase) * 3 * gait;
    const hipY = py + 16;
    // Feet are anchored to the ground and only rise during their swing, so the
    // body can bob without the planted foot lifting off (no floating).
    const footY = p.y - 4 - lift;
    const len = Math.max(4, footY - hipY);
    rect("#315d91", hipX - 3, hipY, 6, len); // trouser
    rect("#264a75", hipX - 3, hipY, 2, len); // inner shadow
    rect("#3f72ad", hipX + 2, hipY, 1, len); // outer highlight
    const bx = hipX - 4 + shift;
    rect("#5a3a20", bx, footY, 9, 4); // boot
    rect("#3f2914", bx, footY + 4, 9, 2); // sole
    rect("#a5743d", dir > 0 ? bx + 4 : bx, footY, 4, 2); // boot sheen
  };
  // Step the trailing leg first so the leading (lifted) leg overlaps in front.
  if (stride >= 0) {
    drawLeg(px + 4, cycle + Math.PI);
    drawLeg(px - 4, cycle);
  } else {
    drawLeg(px - 4, cycle);
    drawLeg(px + 4, cycle + Math.PI);
  }

  // ---- Torso ----------------------------------------------------------------
  rect("#f1ead7", px - 9, py - 6, 18, 23); // shirt
  rect("#d6cdb6", px - 9, py - 6, 3, 23); // left shade
  rect("#fff7e6", px + 7, py - 5, 2, 21); // right highlight
  rect("#c46437", px - 3, py - 5, 6, 23); // placket
  rect("#a8542d", px - 3, py - 5, 2, 23); // placket shadow
  rect("#5a3a20", px - 9, py + 14, 18, 4); // belt
  rect("#8a5a30", px - 2, py + 14, 4, 4); // buckle

  // ---- Arms (swing counter to the legs) -------------------------------------
  const drawArm = (shoulderX, phase, lightSide) => {
    const dx = Math.round(Math.cos(phase) * 2.5 * gait);
    const dy = Math.round(-Math.abs(Math.cos(phase)) * 1.5 * gait + (1 - gait) * breath * 0.4);
    rect("#8f4c32", shoulderX, py - 4 + dy, 5, 12); // sleeve
    rect(lightSide > 0 ? "#a85b3c" : "#743c28", shoulderX + (lightSide > 0 ? 3 : 0), py - 4 + dy, 2, 12);
    rect("#d89765", shoulderX + dx, py + 8 + dy, 5, 6); // hand
    rect("#b97b50", shoulderX + dx, py + 12 + dy, 5, 2); // hand shade
  };
  drawArm(px - 13, cycle + Math.PI, -1); // left arm opposite the left leg
  drawArm(px + 8, cycle, 1);

  // ---- Head -----------------------------------------------------------------
  rect("#b97b50", px - 3, py - 7, 6, 3); // neck
  rect("#2b1d1b", px - 8, py - 22, 16, 18); // hair / back of head
  rect("#d89765", px - 7, py - 19, 14, 14); // face
  rect("#b97b50", px - 7, py - 19, 3, 14); // left cheek shadow
  rect("#e8a875", px + 4, py - 18, 3, 11); // right cheek light
  rect("#b97b50", dir > 0 ? px - 8 : px + 6, py - 14, 2, 4); // ear (back side)
  rect("#3a2422", px - 5, py - 8, 11, 4); // beard / jaw
  rect("#3a2422", px - 2, py - 5, 7, 2); // chin

  const eyeOpen = animTime % 3.4 > 0.16; // occasional blink
  ctx.fillStyle = "#241a18";
  if (eyeOpen) {
    rect("#241a18", px - 3 + dir, py - 14, 2, 2);
    rect("#241a18", px + 2 + dir, py - 14, 2, 2);
  } else {
    rect("#3a2422", px - 3 + dir, py - 13, 2, 1);
    rect("#3a2422", px + 2 + dir, py - 13, 2, 1);
  }
  rect("#b97b50", px + dir, py - 12, 2, 2); // nose

  // ---- Cap ------------------------------------------------------------------
  rect("#d64b3a", px - 8, py - 27, 16, 7); // lower crown
  rect("#d64b3a", px - 6, py - 32, 12, 6); // upper crown
  rect("#e86b54", px - 6, py - 32, 11, 2); // top highlight
  rect("#b23a2c", px - 8, py - 22, 16, 2); // crown shadow rim
  rect("#b23a2c", dir > 0 ? px + 7 : px - 13, py - 22, 6, 3); // brim
  rect("#f0d58b", px - 8, py - 22, 16, 1); // hatband
}

function drawVignette() {
  if (vignette) ctx.drawImage(vignette, 0, 0, width, height);
}

// ---- Minimap ------------------------------------------------------------------
const MM_RADIUS = 76; // minimap radius (CSS px)
const MM_MARGIN = 20; // distance from the screen corner
const MM_SPAN = 22; // half-width of the view, in tiles
const MM_SCALE = MM_RADIUS / MM_SPAN; // pixels per tile
const MM_PAD = Math.ceil(MM_SCALE) + 2; // overscan so sub-tile scrolling shows no gaps
const MM_CELL = Math.ceil(MM_SCALE) + 1;
let minimapCanvas = null;
let minimapCtx = null;
let mmTileX = NaN;
let mmTileY = NaN;

function mmTileColor(type, tx, ty) {
  const h = hash2(tx, ty, 777);
  switch (type) {
    case "water":
      return h > 0.6 ? "#6fa6c4" : "#5b91b4";
    case "cobble":
      return h > 0.55 ? "#d4caa4" : "#c3b58c";
    case "moss":
      return h > 0.6 ? "#3f6633" : "#365a2c";
    case "dry":
      return h > 0.6 ? "#a48655" : "#9c7f50";
    default:
      return h > 0.7 ? "#56894a" : h < 0.25 ? "#447338" : "#4d7d40";
  }
}

function renderMinimapTerrain(centerTX, centerTY) {
  const size = MM_RADIUS * 2 + MM_PAD * 2;
  if (!minimapCanvas) {
    minimapCanvas = document.createElement("canvas");
    minimapCanvas.width = size;
    minimapCanvas.height = size;
    minimapCtx = minimapCanvas.getContext("2d");
    minimapCtx.imageSmoothingEnabled = false;
  }
  const c = minimapCtx;
  c.clearRect(0, 0, size, size);
  const origin = MM_RADIUS + MM_PAD;

  // Terrain
  for (let ty = centerTY - MM_SPAN - 1; ty <= centerTY + MM_SPAN + 1; ty += 1) {
    for (let tx = centerTX - MM_SPAN - 1; tx <= centerTX + MM_SPAN + 1; tx += 1) {
      c.fillStyle = mmTileColor(tileType(tx, ty), tx, ty);
      const mx = Math.round(origin + (tx - centerTX) * MM_SCALE);
      const my = Math.round(origin + (ty - centerTY) * MM_SCALE);
      c.fillRect(mx, my, MM_CELL, MM_CELL);
    }
  }

  // Props (read from cached chunks; the minimap view sits inside the loaded area)
  const cMin = Math.floor((centerTX - MM_SPAN) / CHUNK_SIZE);
  const cMax = Math.floor((centerTX + MM_SPAN) / CHUNK_SIZE);
  const rMin = Math.floor((centerTY - MM_SPAN) / CHUNK_SIZE);
  const rMax = Math.floor((centerTY + MM_SPAN) / CHUNK_SIZE);
  for (let cy = rMin; cy <= rMax; cy += 1) {
    for (let cx = cMin; cx <= cMax; cx += 1) {
      const chunk = getChunk(cx, cy);
      for (let i = 0; i < chunk.props.length; i += 1) {
        const pr = chunk.props[i];
        if (Math.abs(pr.x - centerTX) > MM_SPAN || Math.abs(pr.y - centerTY) > MM_SPAN) continue;
        const mx = Math.round(origin + (pr.x - centerTX) * MM_SCALE);
        const my = Math.round(origin + (pr.y - centerTY) * MM_SCALE);
        if (pr.kind === "bush" || pr.kind === "stickBush") {
          c.fillStyle = "#5e2d6e";
          c.fillRect(mx - 1, my - 1, 4, 4);
          c.fillStyle = "#8a4499";
          c.fillRect(mx, my - 1, 2, 2);
        } else if (pr.kind === "tree") {
          c.fillStyle = "#274b22";
          c.fillRect(mx - 1, my - 1, 4, 4);
          c.fillStyle = "#356b2c";
          c.fillRect(mx, my - 1, 2, 2);
        } else if (pr.kind === "rock") {
          c.fillStyle = "#6c6c70";
          c.fillRect(mx - 1, my, 3, 3);
        }
      }
    }
  }
}

function drawMinimap() {
  const cx = width - MM_MARGIN - MM_RADIUS;
  const cy = height - MM_MARGIN - MM_RADIUS;
  const ptx = Math.floor(player.x);
  const pty = Math.floor(player.y);
  if (ptx !== mmTileX || pty !== mmTileY) {
    renderMinimapTerrain(ptx, pty);
    mmTileX = ptx;
    mmTileY = pty;
  }

  // Soft drop shadow under the dial.
  ctx.fillStyle = "rgba(8, 6, 10, 0.45)";
  ctx.beginPath();
  ctx.arc(cx, cy + 3, MM_RADIUS + 4, 0, Math.PI * 2);
  ctx.fill();

  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, MM_RADIUS, 0, Math.PI * 2);
  ctx.closePath();
  ctx.fillStyle = "#3a5e34"; // backdrop for the circle's corners
  ctx.fill();
  ctx.clip();

  // Blit the cached terrain, offset by the player's sub-tile position for smooth scroll.
  const fracX = (player.x - (ptx + 0.5)) * MM_SCALE;
  const fracY = (player.y - (pty + 0.5)) * MM_SCALE;
  ctx.drawImage(minimapCanvas, cx - MM_RADIUS - MM_PAD - fracX, cy - MM_RADIUS - MM_PAD - fracY);

  // Player marker (arrow points along the world-space heading).
  ctx.translate(cx, cy);
  ctx.rotate(player.heading);
  ctx.beginPath();
  ctx.moveTo(8, 0);
  ctx.lineTo(-5, -5);
  ctx.lineTo(-2, 0);
  ctx.lineTo(-5, 5);
  ctx.closePath();
  ctx.fillStyle = "#e0503e";
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = "#3a1310";
  ctx.stroke();
  ctx.restore();

  // Border ring.
  ctx.beginPath();
  ctx.arc(cx, cy, MM_RADIUS, 0, Math.PI * 2);
  ctx.lineWidth = 6;
  ctx.strokeStyle = "#c0503e";
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(cx, cy, MM_RADIUS + 2.5, 0, Math.PI * 2);
  ctx.lineWidth = 2;
  ctx.strokeStyle = "#7e2f25";
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(cx, cy, MM_RADIUS - 2.5, 0, Math.PI * 2);
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = "rgba(20, 12, 14, 0.3)";
  ctx.stroke();
}

// ---- Harvesting & inventory ---------------------------------------------------
const HARVEST_REACH = 1.4; // tiles
const GATHER_TIME = 0.5; // seconds to hold E
const REGROW_SECONDS = 300; // how long a picked resource stays depleted (tune freely)
const FLOATER_LIFE = 1.2;
const GATHER_VERB = { stickBush: "Harvest", looseStone: "Gather", tree: "Chop", rock: "Mine" };

const inventory = {}; // itemId -> count
const depleted = new Map(); // "x,y" -> animTime at which it regrows
const floaters = []; // { wx, wy, wz, text, age }
let inventoryOpen = false;
let harvestTarget = null;
let gatherKey = null;
let gatherProgress = 0;

// Crafting. station "none" = craftable by hand; "table" = needs a Crafting Table.
// (For now "having a table" satisfies it; once tables can be placed, it becomes "near a table".)
const RECIPES = [
  { id: "axe", cost: { stick: 3, stone: 2 }, makes: 1, station: "none" },
  { id: "pickaxe", cost: { stick: 3, stone: 3 }, makes: 1, station: "none" },
  { id: "spear", cost: { stick: 4, stone: 1 }, makes: 1, station: "none" },
  { id: "table", cost: { wood: 4, stick: 2 }, makes: 1, station: "none" },
  { id: "campfire", cost: { wood: 3, stone: 3 }, makes: 1, station: "table" },
];
let activeTab = "items"; // "items" | "craft"
let craftSel = 0;
let craftMsg = "";
let craftMsgTime = 0;

function hasStation(station) {
  if (station === "none") return true;
  if (station === "table") return (inventory.table || 0) > 0;
  return false;
}

function canAfford(recipe) {
  return Object.keys(recipe.cost).every((id) => (inventory[id] || 0) >= recipe.cost[id]);
}

function craftSelected() {
  const recipe = RECIPES[craftSel];
  if (!recipe) return;
  if (!hasStation(recipe.station)) {
    craftMsg = `Needs a ${ITEM_LABELS.table}`;
    craftMsgTime = 2;
    return;
  }
  if (!canAfford(recipe)) {
    craftMsg = "Not enough materials";
    craftMsgTime = 2;
    return;
  }
  Object.keys(recipe.cost).forEach((id) => {
    inventory[id] -= recipe.cost[id];
  });
  addItem(recipe.id, recipe.makes);
  craftMsg = `Crafted ${ITEM_LABELS[recipe.id]}`;
  craftMsgTime = 2;
}

function addItem(id, n) {
  inventory[id] = (inventory[id] || 0) + n;
}

function isDepleted(x, y) {
  const k = `${x},${y}`;
  const t = depleted.get(k);
  if (t === undefined) return false;
  if (animTime >= t) {
    depleted.delete(k);
    return false;
  }
  return true;
}

function hasToolFor(prop) {
  return !prop.tool || (inventory[prop.tool] || 0) > 0;
}

function findHarvestTarget() {
  const tx = Math.floor(player.x);
  const ty = Math.floor(player.y);
  let best = null;
  let bestDist = HARVEST_REACH * HARVEST_REACH;
  let locked = null;
  let lockedDist = HARVEST_REACH * HARVEST_REACH;
  for (let cy = Math.floor((ty - 2) / CHUNK_SIZE); cy <= Math.floor((ty + 2) / CHUNK_SIZE); cy += 1) {
    for (let cx = Math.floor((tx - 2) / CHUNK_SIZE); cx <= Math.floor((tx + 2) / CHUNK_SIZE); cx += 1) {
      const chunk = getChunk(cx, cy);
      for (let i = 0; i < chunk.props.length; i += 1) {
        const pr = chunk.props[i];
        if (!pr.yield || isDepleted(pr.x, pr.y)) continue;
        const dx = player.x - (pr.x + 0.5);
        const dy = player.y - (pr.y + 0.5);
        const d = dx * dx + dy * dy;
        if (hasToolFor(pr)) {
          if (d < bestDist) {
            bestDist = d;
            best = pr;
          }
        } else if (d < lockedDist) {
          lockedDist = d;
          locked = pr;
        }
      }
    }
  }
  // Prefer something you can actually harvest; otherwise surface the locked one for its hint.
  return best || locked;
}

function harvest(prop) {
  depleted.set(`${prop.x},${prop.y}`, animTime + REGROW_SECONDS);
  const id = prop.yield || "stick";
  const n = prop.yieldCount || 1;
  addItem(id, n);
  floaters.push({ wx: prop.x, wy: prop.y, wz: prop.level * HEIGHT_STEP, text: `+${n} ${ITEM_LABELS[id] || id}`, age: 0 });
}

function updateHarvest(dt) {
  harvestTarget = inventoryOpen ? null : findHarvestTarget();

  const key = harvestTarget ? `${harvestTarget.x},${harvestTarget.y}` : null;
  if (harvestTarget && keys.has("e") && hasToolFor(harvestTarget)) {
    if (gatherKey !== key) {
      gatherKey = key;
      gatherProgress = 0;
    }
    gatherProgress += dt;
    if (gatherProgress >= GATHER_TIME) {
      harvest(harvestTarget);
      gatherProgress = 0;
      gatherKey = null;
      harvestTarget = null;
    }
  } else {
    gatherProgress = Math.max(0, gatherProgress - dt * 2.5);
    if (gatherProgress === 0) gatherKey = null;
  }

  for (let i = floaters.length - 1; i >= 0; i -= 1) {
    floaters[i].age += dt;
    if (floaters[i].age >= FLOATER_LIFE) floaters.splice(i, 1);
  }

  if (craftMsgTime > 0) craftMsgTime -= dt;
}

// Discrete key handling while the inventory/craft panel is open.
function handlePanelKey(k) {
  if (k === "escape") {
    inventoryOpen = false;
    return;
  }
  if (k === "arrowleft" || k === "a" || k === "arrowright" || k === "d" || k === "tab") {
    activeTab = activeTab === "items" ? "craft" : "items";
    return;
  }
  if (activeTab !== "craft") return;
  if (k === "arrowup" || k === "w") craftSel = (craftSel - 1 + RECIPES.length) % RECIPES.length;
  else if (k === "arrowdown" || k === "s") craftSel = (craftSel + 1) % RECIPES.length;
  else if (k === "enter" || k === " ") craftSelected();
}

function roundRectPath(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// A small, stubby remnant left where a stickBush was picked.
function drawPickedBush(p) {
  const baseY = p.y + TILE_H * 0.66;
  drawShadow(p.x + 3, baseY + 9, 16, 6, 0.2);
  drawPixelBlob(p.x, baseY - 5, [[-12, 2, 24, 8], [-7, -3, 16, 8], [5, 0, 9, 7]], "#39482a");
  drawPixelBlob(p.x - 2, baseY - 8, [[-8, 1, 13, 5], [4, -1, 8, 5]], "#4f6630");
  ctx.fillStyle = "#6b5436";
  ctx.fillRect(Math.round(p.x - 4), Math.round(baseY - 12), 1, 7);
  ctx.fillRect(Math.round(p.x + 2), Math.round(baseY - 14), 1, 9);
}

// Forageable cluster of small stones lying on the ground.
function drawLooseStone(p, tint) {
  const baseY = p.y + TILE_H * 0.6;
  const warm = tint > 0.6;
  const dark = warm ? "#4a4641" : "#46464a";
  const mid = warm ? "#746e64" : "#6c6c72";
  const light = warm ? "#9a9085" : "#8f8f96";
  drawShadow(p.x + 2, baseY + 5, 13, 5, 0.26);
  const r = (x, y, w, h, c) => {
    ctx.fillStyle = c;
    ctx.fillRect(Math.round(p.x + x), Math.round(baseY + y), w, h);
  };
  // larger stone
  r(-9, -1, 14, 7, dark);
  r(-9, -4, 14, 6, mid);
  r(-7, -4, 7, 2, light);
  // smaller stone beside it
  r(4, 1, 9, 5, dark);
  r(4, -1, 9, 4, mid);
  r(5, -1, 4, 2, light);
  // pebble
  r(-2, 4, 5, 3, mid);
}

function drawHarvestUI() {
  if (!harvestTarget) return;
  const p = worldToScreen(harvestTarget.x, harvestTarget.y, harvestTarget.level * HEIGHT_STEP);
  const baseY = p.y + TILE_H * 0.66;

  // Soft highlight ring under the targeted bush.
  ctx.save();
  ctx.translate(p.x + 3, baseY + 8);
  ctx.scale(1, 0.45);
  ctx.beginPath();
  ctx.arc(0, 0, 24, 0, Math.PI * 2);
  ctx.strokeStyle = "rgba(255, 232, 150, 0.6)";
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.restore();

  const cx = p.x;
  const cy = p.y - 50;
  if (!hasToolFor(harvestTarget)) {
    drawLockedPrompt(cx, cy, `${ITEM_LABELS[harvestTarget.tool] || harvestTarget.tool} needed`);
  } else if (gatherProgress > 0) {
    const frac = Math.min(1, gatherProgress / GATHER_TIME);
    ctx.beginPath();
    ctx.arc(cx, cy, 11, 0, Math.PI * 2);
    ctx.lineWidth = 4;
    ctx.strokeStyle = "rgba(20, 14, 16, 0.6)";
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, 11, -Math.PI / 2, -Math.PI / 2 + frac * Math.PI * 2);
    ctx.lineWidth = 4;
    ctx.strokeStyle = "#f1cf57";
    ctx.lineCap = "round";
    ctx.stroke();
    ctx.lineCap = "butt";
  } else {
    drawKeyPrompt(cx, cy, "E", GATHER_VERB[harvestTarget.kind] || "Gather");
  }
}

function drawLockedPrompt(cx, cy, label) {
  ctx.font = "600 12px ui-sans-serif, system-ui, sans-serif";
  const w = ctx.measureText(label).width + 26;
  const h = 22;
  const x = Math.round(cx - w / 2);
  const y = Math.round(cy - h / 2);
  roundRectPath(x, y - 4, w, h, 6);
  ctx.fillStyle = "rgba(22, 17, 19, 0.8)";
  ctx.fill();
  ctx.strokeStyle = "rgba(0, 0, 0, 0.45)";
  ctx.lineWidth = 1;
  ctx.stroke();
  // small lock glyph
  ctx.fillStyle = "rgba(224, 121, 95, 0.95)";
  ctx.fillRect(x + 8, y + 6, 7, 6);
  ctx.strokeStyle = "rgba(224, 121, 95, 0.95)";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(x + 11.5, y + 6, 2.4, Math.PI, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = "rgba(241, 234, 215, 0.9)";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(label, x + 20, y + h / 2 - 3);
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
}

function drawKeyPrompt(cx, cy, key, label) {
  ctx.font = "600 12px ui-sans-serif, system-ui, sans-serif";
  const labelW = ctx.measureText(label).width;
  const cap = 16;
  const padX = 7;
  const gap = 6;
  const w = padX + cap + gap + labelW + padX;
  const h = 22;
  const x = Math.round(cx - w / 2);
  const y = Math.round(cy - h / 2);

  roundRectPath(x, y - 4, w, h, 6);
  ctx.fillStyle = "rgba(22, 17, 19, 0.85)";
  ctx.fill();
  ctx.strokeStyle = "rgba(0, 0, 0, 0.5)";
  ctx.lineWidth = 1;
  ctx.stroke();

  roundRectPath(x + padX, y - 4 + (h - cap) / 2, cap, cap, 3);
  ctx.fillStyle = "#efe7d4";
  ctx.fill();
  ctx.fillStyle = "#241a18";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = "700 11px ui-sans-serif, sans-serif";
  ctx.fillText(key, x + padX + cap / 2, y - 4 + h / 2 + 1);

  ctx.fillStyle = "#f1ead7";
  ctx.textAlign = "left";
  ctx.font = "600 12px ui-sans-serif, sans-serif";
  ctx.fillText(label, x + padX + cap + gap, y - 4 + h / 2 + 1);
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
}

function drawFloaters() {
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = "700 13px ui-sans-serif, system-ui, sans-serif";
  for (let i = 0; i < floaters.length; i += 1) {
    const f = floaters[i];
    const a = 1 - f.age / FLOATER_LIFE;
    if (a <= 0) continue;
    const p = worldToScreen(f.wx, f.wy, f.wz);
    const y = p.y - 44 - f.age * 26;
    ctx.globalAlpha = a;
    ctx.lineWidth = 3;
    ctx.strokeStyle = "rgba(0, 0, 0, 0.6)";
    ctx.strokeText(f.text, p.x, y);
    ctx.fillStyle = "#ffe6a0";
    ctx.fillText(f.text, p.x, y);
  }
  ctx.globalAlpha = 1;
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
}

function drawStickIcon(cx, cy) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(-0.6);
  ctx.fillStyle = "#7a5a32";
  ctx.fillRect(-2, -13, 4, 26);
  ctx.fillStyle = "#9a7440";
  ctx.fillRect(-2, -13, 2, 26);
  ctx.fillStyle = "#5c4326";
  ctx.fillRect(-3, -6, 6, 3); // branch nub
  ctx.fillRect(-1, 4, 5, 3);
  ctx.restore();
}

function drawStoneIcon(cx, cy) {
  const r = (x, y, w, h, c) => {
    ctx.fillStyle = c;
    ctx.fillRect(Math.round(cx + x), Math.round(cy + y), w, h);
  };
  r(-9, 0, 18, 6, "#46464a");
  r(-9, -4, 18, 7, "#6c6c72");
  r(-7, -4, 9, 3, "#8f8f96");
  r(-3, -1, 5, 2, "#54545a");
}

function drawAxeIcon(cx, cy) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(0.35);
  ctx.fillStyle = "#7a5a32"; // handle
  ctx.fillRect(-2, -10, 4, 22);
  ctx.fillStyle = "#9a7440";
  ctx.fillRect(-2, -10, 2, 22);
  ctx.fillStyle = "#8f9296"; // head
  ctx.fillRect(-12, -12, 13, 11);
  ctx.fillStyle = "#bfc2c4";
  ctx.fillRect(-12, -12, 13, 3);
  ctx.fillStyle = "#6a6d70";
  ctx.fillRect(-12, -3, 13, 2);
  ctx.restore();
}

function drawPickaxeIcon(cx, cy) {
  const r = (x, y, w, h, c) => {
    ctx.fillStyle = c;
    ctx.fillRect(Math.round(cx + x), Math.round(cy + y), w, h);
  };
  r(-1, -8, 4, 20, "#7a5a32"); // handle
  r(-1, -8, 2, 20, "#9a7440");
  r(-13, -9, 26, 4, "#8f9296"); // head bar
  r(-13, -9, 26, 2, "#bfc2c4");
  r(-14, -6, 3, 3, "#8f9296"); // tips
  r(11, -6, 3, 3, "#8f9296");
}

function drawSpearIcon(cx, cy) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(0.32);
  ctx.fillStyle = "#7a5a32"; // shaft
  ctx.fillRect(-2, -10, 4, 24);
  ctx.fillStyle = "#9a7440";
  ctx.fillRect(-2, -10, 2, 24);
  ctx.fillStyle = "#bfc2c4"; // tip
  ctx.beginPath();
  ctx.moveTo(0, -18);
  ctx.lineTo(-4, -10);
  ctx.lineTo(4, -10);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = "#5c4326"; // binding
  ctx.fillRect(-3, -9, 6, 2);
  ctx.restore();
}

function drawCampfireIcon(cx, cy) {
  const r = (x, y, w, h, c) => {
    ctx.fillStyle = c;
    ctx.fillRect(Math.round(cx + x), Math.round(cy + y), w, h);
  };
  r(-11, 7, 22, 4, "#6b4d2b"); // logs
  ctx.save();
  ctx.translate(cx, cy + 9);
  ctx.rotate(0.6);
  ctx.fillStyle = "#5c4326";
  ctx.fillRect(-11, -2, 22, 4);
  ctx.restore();
  r(-4, -3, 8, 9, "#e2592a"); // flame
  r(-3, -7, 6, 6, "#ef8a2c");
  r(-2, 0, 4, 6, "#f4cf48");
  r(-1, -10, 2, 4, "#f6d24a");
}

function drawTableIcon(cx, cy) {
  const r = (x, y, w, h, c) => {
    ctx.fillStyle = c;
    ctx.fillRect(Math.round(cx + x), Math.round(cy + y), w, h);
  };
  r(-12, -5, 24, 6, "#8a6a3c"); // top
  r(-12, -5, 24, 2, "#a6824c");
  r(-11, 1, 22, 2, "#5c4326"); // apron
  r(-10, 3, 3, 9, "#6b4d2b"); // legs
  r(7, 3, 3, 9, "#6b4d2b");
  r(-2, -5, 1, 6, "#5c4326"); // plank seam
  r(4, -5, 1, 6, "#5c4326");
}

function drawWoodIcon(cx, cy) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(-0.4);
  const r = (x, y, w, h, c) => {
    ctx.fillStyle = c;
    ctx.fillRect(Math.round(x), Math.round(y), w, h);
  };
  r(-12, -5, 24, 10, "#6b4d2b"); // log body
  r(-12, -5, 24, 3, "#86602f"); // lit top
  r(-12, 3, 24, 2, "#4f3720"); // shade
  r(-12, -5, 6, 10, "#caa05a"); // cut end with rings
  r(-11, -3, 4, 2, "#7a4d27");
  r(-10, -1, 2, 1, "#5a371d");
  ctx.restore();
}

const ITEM_ICONS = {
  stick: drawStickIcon,
  stone: drawStoneIcon,
  wood: drawWoodIcon,
  axe: drawAxeIcon,
  pickaxe: drawPickaxeIcon,
  spear: drawSpearIcon,
  campfire: drawCampfireIcon,
  table: drawTableIcon,
};
const ITEM_LABELS = {
  stick: "Stick",
  stone: "Stone",
  wood: "Wood",
  axe: "Axe",
  pickaxe: "Pickaxe",
  spear: "Spear",
  campfire: "Campfire",
  table: "Crafting Table",
};

function drawInventory() {
  if (!inventoryOpen) return;
  ctx.fillStyle = "rgba(8, 6, 10, 0.5)";
  ctx.fillRect(0, 0, width, height);

  const cols = 5;
  const slot = 46;
  const gap = 8;
  const pad = 18;
  const headerH = 36;
  const pw = pad * 2 + cols * slot + (cols - 1) * gap;
  const bodyH = Math.max(4 * slot + 3 * gap, RECIPES.length * 44);
  const ph = pad * 2 + headerH + bodyH + 26;
  const x = Math.round(width / 2 - pw / 2);
  const y = Math.round(height / 2 - ph / 2);

  roundRectPath(x, y, pw, ph, 12);
  ctx.fillStyle = "#2b2320";
  ctx.fill();
  ctx.lineWidth = 3;
  ctx.strokeStyle = "#c0503e";
  ctx.stroke();
  ctx.lineWidth = 1;
  ctx.strokeStyle = "rgba(0,0,0,0.4)";
  roundRectPath(x + 2, y + 2, pw - 4, ph - 4, 10);
  ctx.stroke();

  // Tabs
  const tabs = [["items", "Items"], ["craft", "Craft"]];
  ctx.font = "700 14px ui-sans-serif, system-ui, sans-serif";
  ctx.textBaseline = "middle";
  let tx = x + pad;
  const ty = y + pad + 6;
  tabs.forEach(([id, label]) => {
    const tw = ctx.measureText(label).width + 22;
    const on = activeTab === id;
    roundRectPath(tx, ty - 4, tw, 26, 6);
    ctx.fillStyle = on ? "#c0503e" : "rgba(15,11,13,0.5)";
    ctx.fill();
    ctx.fillStyle = on ? "#fff3e8" : "rgba(241,234,215,0.6)";
    ctx.textAlign = "center";
    ctx.fillText(label, tx + tw / 2, ty + 9);
    tx += tw + 8;
  });

  const bodyY = y + pad + headerH;
  if (activeTab === "items") drawItemsTab(x + pad, bodyY, cols, slot, gap);
  else drawCraftTab(x + pad, bodyY, pw - pad * 2, slot);

  // Footer: craft result message, otherwise the controls hint.
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  if (craftMsgTime > 0 && craftMsg) {
    ctx.globalAlpha = Math.min(1, craftMsgTime);
    ctx.fillStyle = "#f6d24a";
    ctx.font = "700 12px ui-sans-serif, system-ui, sans-serif";
    ctx.fillText(craftMsg, x + pw / 2, y + ph - 13);
    ctx.globalAlpha = 1;
  } else {
    ctx.fillStyle = "rgba(241, 234, 215, 0.4)";
    ctx.font = "600 11px ui-sans-serif, sans-serif";
    ctx.fillText("← → tab    ↑ ↓ select    Enter craft    I close", x + pw / 2, y + ph - 13);
  }

  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
}

function drawItemsTab(gx, gy, cols, slot, gap) {
  const items = Object.keys(inventory).filter((id) => inventory[id] > 0);
  for (let r = 0; r < 4; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      const sx = gx + c * (slot + gap);
      const sy = gy + r * (slot + gap);
      roundRectPath(sx, sy, slot, slot, 6);
      ctx.fillStyle = "rgba(15, 11, 13, 0.55)";
      ctx.fill();
      ctx.strokeStyle = "rgba(0, 0, 0, 0.4)";
      ctx.lineWidth = 1;
      ctx.stroke();

      const id = items[r * cols + c];
      if (!id) continue;
      if (ITEM_ICONS[id]) ITEM_ICONS[id](sx + slot / 2, sy + slot / 2 - 2);
      ctx.fillStyle = "#f1ead7";
      ctx.font = "700 12px ui-sans-serif, sans-serif";
      ctx.textAlign = "right";
      ctx.textBaseline = "alphabetic";
      ctx.lineWidth = 3;
      ctx.strokeStyle = "rgba(0,0,0,0.7)";
      ctx.strokeText(String(inventory[id]), sx + slot - 4, sy + slot - 4);
      ctx.fillText(String(inventory[id]), sx + slot - 4, sy + slot - 4);
    }
  }
}

function drawCraftTab(gx, gy, gw, slot) {
  const rowH = 40;
  for (let i = 0; i < RECIPES.length; i += 1) {
    const recipe = RECIPES[i];
    const ry = gy + i * (rowH + 4);
    const unlocked = hasStation(recipe.station);
    const afford = canAfford(recipe);
    const selected = i === craftSel;

    roundRectPath(gx, ry, gw, rowH, 6);
    ctx.fillStyle = selected ? "rgba(192, 80, 62, 0.28)" : "rgba(15, 11, 13, 0.5)";
    ctx.fill();
    if (selected) {
      ctx.strokeStyle = "#c0503e";
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    const dim = !unlocked || !afford;
    ctx.globalAlpha = dim ? 0.55 : 1;
    if (ITEM_ICONS[recipe.id]) ITEM_ICONS[recipe.id](gx + 22, ry + rowH / 2);
    ctx.globalAlpha = 1;

    ctx.fillStyle = unlocked ? "#f1ead7" : "rgba(241,234,215,0.55)";
    ctx.font = "700 13px ui-sans-serif, system-ui, sans-serif";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(ITEM_LABELS[recipe.id], gx + 44, ry + 14);

    // Cost, colored by whether you have enough.
    ctx.font = "600 11px ui-sans-serif, sans-serif";
    let costX = gx + 44;
    Object.keys(recipe.cost).forEach((id) => {
      const need = recipe.cost[id];
      const have = inventory[id] || 0;
      const txt = `${ITEM_LABELS[id]} ${have}/${need}`;
      ctx.fillStyle = have >= need ? "#8fcf6a" : "#e0795f";
      ctx.fillText(txt, costX, ry + 29);
      costX += ctx.measureText(txt).width + 12;
    });

    ctx.textAlign = "right";
    if (!unlocked) {
      ctx.fillStyle = "rgba(241,234,215,0.5)";
      ctx.font = "600 10px ui-sans-serif, sans-serif";
      ctx.fillText(`needs ${ITEM_LABELS.table}`, gx + gw - 10, ry + rowH / 2);
    } else if (selected) {
      ctx.fillStyle = afford ? "#8fcf6a" : "rgba(224,121,95,0.8)";
      ctx.font = "700 11px ui-sans-serif, sans-serif";
      ctx.fillText("Enter", gx + gw - 10, ry + rowH / 2);
    }
  }
}

function tileInfoAt(x, y) {
  const tx = Math.floor(x);
  const ty = Math.floor(y);
  return {
    x: tx,
    y: ty,
    type: tileType(tx, ty),
    level: terrainLevel(tx, ty),
  };
}

function nearbySolidProps(x, y) {
  const tx = Math.floor(x);
  const ty = Math.floor(y);
  const props = [];

  for (let cy = Math.floor((ty - 2) / CHUNK_SIZE); cy <= Math.floor((ty + 2) / CHUNK_SIZE); cy += 1) {
    for (let cx = Math.floor((tx - 2) / CHUNK_SIZE); cx <= Math.floor((tx + 2) / CHUNK_SIZE); cx += 1) {
      getChunk(cx, cy).props.forEach((prop) => {
        if (prop.kind === "tree" || prop.kind === "rock") props.push(prop);
      });
    }
  }

  return props;
}

function hitsSolidProp(x, y, level) {
  return nearbySolidProps(x, y).some((prop) => {
    if (prop.level !== level) return false;
    if (isDepleted(prop.x, prop.y)) return false; // chopped/mined props are walk-through
    const radius = prop.kind === "rock" ? 0.72 : 0.46;
    const centerX = prop.x + 0.5;
    const centerY = prop.y + 0.5;
    const dx = (x - centerX) / radius;
    const dy = (y - centerY) / (radius * 0.72);
    return dx * dx + dy * dy < 1;
  });
}

function canStandAt(x, y, fromLevel = tileInfoAt(player.x, player.y).level) {
  const target = tileInfoAt(x, y);
  if (target.type === "water") return false;
  if (Math.abs(target.level - fromLevel) > MAX_CLIMB) return false;
  return !hitsSolidProp(x, y, target.level);
}

function movePlayer(dx, dy) {
  const current = tileInfoAt(player.x, player.y);
  const nextX = player.x + dx;
  const nextY = player.y + dy;

  if (canStandAt(nextX, player.y, current.level)) {
    player.x = nextX;
  } else {
    player.vx = 0;
  }

  const afterX = tileInfoAt(player.x, player.y).level;
  if (canStandAt(player.x, nextY, afterX)) {
    player.y = nextY;
  } else {
    player.vy = 0;
  }
}

function update(dt) {
  let screenX = 0;
  let screenY = 0;
  if (!inventoryOpen) {
    if (keys.has("arrowup") || keys.has("w")) screenY -= 1;
    if (keys.has("arrowdown") || keys.has("s")) screenY += 1;
    if (keys.has("arrowleft") || keys.has("a")) screenX -= 1;
    if (keys.has("arrowright") || keys.has("d")) screenX += 1;
  }

  const moving = screenX !== 0 || screenY !== 0;
  if (moving) {
    const length = Math.hypot(screenX, screenY);
    screenX /= length;
    screenY /= length;
    if (screenX !== 0) player.facing = screenX > 0 ? 1 : -1;
  }

  const speed = 185;
  const targetVx = (screenX / TILE_W + screenY / TILE_H) * speed;
  const targetVy = (screenY / TILE_H - screenX / TILE_W) * speed;
  player.vx += (targetVx - player.vx) * Math.min(1, dt * 12);
  player.vy += (targetVy - player.vy) * Math.min(1, dt * 12);
  movePlayer(player.vx * dt, player.vy * dt);
  player.z = tileInfoAt(player.x, player.y).level * HEIGHT_STEP;

  // Drive the walk cycle off real screen-space speed so the stride matches the
  // ground (no foot sliding) and eases in/out smoothly with acceleration.
  const screenVX = (player.vx - player.vy) * (TILE_W / 2);
  const screenVY = (player.vx + player.vy) * (TILE_H / 2);
  const screenSpeed = Math.hypot(screenVX, screenVY);
  player.gait = Math.min(1, screenSpeed / speed);
  player.moving = player.gait > 0.06;
  player.step += screenSpeed * dt * 0.05;
  if (player.moving) player.heading = Math.atan2(player.vy, player.vx);
  animTime += dt;

  updateHarvest(dt);

  const targetX = (player.x - player.y) * (TILE_W / 2);
  const targetY = (player.x + player.y) * (TILE_H / 2) - player.z;
  camera.x += (targetX - camera.x) * Math.min(1, dt * 5);
  camera.y += (targetY - camera.y - 12) * Math.min(1, dt * 5);
}

// Screen-space margins so tall cliffs (below) and props (above) aren't culled early.
const CULL_X = 130;
const CULL_TOP = 220;
const CULL_BOTTOM = 140;
const PROP_TOP = 200;
const PROP_BOTTOM = 90;

function gatherScene() {
  const pcx = Math.floor(player.x / CHUNK_SIZE);
  const pcy = Math.floor(player.y / CHUNK_SIZE);
  const tiles = [];
  const props = [];
  const camX = Math.round(camera.x);
  const camY = Math.round(camera.y);
  const offX = width / 2 - camX;
  const offY = height / 2 - camY;
  const minX = -CULL_X;
  const maxX = width + CULL_X;

  for (let cy = pcy - DRAW_RADIUS; cy <= pcy + DRAW_RADIUS; cy += 1) {
    for (let cx = pcx - DRAW_RADIUS; cx <= pcx + DRAW_RADIUS; cx += 1) {
      const chunk = getChunk(cx, cy);
      for (let i = 0; i < chunk.tiles.length; i += 1) {
        const t = chunk.tiles[i];
        const sx = (t.x - t.y) * (TILE_W / 2) + offX;
        if (sx < minX || sx > maxX) continue;
        const sy = (t.x + t.y) * (TILE_H / 2) - t.level * HEIGHT_STEP + offY;
        if (sy < -CULL_TOP || sy > height + CULL_BOTTOM) continue;
        tiles.push(t);
      }
      for (let i = 0; i < chunk.props.length; i += 1) {
        const pr = chunk.props[i];
        const sx = (pr.x - pr.y) * (TILE_W / 2) + offX;
        if (sx < minX || sx > maxX) continue;
        const sy = (pr.x + pr.y) * (TILE_H / 2) - pr.level * HEIGHT_STEP + offY;
        if (sy < -PROP_TOP || sy > height + PROP_BOTTOM) continue;
        props.push(pr);
      }
    }
  }

  props.sort((a, b) => a.x + a.y - (b.x + b.y));
  return { tiles, props };
}

function draw() {
  ctx.fillStyle = "#201618";
  ctx.fillRect(0, 0, width, height);

  const { tiles, props } = gatherScene();
  tiles.sort((a, b) => a.x + a.y - (b.x + b.y));
  tiles.forEach(drawTile);

  const allActors = [...props, { kind: "player", x: player.x, y: player.y }];
  allActors.sort((a, b) => a.x + a.y - (b.x + b.y));
  allActors.forEach((actor) => {
    if (actor.kind === "player") drawPlayer();
    else drawProp(actor);
  });

  drawVignette();
  drawHarvestUI();
  drawFloaters();
  drawMinimap();
  drawInventory();
}

function frame(now) {
  const dt = Math.min(0.05, (now - lastTime) / 1000);
  lastTime = now;
  update(dt);
  draw();
  requestAnimationFrame(frame);
}

window.addEventListener("resize", resize);
window.addEventListener("keydown", (event) => {
  const k = event.key.toLowerCase();
  keys.add(k);
  if (k === "i" && !event.repeat) {
    inventoryOpen = !inventoryOpen;
    if (inventoryOpen) {
      activeTab = "items";
      craftSel = 0;
    }
  } else if (inventoryOpen && !event.repeat) {
    handlePanelKey(k);
  }
  if (inventoryOpen || ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", " "].includes(event.key)) {
    event.preventDefault();
  }
});
window.addEventListener("keyup", (event) => {
  keys.delete(event.key.toLowerCase());
});

resize();
requestAnimationFrame(frame);
