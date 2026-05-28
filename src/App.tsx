import { ChangeEvent, DragEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Download, ImagePlus, RefreshCcw, Shuffle, Sparkles } from "lucide-react";
import { Button } from "./components/ui/button";
import { Label } from "./components/ui/label";
import { Slider } from "./components/ui/slider";

type DotShape =
  | "circle"
  | "square"
  | "micro"
  | "block-2"
  | "block-3"
  | "vertical-line"
  | "horizontal-line"
  | "l-shape"
  | "solid-square"
  | "solid-vertical-rect"
  | "solid-horizontal-rect";

type Dot = {
  x: number;
  y: number;
  size: number;
  alpha: number;
  shape: DotShape;
  color: string;
};

type Settings = {
  density: number;
  noise: number;
  dotSize: number;
  gridSnapping: boolean;
  gridSize: number;
  color: string;
  background: string;
  seed: number;
};

type SourceImage = {
  element: HTMLImageElement;
  name: string;
};

const CANVAS_WIDTH = 1200;
const CANVAS_HEIGHT = 880;
const MAX_SOURCE_SIDE = 920;
const APP_VERSION = "v2026.05.28-upload-grid-5";
const SUPPORTED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/jpg", "image/webp"];
const DEFAULT_SETTINGS: Settings = {
  density: 52,
  noise: 24,
  dotSize: 8,
  gridSnapping: true,
  gridSize: 6,
  color: "#0B8FE8",
  background: "#F3F4F1",
  seed: 24891,
};

function mulberry32(seed: number) {
  return () => {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hexToRgb(hex: string) {
  const clean = hex.replace("#", "");
  const value = Number.parseInt(clean, 16);
  return { r: (value >> 16) & 255, g: (value >> 8) & 255, b: value & 255 };
}

function rgba(hex: string, alpha: number) {
  const { r, g, b } = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function sampleRange(random: () => number, min: number, max: number) {
  return min + random() * (max - min);
}

function sampleGridOffset(random: () => number, maxCells: number, gridSize: number) {
  const cells = Math.max(0, Math.round(maxCells));
  return (Math.floor(random() * (cells * 2 + 1)) - cells) * gridSize;
}

function pickSmallDotShape(random: () => number): DotShape {
  const roll = random();
  if (roll < 0.58) return "micro";
  if (roll < 0.82) return "circle";
  return "square";
}

function pickMediumClusterShape(random: () => number): DotShape {
  const roll = random();
  if (roll < 0.24) return "block-2";
  if (roll < 0.42) return "block-3";
  if (roll < 0.62) return "vertical-line";
  if (roll < 0.82) return "horizontal-line";
  return "l-shape";
}

function pickParticleShape(random: () => number, region: "edge" | "inside" | "scatter"): DotShape {
  const roll = random();

  if (region === "inside") {
    if (roll < 0.82) return pickSmallDotShape(random);
    if (roll < 0.94) return pickMediumClusterShape(random);
    return random() > 0.5 ? "solid-vertical-rect" : "solid-horizontal-rect";
  }

  if (region === "edge") {
    if (roll < 0.42) return pickSmallDotShape(random);
    if (roll < 0.72) return pickMediumClusterShape(random);
    if (roll < 0.84) return "solid-square";
    return random() > 0.52 ? "solid-vertical-rect" : "solid-horizontal-rect";
  }

  if (roll < 0.82) return pickSmallDotShape(random);
  if (roll < 0.94) return pickMediumClusterShape(random);
  return "solid-square";
}

function clusterCells(shape: DotShape) {
  if (shape === "block-2") {
    return [
      [-0.5, -0.5],
      [0.5, -0.5],
      [-0.5, 0.5],
      [0.5, 0.5],
    ];
  }

  if (shape === "block-3") {
    return [
      [-1, -1],
      [0, -1],
      [1, -1],
      [-1, 0],
      [0, 0],
      [1, 0],
      [-1, 1],
      [0, 1],
      [1, 1],
    ];
  }

  if (shape === "vertical-line") return [[0, -1.5], [0, -0.5], [0, 0.5], [0, 1.5]];
  if (shape === "horizontal-line") return [[-1.5, 0], [-0.5, 0], [0.5, 0], [1.5, 0]];
  if (shape === "l-shape") return [[-1, -1], [-1, 0], [-1, 1], [0, 1], [1, 1]];

  return [];
}

function isClusterShape(shape: DotShape) {
  return shape === "block-2" || shape === "block-3" || shape === "vertical-line" || shape === "horizontal-line" || shape === "l-shape";
}

function rectSize(dot: Dot) {
  if (dot.shape === "solid-vertical-rect") return { width: dot.size, height: dot.size * 2.9 };
  if (dot.shape === "solid-horizontal-rect") return { width: dot.size * 2.9, height: dot.size };
  return { width: dot.size, height: dot.size };
}

function findNearestForeground(
  mask: Uint8Array,
  width: number,
  height: number,
  x: number,
  y: number,
  radius: number,
) {
  let bestX = x;
  let bestY = y;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (let oy = -radius; oy <= radius; oy += 1) {
    for (let ox = -radius; ox <= radius; ox += 1) {
      const sx = clamp(x + ox, 0, width - 1);
      const sy = clamp(y + oy, 0, height - 1);
      if (!mask[sy * width + sx]) continue;

      const distance = ox * ox + oy * oy;
      if (distance < bestDistance) {
        bestDistance = distance;
        bestX = sx;
        bestY = sy;
      }
    }
  }

  return Number.isFinite(bestDistance) ? { x: bestX, y: bestY } : null;
}

function erodeMask(mask: Uint8Array, width: number, height: number, radius: number) {
  const next = new Uint8Array(width * height);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let keep = 1;
      for (let oy = -radius; oy <= radius && keep; oy += 1) {
        for (let ox = -radius; ox <= radius; ox += 1) {
          const sx = x + ox;
          const sy = y + oy;
          if (sx < 0 || sx >= width || sy < 0 || sy >= height || !mask[sy * width + sx]) {
            keep = 0;
            break;
          }
        }
      }
      next[y * width + x] = keep;
    }
  }

  return next;
}

function dilateMask(mask: Uint8Array, width: number, height: number, radius: number) {
  const next = new Uint8Array(width * height);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let keep = 0;
      for (let oy = -radius; oy <= radius && !keep; oy += 1) {
        for (let ox = -radius; ox <= radius; ox += 1) {
          const sx = x + ox;
          const sy = y + oy;
          if (sx >= 0 && sx < width && sy >= 0 && sy < height && mask[sy * width + sx]) {
            keep = 1;
            break;
          }
        }
      }
      next[y * width + x] = keep;
    }
  }

  return next;
}

