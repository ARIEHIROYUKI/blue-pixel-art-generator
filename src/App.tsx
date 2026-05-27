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
  | "solid-square";

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
const DEFAULT_SETTINGS: Settings = {
  density: 52,
  noise: 24,
  dotSize: 8,
  color: "#1463ff",
  background: "#f8fafc",
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
    if (roll < 0.9) return pickSmallDotShape(random);
    if (roll < 0.99) return pickMediumClusterShape(random);
    return "solid-square";
  }

  if (region === "edge") {
    if (roll < 0.46) return pickSmallDotShape(random);
    if (roll < 0.82) return pickMediumClusterShape(random);
    return "solid-square";
  }

  if (roll < 0.7) return pickSmallDotShape(random);
  if (roll < 0.9) return pickMediumClusterShape(random);
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

  if (shape === "vertical-line") return [[0, -1], [0, 0], [0, 1]];
  if (shape === "horizontal-line") return [[-1, 0], [0, 0], [1, 0]];
  if (shape === "l-shape") return [[-1, -1], [-1, 0], [-1, 1], [0, 1], [1, 1]];

  return [];
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

  if (dot.shape === "square" || dot.shape === "micro" || dot.shape === "solid-square") {
    context.fillRect(dot.x - dot.size / 2, dot.y - dot.size / 2, dot.size, dot.size);
    return;
  }

  clusterCells(dot.shape).forEach(([ox, oy]) => {
    const x = dot.x + ox * dot.size;
    const y = dot.y + oy * dot.size;
    context.fillRect(x - dot.size / 2, y - dot.size / 2, dot.size, dot.size);
  });
}

