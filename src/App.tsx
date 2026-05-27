import { ChangeEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
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
const APP_VERSION = "v2026.05.27-grid-symbolic-3";
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

  const edgeStrength = new Float32Array(width * height);
  const edgeAngle = new Float32Array(width * height);
  let maxEdge = 1;

  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const tl = mask[(y - 1) * width + x - 1];
      const tc = mask[(y - 1) * width + x];
      const tr = mask[(y - 1) * width + x + 1];
      const ml = mask[y * width + x - 1];
      const mr = mask[y * width + x + 1];
      const bl = mask[(y + 1) * width + x - 1];
      const bc = mask[(y + 1) * width + x];
      const br = mask[(y + 1) * width + x + 1];
      const gx = -tl + tr - 2 * ml + 2 * mr - bl + br;
      const gy = -tl - 2 * tc - tr + bl + 2 * bc + br;
      const strength = Math.hypot(gx, gy);
      const index = y * width + x;

      edgeStrength[index] = strength;
      edgeAngle[index] = Math.atan2(gy, gx);
      maxEdge = Math.max(maxEdge, strength);
    }
  }

  for (let index = 0; index < edgeStrength.length; index += 1) {
    edgeStrength[index] /= maxEdge;
  }

  const random = mulberry32(settings.seed);
  const baseStride = clamp(Math.round(17 - settings.density * 0.13), 4, 16);
  const baseDensity = settings.density / 100;
  const noise = settings.noise / 100;
  const maxDotSize = clamp(settings.dotSize, 1, 8);
  const gridSize = clamp(settings.gridSize, 4, 12);
  const posterGrid = settings.gridSnapping ? gridSize : clamp(Math.round(maxDotSize * 0.86), 4, 7);
  const sampleStep = posterGrid * Math.max(1, Math.round(baseStride / posterGrid));
  const edgeStep = posterGrid * Math.max(1, Math.round(baseStride * 0.42 / posterGrid));
  const jointStep = posterGrid * Math.max(1, Math.round(baseStride * 0.72 / posterGrid));
  const flowAngle = sampleRange(random, -0.35, 0.35) + (random() > 0.5 ? 0 : Math.PI);
  const edgeDensityBoost = 3 + random() * 2;
  const jointStrength = new Float32Array(width * height);
  const bodyMass = new Float32Array(width * height);
  const dots: Dot[] = [];

  const jointRadius = Math.max(6, Math.round(baseStride * 1.45));
  for (let y = jointRadius; y < height - jointRadius; y += 1) {
    for (let x = jointRadius; x < width - jointRadius; x += 1) {
      const index = y * width + x;
      if (!mask[index] || edgeStrength[index] > 0.08) continue;

      let edgeCount = 0;
      let fillCount = 0;
      let samples = 0;
      for (let oy = -jointRadius; oy <= jointRadius; oy += 3) {
        for (let ox = -jointRadius; ox <= jointRadius; ox += 3) {
          const sampleIndex = (y + oy) * width + x + ox;
          fillCount += mask[sampleIndex];
          edgeCount += edgeStrength[sampleIndex] > 0.08 ? 1 : 0;
          samples += 1;
        }
      }

      const fillRatio = fillCount / Math.max(samples, 1);
      const edgeRatio = edgeCount / Math.max(samples, 1);
      bodyMass[index] = fillRatio;
      jointStrength[index] = fillRatio > 0.18 && fillRatio < 0.72 ? clamp(edgeRatio * 3.4, 0, 1) : 0;
    }
  }

  const snapToPosterGrid = (value: number) => {
    if (!settings.gridSnapping) return value;
    return clamp(Math.round((value - posterGrid / 2) / posterGrid) * posterGrid + posterGrid / 2, posterGrid / 2, Math.max(posterGrid / 2, width - posterGrid / 2));
  };
  const snapYToPosterGrid = (value: number) => {
    if (!settings.gridSnapping) return value;
    return clamp(Math.round((value - posterGrid / 2) / posterGrid) * posterGrid + posterGrid / 2, posterGrid / 2, Math.max(posterGrid / 2, height - posterGrid / 2));
  };
  const quantizeSize = (size: number, minCells = 1, maxCells = 6) => {
    if (!settings.gridSnapping) return size;
    return clamp(Math.round(size / posterGrid), minCells, maxCells) * posterGrid;
  };

  const pushRawDot = (x: number, y: number, size: number, alpha: number, shape: DotShape, color = settings.color) => {
    const cellSize = shape === "micro" ? quantizeSize(size * 0.45, 1, 1) : quantizeSize(size, 1, 2);
    const finalSize =
      shape === "solid-square" || shape === "solid-vertical-rect" || shape === "solid-horizontal-rect"
        ? quantizeSize(size, 2, 6)
        : cellSize;

    dots.push({
      x,
      y,
      size: finalSize,
      alpha: 1,
      shape,
      color,
    });
  };

  const pushCutouts = (x: number, y: number, size: number, shape: DotShape) => {
    if (random() > 0.84 && !shape.startsWith("solid-")) return;
    if (!isClusterShape(shape) && !shape.startsWith("solid-")) return;

    const holes = shape.startsWith("solid-") ? 2 + Math.floor(random() * 4) : 1 + Math.floor(random() * 2);
    for (let i = 0; i < holes; i += 1) {
      const rect = rectSize({ x, y, size, alpha: 1, shape, color: settings.color });
      const rangeX = shape.startsWith("solid-") ? rect.width * 0.36 : size * 0.8;
      const rangeY = shape.startsWith("solid-") ? rect.height * 0.36 : size * 0.8;
      pushRawDot(
        snapToPosterGrid(x + sampleRange(random, -rangeX, rangeX)),
        snapYToPosterGrid(y + sampleRange(random, -rangeY, rangeY)),
        sampleRange(random, Math.max(2.2, size * 0.22), Math.max(3, size * 0.42)),
        1,
        random() > 0.12 ? "circle" : "square",
        settings.background,
      );
    }
  };

  const pushDot = (x: number, y: number, size: number, alpha: number, shape: DotShape) => {
    const shouldSnap = settings.gridSnapping || shape !== "circle" || size > 2.6;
    const dotX = shouldSnap ? snapToPosterGrid(x) : x;
    const dotY = shouldSnap ? snapYToPosterGrid(y) : y;
    const dotSize = shape.startsWith("solid-") ? sampleRange(random, Math.max(11, size), Math.max(16, size * 1.8)) : size;

    pushRawDot(dotX, dotY, dotSize, 1, shape);
    pushCutouts(dotX, dotY, dotSize, shape);
  };

  const outwardAngle = (x: number, y: number, angle: number) => {
    const forwardX = clamp(Math.round(x + Math.cos(angle) * 3), 0, width - 1);
    const forwardY = clamp(Math.round(y + Math.sin(angle) * 3), 0, height - 1);
    return mask[forwardY * width + forwardX] ? angle + Math.PI : angle;
  };

  for (let y = posterGrid / 2; y < height; y += sampleStep) {
    for (let x = posterGrid / 2; x < width; x += sampleStep) {
      const px = clamp(Math.round(x), 0, width - 1);
      const py = clamp(Math.round(y), 0, height - 1);
      const index = py * width + px;
      const inMask = mask[index] === 1;
      const edge = edgeStrength[index];
      const nearEdge = edge > 0.08;
      const joint = jointStrength[index] > 0.28;
      const scatterCandidate = !inMask && nearEdge && random() < noise * 0.18;

      if (!inMask && !scatterCandidate) continue;

      const regionChance = inMask
        ? nearEdge
          ? baseDensity * edgeDensityBoost
          : joint
            ? baseDensity * 1.22
            : baseDensity * 0.08
        : baseDensity * 0.12;

      if (random() > clamp(regionChance, 0.03, 0.96)) continue;

      const normal = outwardAngle(px, py, edgeAngle[index]);
      const localFlow = flowAngle + Math.sin((px + py) * 0.015 + settings.seed) * 0.32;
      const flowCells = Math.round((Math.pow(random(), 1.5) * baseStride * (0.55 + noise * 2.8)) / posterGrid);
      const normalCells = scatterCandidate ? 1 + Math.floor(random() * 3) : 0;
      const dotX = px + Math.round(Math.cos(localFlow) * flowCells + Math.cos(normal) * normalCells) * posterGrid;
      const dotY = py + Math.round(Math.sin(localFlow) * flowCells + Math.sin(normal) * normalCells) * posterGrid;
      const size = nearEdge
        ? sampleRange(random, 1.2, Math.max(3.2, maxDotSize * 0.5))
        : joint
          ? sampleRange(random, 2.2, Math.max(4.2, maxDotSize * 0.62))
          : sampleRange(random, 1, Math.max(2.1, maxDotSize * 0.34));
      const shape = nearEdge
        ? pickSmallDotShape(random)
        : joint
          ? pickParticleShape(random, "edge")
          : pickSmallDotShape(random);

      pushDot(dotX, dotY, size, 1, shape);

      if (nearEdge && inMask) {
        const extraCount = 1 + Math.floor(random() * 3);
        for (let i = 0; i < extraCount; i += 1) {
          if (random() > baseDensity * 0.8) continue;
          const echoDistance = sampleRange(random, 0, baseStride * 0.9);
          const echoFlow = localFlow + sampleRange(random, -0.6, 0.6);
          const echoCells = Math.round(echoDistance / posterGrid);
          pushDot(
            px + Math.round(Math.cos(echoFlow) * echoCells) * posterGrid,
            py + Math.round(Math.sin(echoFlow) * echoCells) * posterGrid,
            sampleRange(random, 1.2, Math.max(3.2, maxDotSize * 0.44)),
            1,
            pickSmallDotShape(random),
          );
        }
      }

      if (nearEdge && random() < 0.12 + noise * 0.12) {
        pushDot(
          px + sampleGridOffset(random, 1, posterGrid),
          py + sampleGridOffset(random, 1, posterGrid),
          sampleRange(random, 6, 14),
          sampleRange(random, 0.78, 1),
          "solid-square",
        );
      }
    }
  }

  for (let y = posterGrid / 2; y < height; y += edgeStep) {
    for (let x = posterGrid / 2; x < width; x += edgeStep) {
      const px = clamp(Math.round(x), 0, width - 1);
      const py = clamp(Math.round(y), 0, height - 1);
      const index = py * width + px;
      if (!mask[index] || edgeStrength[index] < 0.08 || random() > clamp(baseDensity * 0.92, 0.16, 0.94)) continue;

      const tangent = edgeAngle[index] + Math.PI / 2 + sampleRange(random, -0.45, 0.45);
      const normal = outwardAngle(px, py, edgeAngle[index]);
      const repeats = 1 + Math.floor(random() * edgeDensityBoost * 0.62);

      for (let i = 0; i < repeats; i += 1) {
        const along = sampleGridOffset(random, Math.round((baseStride * 0.7) / posterGrid), posterGrid);
        const lift = sampleGridOffset(random, 1, posterGrid);
        pushDot(
          px + Math.round((Math.cos(tangent) * along + Math.cos(normal) * lift) / posterGrid) * posterGrid,
          py + Math.round((Math.sin(tangent) * along + Math.sin(normal) * lift) / posterGrid) * posterGrid,
          sampleRange(random, 1.1, Math.max(3.4, maxDotSize * 0.42)),
          1,
          pickSmallDotShape(random),
        );
      }

      if (random() < noise * 0.22) {
        const scatterCells = 1 + Math.floor(random() * 4);
        pushDot(
          px + Math.round(Math.cos(normal) * scatterCells) * posterGrid,
          py + Math.round(Math.sin(normal) * scatterCells) * posterGrid,
          sampleRange(random, 1, Math.max(2.5, maxDotSize * 0.45)),
          sampleRange(random, 0.2, 0.5),
          pickParticleShape(random, "scatter"),
        );
      }
    }
  }

  for (let y = posterGrid / 2; y < height; y += jointStep) {
    for (let x = posterGrid / 2; x < width; x += jointStep) {
      const px = clamp(Math.round(x), 0, width - 1);
      const py = clamp(Math.round(y), 0, height - 1);
      const index = py * width + px;
      if (!mask[index] || jointStrength[index] < 0.3 || random() > clamp(baseDensity * 0.82, 0.18, 0.78)) continue;

      const count = 2 + Math.floor(random() * 4);
      for (let i = 0; i < count; i += 1) {
        pushDot(
          px + sampleGridOffset(random, 2, posterGrid),
          py + sampleGridOffset(random, 2, posterGrid),
          sampleRange(random, 2, Math.max(4, maxDotSize * 0.68)),
          1,
          random() < 0.66 ? pickSmallDotShape(random) : pickMediumClusterShape(random),
        );
      }
    }
  }

  const structuralStep = posterGrid * Math.max(2, Math.round((baseStride * 1.7) / posterGrid));
  for (let y = posterGrid / 2; y < height; y += structuralStep) {
    for (let x = posterGrid / 2; x < width; x += structuralStep) {
      const px = clamp(Math.round(x), 0, width - 1);
      const py = clamp(Math.round(y), 0, height - 1);
      const index = py * width + px;
      if (!mask[index]) continue;

      const contour = edgeStrength[index] > 0.05;
      const bulkyPart = bodyMass[index] > 0.42;
      const keepStructure = contour ? baseDensity * 0.24 : bulkyPart ? baseDensity * 0.72 : baseDensity * 0.1;
      if (random() > clamp(keepStructure, 0.1, 0.68)) continue;

      const tangent = edgeAngle[index] + Math.PI / 2;
      const axis = contour
        ? Math.abs(Math.cos(tangent)) > Math.abs(Math.sin(tangent))
          ? 0
          : Math.PI / 2
        : random() > 0.42
          ? Math.PI / 2
          : 0;
      const runLength = 2 + Math.floor(random() * 4);
      const blockSize = sampleRange(random, bulkyPart ? 14 : 8, bulkyPart ? 28 : 14);
      const start = -(runLength - 1) / 2;

      for (let i = 0; i < runLength; i += 1) {
        const offsetCells = Math.round(((start + i) * blockSize) / posterGrid);
        const bx = px + Math.cos(axis) * offsetCells * posterGrid;
        const by = py + Math.sin(axis) * offsetCells * posterGrid;
        const sx = clamp(Math.round(bx), 0, width - 1);
        const sy = clamp(Math.round(by), 0, height - 1);
        if (!mask[sy * width + sx] && random() > noise * 0.22) continue;

        pushDot(
          bx,
          by,
          blockSize * sampleRange(random, 0.85, 1.35),
          1,
          bulkyPart && random() < 0.82
            ? axis === 0
              ? "solid-horizontal-rect"
              : "solid-vertical-rect"
            : random() < 0.36
              ? "solid-square"
              : axis === 0
                ? "horizontal-line"
                : "vertical-line",
        );
      }
    }
  }

  const scatterCount = Math.round(dots.length * clamp(noise * 0.06, 0.015, 0.08));
  for (let i = 0; i < scatterCount; i += 1) {
    const source = dots[Math.floor(random() * dots.length)];
    if (!source) break;

    const sx = clamp(Math.round(source.x), 0, width - 1);
    const sy = clamp(Math.round(source.y), 0, height - 1);
    const nearest = findNearestForeground(mask, width, height, sx, sy, 8);
    if (!nearest) continue;

    const angle = Math.atan2(sy - nearest.y, sx - nearest.x);
    const distanceCells = 1 + Math.floor(random() * Math.max(2, Math.round((baseStride * 2.4) / posterGrid)));
    pushDot(
      nearest.x + Math.round(Math.cos(angle) * distanceCells) * posterGrid,
      nearest.y + Math.round(Math.sin(angle) * distanceCells) * posterGrid,
      sampleRange(random, 1, Math.max(2.5, maxDotSize * 0.55)),
      sampleRange(random, 0.22, 0.56),
      pickParticleShape(random, "scatter"),
    );
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

  const handleUpload = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const image = new Image();
      image.onload = () => setSourceImage({ element: image, name: file.name });
      image.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  };

  const reset = () => {
    setSettings(DEFAULT_SETTINGS);
    setSourceImage(null);
    setDots([]);
    if (fileInputRef.current) fileInputRef.current.value = "";
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
            <section className="space-y-3">
              <Label>Image</Label>
              <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={handleUpload} />
              <Button className="w-full" onClick={() => fileInputRef.current?.click()}>
                <ImagePlus className="h-4 w-4" />
                Upload image
              </Button>
              <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-500">
                <div className="truncate font-medium text-slate-700">{displayName}</div>
                <div>{hasImage ? `${stats} dots generated` : "Bright backgrounds are removed automatically"}</div>
              </div>
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
