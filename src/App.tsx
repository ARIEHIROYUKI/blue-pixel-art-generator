import { ChangeEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Download, ImagePlus, RefreshCcw, Shuffle, Sparkles } from "lucide-react";
import { Button } from "./components/ui/button";
import { Label } from "./components/ui/label";
import { Slider } from "./components/ui/slider";

type DotShape = "circle" | "square";

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
  dotSize: 7,
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

  const random = mulberry32(settings.seed);
  const step = Math.round(18 - settings.density * 0.14);
  const stride = clamp(step, 3, 16);
  const noise = settings.noise / 100;
  const dots: Dot[] = [];

  for (let y = 0; y < height; y += stride) {
    for (let x = 0; x < width; x += stride) {
      const px = clamp(x + Math.floor(random() * stride), 0, width - 1);
      const py = clamp(y + Math.floor(random() * stride), 0, height - 1);
      if (!mask[py * width + px]) continue;

      const radius = Math.max(2, Math.floor(stride * 1.6));
      let edgeHits = 0;
      let total = 0;
      for (let oy = -radius; oy <= radius; oy += radius) {
        for (let ox = -radius; ox <= radius; ox += radius) {
          const sx = clamp(px + ox, 0, width - 1);
          const sy = clamp(py + oy, 0, height - 1);
          edgeHits += mask[sy * width + sx];
          total += 1;
        }
      }
      const edgeFactor = edgeHits > 0 && edgeHits < total ? 0.34 : 0;
      const keepChance = clamp(settings.density / 100 + edgeFactor - noise * 0.32, 0.08, 0.98);
      if (random() > keepChance) continue;

      const drift = noise * stride * 5.5;
      const direction = random() * Math.PI * 2;
      const distance = Math.pow(random(), 1.8) * drift;
      const burst = random() < noise * 0.18 ? 1 + random() * 3.8 : 1;
      const sizeJitter = 0.58 + random() * 1.12;
      const size = clamp(settings.dotSize * sizeJitter * (edgeFactor ? 0.9 : 1), 1.6, 34);
      const alpha = clamp(0.56 + random() * 0.42 - noise * 0.12, 0.25, 0.98);
      const shape: DotShape = random() > 0.58 ? "square" : "circle";

      dots.push({
        x: px + Math.cos(direction) * distance * burst,
        y: py + Math.sin(direction) * distance * burst,
        size,
        alpha,
        shape,
        color: settings.color,
      });

      if (edgeFactor && random() < 0.45) {
        dots.push({
          x: px + (random() - 0.5) * stride,
          y: py + (random() - 0.5) * stride,
          size: clamp(size * (0.42 + random() * 0.35), 1.2, 16),
          alpha: clamp(alpha + 0.08, 0.25, 1),
          shape: random() > 0.5 ? "square" : "circle",
          color: settings.color,
        });
      }
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
      if (dot.shape === "circle") {
        context.beginPath();
        context.arc(dot.x, dot.y, dot.size / 2, 0, Math.PI * 2);
        context.fill();
      } else {
        context.fillRect(dot.x - dot.size / 2, dot.y - dot.size / 2, dot.size, dot.size);
      }
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
    const elements = dots.map((dot) => {
      const opacity = dot.alpha.toFixed(3);
      if (dot.shape === "circle") {
        return `<circle cx="${dot.x.toFixed(2)}" cy="${dot.y.toFixed(2)}" r="${(dot.size / 2).toFixed(2)}" fill="${escapeXml(dot.color)}" opacity="${opacity}"/>`;
      }
      return `<rect x="${(dot.x - dot.size / 2).toFixed(2)}" y="${(dot.y - dot.size / 2).toFixed(2)}" width="${dot.size.toFixed(2)}" height="${dot.size.toFixed(2)}" fill="${escapeXml(dot.color)}" opacity="${opacity}"/>`;
    });
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
              <Slider label="Dot size" value={settings.dotSize} min={2} max={24} suffix="px" onChange={(value) => updateSetting("dotSize", value)} />
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