function keepLargestComponent(mask: Uint8Array, width: number, height: number) {
  const visited = new Uint8Array(width * height);
  const best: number[] = [];
  const queue: number[] = [];

  for (let start = 0; start < mask.length; start += 1) {
    if (!mask[start] || visited[start]) continue;

    const component: number[] = [];
    queue.length = 0;
    queue.push(start);
    visited[start] = 1;

    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      const index = queue[cursor];
      const x = index % width;
      const y = Math.floor(index / width);
      component.push(index);

      const neighbors = [index - 1, index + 1, index - width, index + width];
      neighbors.forEach((next) => {
        const nx = next % width;
        const ny = Math.floor(next / width);
        const connected = next >= 0 && next < mask.length && Math.abs(nx - x) + Math.abs(ny - y) === 1;
        if (connected && mask[next] && !visited[next]) {
          visited[next] = 1;
          queue.push(next);
        }
      });
    }

    if (component.length > best.length) {
      best.length = 0;
      best.push(...component);
    }
  }

  const next = new Uint8Array(width * height);
  best.forEach((index) => {
    next[index] = 1;
  });
  return next;
}

function simplifySilhouette(mask: Uint8Array, width: number, height: number) {
  const cell = clamp(Math.round(Math.min(width, height) / 92), 5, 12);
  const next = new Uint8Array(width * height);

  for (let y = 0; y < height; y += cell) {
    for (let x = 0; x < width; x += cell) {
      let filled = 0;
      let total = 0;
      const maxY = Math.min(height, y + cell);
      const maxX = Math.min(width, x + cell);

      for (let py = y; py < maxY; py += 1) {
        for (let px = x; px < maxX; px += 1) {
          filled += mask[py * width + px];
          total += 1;
        }
      }

      if (filled / Math.max(total, 1) < 0.34) continue;

      for (let py = y; py < maxY; py += 1) {
        for (let px = x; px < maxX; px += 1) {
          next[py * width + px] = 1;
        }
      }
    }
  }

  return next;
}