function dotToSvg(dot: Dot) {
  const opacity = dot.alpha.toFixed(3);
  const color = escapeXml(dot.color);

  if (dot.shape === "circle") {
    return `<circle cx="${dot.x.toFixed(2)}" cy="${dot.y.toFixed(2)}" r="${(dot.size / 2).toFixed(2)}" fill="${color}" opacity="${opacity}"/>`;
  }

  if (dot.shape === "square" || dot.shape === "micro" || dot.shape === "solid-square") {
    return `<rect x="${(dot.x - dot.size / 2).toFixed(2)}" y="${(dot.y - dot.size / 2).toFixed(2)}" width="${dot.size.toFixed(2)}" height="${dot.size.toFixed(2)}" fill="${color}" opacity="${opacity}"/>`;
  }

  return clusterCells(dot.shape)
    .map(([ox, oy]) => {
      const x = dot.x + ox * dot.size;
      const y = dot.y + oy * dot.size;
      return `<rect x="${(x - dot.size / 2).toFixed(2)}" y="${(y - dot.size / 2).toFixed(2)}" width="${dot.size.toFixed(2)}" height="${dot.size.toFixed(2)}" fill="${color}" opacity="${opacity}"/>`;
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

  const mask = new Uint8Array(width * height);
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
  const flowAngle = sampleRange(random, -0.35, 0.35) + (random() > 0.5 ? 0 : Math.PI);
  const edgeDensityBoost = 3 + random() * 2;
  const dots: Dot[] = [];

  const pushDot = (x: number, y: number, size: number, alpha: number, shape: DotShape) => {
    const cellSize = shape === "micro" ? clamp(size * 0.45, 1, 2.4) : clamp(size, 1, 8);
    const finalSize = shape === "solid-square" ? clamp(size, 5, 16) : cellSize;

    dots.push({
      x,
      y,
      size: finalSize,
      alpha,
      shape,
      color: settings.color,
    });
  };

  const outwardAngle = (x: number, y: number, angle: number) => {
    const forwardX = clamp(Math.round(x + Math.cos(angle) * 3), 0, width - 1);
    const forwardY = clamp(Math.round(y + Math.sin(angle) * 3), 0, height - 1);
    return mask[forwardY * width + forwardX] ? angle + Math.PI : angle;
  };

  for (let y = random() * baseStride; y < height; y += baseStride * sampleRange(random, 0.72, 1.34)) {
    for (let x = random() * baseStride; x < width; x += baseStride * sampleRange(random, 0.68, 1.42)) {
      const px = clamp(Math.round(x + sampleRange(random, -baseStride * 0.58, baseStride * 0.58)), 0, width - 1);
      const py = clamp(Math.round(y + sampleRange(random, -baseStride * 0.58, baseStride * 0.58)), 0, height - 1);
      const index = py * width + px;
      const inMask = mask[index] === 1;
      const edge = edgeStrength[index];
      const nearEdge = edge > 0.08;
      const scatterCandidate = !inMask && nearEdge && random() < noise * 0.18;

      if (!inMask && !scatterCandidate) continue;

      const regionChance = inMask
        ? nearEdge
          ? baseDensity * edgeDensityBoost
          : baseDensity * 0.34
        : baseDensity * 0.18;

      if (random() > clamp(regionChance, 0.03, 0.96)) continue;

      const normal = outwardAngle(px, py, edgeAngle[index]);
      const localFlow = flowAngle + Math.sin((px + py) * 0.015 + settings.seed) * 0.32;
      const flowDistance = Math.pow(random(), 1.5) * baseStride * (0.55 + noise * 2.8);
      const normalDistance = scatterCandidate ? sampleRange(random, baseStride * 0.35, baseStride * 1.65) : sampleRange(random, -baseStride * 0.22, baseStride * 0.22);
      const dotX = px + Math.cos(localFlow) * flowDistance + Math.cos(normal) * normalDistance;
      const dotY = py + Math.sin(localFlow) * flowDistance + Math.sin(normal) * normalDistance;
      const size = nearEdge
        ? sampleRange(random, Math.max(3.2, maxDotSize * 0.62), maxDotSize)
        : sampleRange(random, 1, Math.max(2.4, maxDotSize * 0.52));
      const alpha = clamp(nearEdge ? sampleRange(random, 0.72, 1) : sampleRange(random, 0.28, 0.68), 0.18, 1);
      const shape = pickParticleShape(random, nearEdge ? "edge" : "inside");

      pushDot(dotX, dotY, size, alpha, shape);

      if (nearEdge && inMask) {
        const extraCount = 1 + Math.floor(random() * 3);
        for (let i = 0; i < extraCount; i += 1) {
          if (random() > baseDensity * 0.8) continue;
          const echoDistance = sampleRange(random, 0, baseStride * 0.9);
          const echoFlow = localFlow + sampleRange(random, -0.6, 0.6);
          pushDot(
            px + Math.cos(echoFlow) * echoDistance + sampleRange(random, -2.5, 2.5),
            py + Math.sin(echoFlow) * echoDistance + sampleRange(random, -2.5, 2.5),
            sampleRange(random, Math.max(2.8, maxDotSize * 0.48), maxDotSize),
            sampleRange(random, 0.62, 0.96),
            pickParticleShape(random, "edge"),
          );
        }
      }

      if (nearEdge && random() < 0.12 + noise * 0.12) {
        pushDot(
          px + sampleRange(random, -baseStride * 0.4, baseStride * 0.4),
          py + sampleRange(random, -baseStride * 0.4, baseStride * 0.4),
          sampleRange(random, 6, 14),
          sampleRange(random, 0.78, 1),
          "solid-square",
        );
      }
    }
  }

  const edgeStride = Math.max(2, Math.round(baseStride * 0.42));
  for (let y = random() * edgeStride; y < height; y += edgeStride * sampleRange(random, 0.82, 1.28)) {
    for (let x = random() * edgeStride; x < width; x += edgeStride * sampleRange(random, 0.82, 1.28)) {
      const px = clamp(Math.round(x + sampleRange(random, -edgeStride, edgeStride)), 0, width - 1);
      const py = clamp(Math.round(y + sampleRange(random, -edgeStride, edgeStride)), 0, height - 1);
      const index = py * width + px;
      if (!mask[index] || edgeStrength[index] < 0.08 || random() > clamp(baseDensity * 0.92, 0.16, 0.94)) continue;

      const tangent = edgeAngle[index] + Math.PI / 2 + sampleRange(random, -0.45, 0.45);
      const normal = outwardAngle(px, py, edgeAngle[index]);
      const repeats = 1 + Math.floor(random() * edgeDensityBoost * 0.62);

      for (let i = 0; i < repeats; i += 1) {
        const along = sampleRange(random, -baseStride * 0.7, baseStride * 0.7);
        const lift = sampleRange(random, -baseStride * 0.18, baseStride * 0.32);
        pushDot(
          px + Math.cos(tangent) * along + Math.cos(normal) * lift,
          py + Math.sin(tangent) * along + Math.sin(normal) * lift,
          sampleRange(random, Math.max(3.2, maxDotSize * 0.62), maxDotSize),
          sampleRange(random, 0.74, 1),
          pickParticleShape(random, "edge"),
        );
      }

      if (random() < noise * 0.22) {
        pushDot(
          px + Math.cos(normal) * sampleRange(random, baseStride * 0.85, baseStride * 2.2),
          py + Math.sin(normal) * sampleRange(random, baseStride * 0.85, baseStride * 2.2),
          sampleRange(random, 1, Math.max(2.5, maxDotSize * 0.45)),
          sampleRange(random, 0.2, 0.5),
          pickParticleShape(random, "scatter"),
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

    const angle = Math.atan2(sy - nearest.y, sx - nearest.x) + sampleRange(random, -0.75, 0.75);
    const distance = sampleRange(random, baseStride * 0.65, baseStride * 2.4);
    pushDot(
      nearest.x + Math.cos(angle) * distance,
      nearest.y + Math.sin(angle) * distance,
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