function preprocessSilhouette(mask: Uint8Array, width: number, height: number) {
  let next = keepLargestComponent(mask, width, height);
  next = erodeMask(next, width, height, 1);
  next = keepLargestComponent(next, width, height);
  next = dilateMask(next, width, height, 2);
  next = erodeMask(next, width, height, 1);
  next = simplifySilhouette(next, width, height);
  next = dilateMask(next, width, height, 1);
  next = erodeMask(next, width, height, 1);
  return keepLargestComponent(next, width, height);
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function escapeXml(value: string) {
  return value.replace(/[<>&"']/g, (char) => {
    const map: Record<string, string> = { "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" };
    return map[char];
  });
}

function imageFromDataUrl(url: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Could not load image"));
    image.src = url;
  });
}

async function normalizeImageFile(file: File) {
  if (!SUPPORTED_IMAGE_TYPES.includes(file.type) && !file.type.startsWith("image/")) {
    throw new Error("Unsupported image type");
  }

  if ("createImageBitmap" in window) {
    const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" } as ImageBitmapOptions);
    const scale = Math.min(MAX_SOURCE_SIDE / bitmap.width, MAX_SOURCE_SIDE / bitmap.height, 1);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Could not prepare image");

    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    return imageFromDataUrl(canvas.toDataURL("image/png"));
  }

  return new Promise<HTMLImageElement>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => imageFromDataUrl(String(reader.result)).then(resolve, reject);
    reader.onerror = () => reject(new Error("Could not read image"));
    reader.readAsDataURL(file);
  });
}

function drawDot(context: CanvasRenderingContext2D, dot: Dot) {
  if (dot.shape === "circle") {
    context.beginPath();
    context.arc(dot.x, dot.y, dot.size / 2, 0, Math.PI * 2);
    context.fill();
    return;
  }

  if (dot.shape === "square" || dot.shape === "micro" || dot.shape === "solid-square" || dot.shape === "solid-vertical-rect" || dot.shape === "solid-horizontal-rect") {
    const { width, height } = rectSize(dot);
    context.fillRect(dot.x - width / 2, dot.y - height / 2, width, height);
    return;
  }

  clusterCells(dot.shape).forEach(([ox, oy]) => {
    const x = dot.x + ox * dot.size;
    const y = dot.y + oy * dot.size;
    context.fillRect(x - dot.size / 2, y - dot.size / 2, dot.size, dot.size);
  });
}

function dotToSvg(dot: Dot) {
  const color = escapeXml(dot.color);

  if (dot.shape === "circle") {
    return `<circle cx="${dot.x.toFixed(2)}" cy="${dot.y.toFixed(2)}" r="${(dot.size / 2).toFixed(2)}" fill="${color}"/>`;
  }

  if (dot.shape === "square" || dot.shape === "micro" || dot.shape === "solid-square" || dot.shape === "solid-vertical-rect" || dot.shape === "solid-horizontal-rect") {
    const { width, height } = rectSize(dot);
    return `<rect x="${(dot.x - width / 2).toFixed(2)}" y="${(dot.y - height / 2).toFixed(2)}" width="${width.toFixed(2)}" height="${height.toFixed(2)}" fill="${color}"/>`;
  }

  return clusterCells(dot.shape)
    .map(([ox, oy]) => {
      const x = dot.x + ox * dot.size;
      const y = dot.y + oy * dot.size;
      return `<rect x="${(x - dot.size / 2).toFixed(2)}" y="${(y - dot.size / 2).toFixed(2)}" width="${dot.size.toFixed(2)}" height="${dot.size.toFixed(2)}" fill="${color}"/>`;
    })
    .join("");
}

function buildPixelArt(image: HTMLImageElement, settings: Settings) {
  const scale = Math.min(MAX_SOURCE_SIDE / image.naturalWidth, MAX_SOURCE_SIDE / image.naturalHeight, 1);
  const width = Math.max(1, Math.round(image.naturalWidth * scale));
  const height = Math.max(1, Math.round(image.naturalHeight * scale));
  const offscreen = document.createElement("canvas");
  offscreen.width = width;
  offscreen.height = height;
  const context = offscreen.getContext("2d", { willReadFrequently: true });

  if (!context) {
    return { dots: [] as Dot[], width, height };
  }

  context.drawImage(image, 0, 0, width, height);
  const imageData = context.getImageData(0, 0, width, height);
  const data = imageData.data;
  const cornerSamples: number[][] = [];
  const cornerSize = Math.max(6, Math.floor(Math.min(width, height) * 0.06));

  for (let y = 0; y < cornerSize; y += 2) {
    for (let x = 0; x < cornerSize; x += 2) {
      const positions = [
        [x, y],
        [width - 1 - x, y],
        [x, height - 1 - y],
        [width - 1 - x, height - 1 - y],
      ];
      positions.forEach(([px, py]) => {
        const i = (py * width + px) * 4;
        cornerSamples.push([data[i], data[i + 1], data[i + 2]]);
      });
    }
  }

  const background = cornerSamples.reduce(
    (acc, sample) => [acc[0] + sample[0], acc[1] + sample[1], acc[2] + sample[2]],
    [0, 0, 0],
  ).map((value) => value / Math.max(cornerSamples.length, 1));

  let mask = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      const alpha = data[i + 3] / 255;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      const bgDistance = Math.hypot(r - background[0], g - background[1], b - background[2]);
      const saturation = Math.max(r, g, b) - Math.min(r, g, b);
      const foreground = alpha > 0.15 && (luminance < 222 || bgDistance > 44 || saturation > 52);
      mask[y * width + x] = foreground ? 1 : 0;
    }
  }

  mask = preprocessSilhouette(mask, width, height);

  const random = mulberry32(settings.seed);
  const baseDensity = settings.density / 100;
  const noise = settings.noise / 100;
  const gridSize = settings.gridSnapping ? clamp(settings.gridSize, 4, 12) : clamp(settings.dotSize, 4, 12);
  const gridWidth = Math.max(1, Math.floor(width / gridSize));
  const gridHeight = Math.max(1, Math.floor(height / gridSize));
  type GridKind = "empty" | "square" | "circle" | "hole-square" | "hole-circle";
  const grid = new Array<GridKind>(gridWidth * gridHeight).fill("empty");
  const cellMask = new Uint8Array(gridWidth * gridHeight);
  const cellEdge = new Uint8Array(gridWidth * gridHeight);
  const cellBody = new Float32Array(gridWidth * gridHeight);
  const cellJoint = new Float32Array(gridWidth * gridHeight);
  const holeQueue: Array<{ cx: number; cy: number; kind: "hole-square" | "hole-circle" }> = [];

  const cellIndex = (cx: number, cy: number) => cy * gridWidth + cx;
  const inGrid = (cx: number, cy: number) => cx >= 0 && cx < gridWidth && cy >= 0 && cy < gridHeight;
  const pixelX = (cx: number) => Math.round(cx * gridSize + gridSize / 2);
  const pixelY = (cy: number) => Math.round(cy * gridSize + gridSize / 2);
  const maskAtCell = (cx: number, cy: number) => {
    const px = clamp(pixelX(cx), 0, width - 1);
    const py = clamp(pixelY(cy), 0, height - 1);
    return mask[py * width + px];
  };
  const setCell = (cx: number, cy: number, kind: GridKind) => {
    if (!inGrid(cx, cy)) return;
    const index = cellIndex(cx, cy);
    if (grid[index].startsWith("hole")) return;
    grid[index] = kind;
  };
  const queueHole = (cx: number, cy: number) => {
    if (!inGrid(cx, cy)) return;
    holeQueue.push({ cx, cy, kind: random() > 0.2 ? "hole-circle" : "hole-square" });
  };
  const fillBlock = (cx: number, cy: number, cellsWide: number, cellsHigh: number) => {
    const startX = cx - Math.floor(cellsWide / 2);
    const startY = cy - Math.floor(cellsHigh / 2);
    for (let y = 0; y < cellsHigh; y += 1) {
      for (let x = 0; x < cellsWide; x += 1) {
        const gx = startX + x;
        const gy = startY + y;
        if (inGrid(gx, gy) && (cellMask[cellIndex(gx, gy)] || random() < noise * 0.18)) {
          setCell(gx, gy, "square");
        }
      }
    }

    const holes = Math.max(1, Math.round((cellsWide * cellsHigh) * 0.18));
    for (let i = 0; i < holes; i += 1) {
      queueHole(startX + Math.floor(random() * cellsWide), startY + Math.floor(random() * cellsHigh));
    }
  };

  for (let cy = 0; cy < gridHeight; cy += 1) {
    for (let cx = 0; cx < gridWidth; cx += 1) {
      const index = cellIndex(cx, cy);
      cellMask[index] = maskAtCell(cx, cy);
    }
  }

  for (let cy = 0; cy < gridHeight; cy += 1) {
    for (let cx = 0; cx < gridWidth; cx += 1) {
      const index = cellIndex(cx, cy);
      if (!cellMask[index]) continue;

      let filled = 0;
      let total = 0;
      let edgeNeighbors = 0;
      for (let oy = -2; oy <= 2; oy += 1) {
        for (let ox = -2; ox <= 2; ox += 1) {
          const nx = cx + ox;
          const ny = cy + oy;
          if (!inGrid(nx, ny)) continue;
          const neighbor = cellMask[cellIndex(nx, ny)];
          filled += neighbor;
          total += 1;
          if (Math.abs(ox) <= 1 && Math.abs(oy) <= 1 && !neighbor) edgeNeighbors += 1;
        }
      }

      const fillRatio = filled / Math.max(total, 1);
      cellBody[index] = fillRatio;
      cellEdge[index] = edgeNeighbors > 0 ? 1 : 0;
      cellJoint[index] = fillRatio > 0.2 && fillRatio < 0.74 && edgeNeighbors >= 2 ? clamp(edgeNeighbors / 5, 0, 1) : 0;
    }
  }

  let minCellX = gridWidth;
  let maxCellX = 0;
  let minCellY = gridHeight;
  let maxCellY = 0;
  for (let cy = 0; cy < gridHeight; cy += 1) {
    for (let cx = 0; cx < gridWidth; cx += 1) {
      if (!cellMask[cellIndex(cx, cy)]) continue;
      minCellX = Math.min(minCellX, cx);
      maxCellX = Math.max(maxCellX, cx);
      minCellY = Math.min(minCellY, cy);
      maxCellY = Math.max(maxCellY, cy);
    }
  }

  const silhouetteWidth = Math.max(1, maxCellX - minCellX);
  const silhouetteHeight = Math.max(1, maxCellY - minCellY);
  const normalizedCell = (cx: number, cy: number) => ({
    x: (cx - minCellX) / silhouetteWidth,
    y: (cy - minCellY) / silhouetteHeight,
  });
  const shouldErasePresence = (cx: number, cy: number, edge = false) => {
    const { x, y } = normalizedCell(cx, cy);
    const faceZone = y < 0.18 && x > 0.3 && x < 0.72;
    const torsoCenter = y > 0.27 && y < 0.62 && x > 0.36 && x < 0.66;
    const handZone = (x < 0.15 || x > 0.85) && y > 0.2 && y < 0.78;
    const wave = Math.sin(cx * 0.72 + settings.seed * 0.01) + Math.sin(cy * 0.47 + settings.seed * 0.017);
    const waveGap = edge && wave > 0.55;

    if (faceZone && random() < 0.84) return true;
    if (torsoCenter && random() < 0.72) return true;
    if (handZone && random() < 0.78) return true;
    return waveGap || random() < (edge ? 0.18 : 0.04);
  };

  for (let cy = 0; cy < gridHeight; cy += 1) {
    for (let cx = 0; cx < gridWidth; cx += 1) {
      const index = cellIndex(cx, cy);
      if (!cellMask[index]) continue;

      if (cellEdge[index] && !shouldErasePresence(cx, cy, true) && random() < clamp(baseDensity * 1.05, 0.12, 0.72)) {
        setCell(cx, cy, random() > 0.35 ? "circle" : "square");
        if (random() < baseDensity * 0.25) {
          setCell(cx + sampleGridOffset(random, 1, 1), cy + sampleGridOffset(random, 1, 1), random() > 0.5 ? "circle" : "square");
        }
      }

      if (cellJoint[index] > 0.3 && !shouldErasePresence(cx, cy) && random() < clamp(baseDensity * 1.15, 0.18, 0.82)) {
        const count = 2 + Math.floor(random() * 4);
        for (let i = 0; i < count; i += 1) {
          setCell(cx + sampleGridOffset(random, 2, 1), cy + sampleGridOffset(random, 2, 1), random() > 0.45 ? "circle" : "square");
        }
      }
    }
  }

  const blockStep = Math.max(2, Math.round(22 / gridSize));
  for (let cy = 0; cy < gridHeight; cy += blockStep) {
    for (let cx = 0; cx < gridWidth; cx += blockStep) {
      const index = cellIndex(cx, cy);
      if (!cellMask[index] || shouldErasePresence(cx, cy) || cellBody[index] < 0.42 || random() > clamp(baseDensity * 0.62, 0.1, 0.62)) continue;

      const vertical = random() > 0.42;
      const cellsWide = vertical ? 1 + Math.floor(random() * 2) : 3 + Math.floor(random() * 4);
      const cellsHigh = vertical ? 3 + Math.floor(random() * 5) : 1 + Math.floor(random() * 2);
      fillBlock(cx, cy, cellsWide, cellsHigh);
    }
  }

  const scatterAttempts = Math.round(gridWidth * gridHeight * clamp(noise * 0.006, 0.002, 0.012));
  for (let i = 0; i < scatterAttempts; i += 1) {
    const cx = Math.floor(random() * gridWidth);
    const cy = Math.floor(random() * gridHeight);
    const index = cellIndex(cx, cy);
    if (!cellEdge[index] || shouldErasePresence(cx, cy, true) || random() > baseDensity) continue;

    const dx = sampleGridOffset(random, 3, 1);
    const dy = sampleGridOffset(random, 3, 1);
    const tx = cx + dx;
    const ty = cy + dy;
    if (inGrid(tx, ty) && !cellMask[cellIndex(tx, ty)]) {
      setCell(tx, ty, random() > 0.4 ? "circle" : "square");
    }
  }

  holeQueue.forEach(({ cx, cy, kind }) => {
    if (inGrid(cx, cy) && grid[cellIndex(cx, cy)] !== "empty") {
      grid[cellIndex(cx, cy)] = kind;
    }
  });

  const dots: Dot[] = [];
  for (let cy = 0; cy < gridHeight; cy += 1) {
    for (let cx = 0; cx < gridWidth; cx += 1) {
      const kind = grid[cellIndex(cx, cy)];
      if (kind === "empty") continue;
      dots.push({
        x: pixelX(cx),
        y: pixelY(cy),
        size: gridSize,
        alpha: 1,
        shape: kind === "circle" || kind === "hole-circle" ? "circle" : "square",
        color: kind.startsWith("hole") ? settings.background : settings.color,
      });
    }
  }

  return { dots, width, height };
}

function App() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [sourceImage, setSourceImage] = useState<SourceImage | null>(null);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [dots, setDots] = useState<Dot[]>([]);
  const [artSize, setArtSize] = useState({ width: CANVAS_WIDTH, height: CANVAS_HEIGHT });
  const [isDragging, setIsDragging] = useState(false);
  const [uploadError, setUploadError] = useState("");

  const hasImage = Boolean(sourceImage);
  const displayName = sourceImage?.name ?? "No image loaded";

  const render = useCallback((nextDots: Dot[], width: number, height: number, background: string) => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;

    canvas.width = CANVAS_WIDTH;
    canvas.height = CANVAS_HEIGHT;
    context.fillStyle = background;
    context.fillRect(0, 0, canvas.width, canvas.height);

    const fit = Math.min((canvas.width - 96) / width, (canvas.height - 96) / height, 1.18);
    const offsetX = (canvas.width - width * fit) / 2;
    const offsetY = (canvas.height - height * fit) / 2;

    context.save();
    context.translate(offsetX, offsetY);
    context.scale(fit, fit);
    nextDots.forEach((dot) => {
      context.globalAlpha = dot.alpha;
      context.fillStyle = dot.color;
      drawDot(context, dot);
    });
    context.restore();
    context.globalAlpha = 1;
  }, []);

  useEffect(() => {
    if (!sourceImage) {
      render([], artSize.width, artSize.height, settings.background);
      return;
    }

    const art = buildPixelArt(sourceImage.element, settings);
    setDots(art.dots);
    setArtSize({ width: art.width, height: art.height });
    render(art.dots, art.width, art.height, settings.background);
  }, [sourceImage, settings, render]);

  const stats = useMemo(() => new Intl.NumberFormat("ja-JP").format(dots.length), [dots.length]);

  const updateSetting = <K extends keyof Settings>(key: K, value: Settings[K]) => {
    setSettings((current) => ({ ...current, [key]: value }));
  };

  const processImageFile = useCallback(async (file: File | undefined) => {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setUploadError("Please use a PNG, JPG, or WEBP image.");
      return;
    }

    try {
      setUploadError("");
      const image = await normalizeImageFile(file);
      setSourceImage({ element: image, name: file.name || "Pasted image" });
    } catch {
      setUploadError("Could not load this image.");
    }
  }, []);

  const handleUpload = (event: ChangeEvent<HTMLInputElement>) => {
    void processImageFile(event.target.files?.[0]);
  };

  const handleDrop = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    setIsDragging(false);
    void processImageFile(event.dataTransfer.files?.[0]);
  };

  const handleDragOver = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = (event: DragEvent<HTMLElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
      setIsDragging(false);
    }
  };

  useEffect(() => {
    const handlePaste = (event: ClipboardEvent) => {
      const file = Array.from(event.clipboardData?.files ?? []).find((item) => item.type.startsWith("image/"));
      if (file) {
        event.preventDefault();
        void processImageFile(file);
      }
    };

    window.addEventListener("paste", handlePaste);
    return () => window.removeEventListener("paste", handlePaste);
  }, [processImageFile]);

  const reset = () => {
    setSettings(DEFAULT_SETTINGS);
    setSourceImage(null);
    setDots([]);
    if (fileInputRef.current) fileInputRef.current.value = "";
    setUploadError("");
  };

  const randomizeSeed = () => updateSetting("seed", Math.floor(Math.random() * 999999));

  const exportPng = () => {
    const canvas = canvasRef.current;
    canvas?.toBlob((blob) => {
      if (blob) downloadBlob(blob, "blue-pixel-art.png");
    }, "image/png");
  };

  const exportSvg = () => {
    const width = artSize.width;
    const height = artSize.height;
    const elements = dots.map(dotToSvg);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="${escapeXml(settings.background)}"/>${elements.join("")}</svg>`;
    downloadBlob(new Blob([svg], { type: "image/svg+xml;charset=utf-8" }), "blue-pixel-art.svg");
  };

  return (
    <main className="min-h-screen bg-slate-50 text-slate-950">
      <div className="grid min-h-screen grid-cols-1 lg:grid-cols-[360px_minmax(0,1fr)]">
        <aside className="border-b border-slate-200 bg-white/92 px-5 py-5 shadow-tool lg:border-b-0 lg:border-r">
          <div className="mb-7 flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-md bg-primary text-white">
              <Sparkles className="h-5 w-5" />
            </div>
            <div>
              <h1 className="text-lg font-semibold tracking-normal">Blue Pixel Studio</h1>
              <p className="text-xs text-slate-500">Generative silhouette dots</p>
              <p className="mt-1 text-[11px] font-medium text-slate-400">{APP_VERSION}</p>
            </div>
          </div>

          <div className="space-y-6">
            <section
              className={`space-y-3 rounded-md border border-dashed p-3 transition-colors ${
                isDragging ? "border-primary bg-blue-50" : "border-transparent"
              }`}
              onDrop={handleDrop}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
            >
              <Label>Image</Label>
              <input ref={fileInputRef} type="file" accept="image/png,image/jpeg,image/jpg,image/webp" className="hidden" onChange={handleUpload} />
              <Button className="w-full" onClick={() => fileInputRef.current?.click()}>
                <ImagePlus className="h-4 w-4" />
                Upload image
              </Button>
              <div className="text-[11px] font-medium text-slate-400">PNG / JPG / WEBP supported</div>
              <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-500">
                <div className="truncate font-medium text-slate-700">{displayName}</div>
                <div>{hasImage ? `${stats} dots generated` : "Bright backgrounds are removed automatically"}</div>
              </div>
              {uploadError && <div className="text-xs font-medium text-red-500">{uploadError}</div>}
            </section>

            <section className="space-y-5">
              <Slider label="Density" value={settings.density} min={8} max={100} onChange={(value) => updateSetting("density", value)} />
              <Slider label="Collapse / noise" value={settings.noise} min={0} max={100} suffix="%" onChange={(value) => updateSetting("noise", value)} />
              <Slider label="Dot size" value={settings.dotSize} min={1} max={8} suffix="px" onChange={(value) => updateSetting("dotSize", value)} />
              <Slider label="Grid size" value={settings.gridSize} min={4} max={12} suffix="px" onChange={(value) => updateSetting("gridSize", value)} />
              <label className="flex h-10 items-center justify-between rounded-md border border-slate-200 bg-slate-50 px-3 text-xs font-medium text-slate-600">
                <span>Grid snapping</span>
                <input
                  type="checkbox"
                  checked={settings.gridSnapping}
                  onChange={(event) => updateSetting("gridSnapping", event.target.checked)}
                  className="h-4 w-4 accent-primary"
                />
              </label>
            </section>

            <section className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="dot-color">Dot color</Label>
                <input id="dot-color" type="color" value={settings.color} onChange={(event) => updateSetting("color", event.target.value)} className="h-10 w-full rounded-md border border-slate-200 bg-white p-1" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="bg-color">Background</Label>
                <input id="bg-color" type="color" value={settings.background} onChange={(event) => updateSetting("background", event.target.value)} className="h-10 w-full rounded-md border border-slate-200 bg-white p-1" />
              </div>
            </section>

            <section className="space-y-3">
              <div className="flex items-center gap-2">
                <Button variant="outline" className="flex-1" onClick={randomizeSeed} title="Change seed">
                  <Shuffle className="h-4 w-4" />
                  Seed
                </Button>
                <div className="h-9 min-w-24 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-center text-xs tabular-nums text-slate-600">
                  {settings.seed}
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <Button variant="secondary" onClick={exportPng} disabled={!dots.length} title="Export PNG">
                  <Download className="h-4 w-4" />
                  PNG
                </Button>
                <Button variant="secondary" onClick={exportSvg} disabled={!dots.length} title="Export SVG">
                  <Download className="h-4 w-4" />
                  SVG
                </Button>
              </div>
              <Button variant="outline" className="w-full" onClick={reset}>
                <RefreshCcw className="h-4 w-4" />
                Reset
              </Button>
            </section>
          </div>
        </aside>

        <section className="flex min-h-[640px] items-center justify-center bg-[linear-gradient(180deg,#f8fafc_0%,#eef4fb_100%)] p-4 sm:p-6 lg:p-8">
          <div className="relative h-full w-full max-w-[1280px] overflow-hidden rounded-md border border-slate-200 bg-white shadow-tool">
            <canvas ref={canvasRef} className="h-full min-h-[560px] w-full" />
            {!hasImage && (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                <div className="rounded-md border border-dashed border-slate-300 bg-white/82 px-6 py-5 text-center shadow-sm">
                  <div className="text-sm font-medium text-slate-700">Upload a bright-background image</div>
                  <div className="mt-1 text-xs text-slate-500">The silhouette becomes blue circles, squares, and tiny fragments.</div>
                </div>
              </div>
            )}
          </div>
        </section>
      </div>
    </main>
  );
}

export default App;
