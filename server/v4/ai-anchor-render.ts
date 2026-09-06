/**
 * `.ai` **파일 자체**에서 앵커를 뽑아 그린다.
 *
 * 앞서 쓰던 `anchor-render.ts` 는 SVG 를 읽었다. SVG 와 `.ai` 는 같은 장면을 담지만 표현이
 * 다르다 — 특히 반복 패턴은 SVG 에서 `<use>` 참조지만 `.ai` 는 인스턴스마다 실제 패스로
 * 펼친다. 그래서 "SVG 기준 앵커"와 "Illustrator 가 보여 주는 앵커"가 어긋났다.
 *
 * 여기서는 어긋날 여지를 없앤다. `.ai` 의 내용 스트림을 직접 파싱해
 * `m`/`l`/`c` 의 좌표를 그대로 읽고, 배경 그림도 poppler 로 **그 .ai 를 구워** 깐다.
 * 즉 그림과 점이 모두 배포되는 파일 하나에서 나온다.
 *
 *   npx tsx server/v4/ai-anchor-render.ts <샘플> [out.png] [--zoom=x,y,w,h] [--long 1500]
 *
 * 색은 앵커의 성질을 나눈다.
 *   파랑  곡선 앵커 (`c` 로 도착) — 부드러운 지점
 *   빨강  꺾임 앵커 (`m`/`l` 로 도착) — 모서리·조각 시작
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import sharp from "sharp";

const run = (cmd: string, args: string[]) =>
  new Promise<void>((res, rej) => {
    const p = spawn(cmd, args, { stdio: "ignore" });
    p.on("error", rej);
    p.on("close", (c) => (c === 0 ? res() : rej(new Error(`${cmd} exit ${c}`))));
  });

export interface AiAnchors {
  dots: { x: number; y: number; corner: boolean; layer: string }[];
  handles: [number, number, number, number][];
  /** PDF 페이지 크기(pt) */
  page: [number, number];
  byLayer: Map<string, number>;
}

/**
 * `.ai`(OCG 를 쓴 PDF)에서 앵커를 읽는다.
 *
 * 좌표계가 다르다 — PDF 는 왼쪽 **아래**가 원점이고 y 가 위로 간다. 뒤집지 않으면 그림이
 * 상하로 뒤집힌 채 점만 맞는 이상한 결과가 나온다.
 */
export async function readAiAnchors(aiPath: string): Promise<AiAnchors> {
  const pdf = await fs.readFile(aiPath, "latin1");
  const box = new RegExp("/MediaBox \\[0 0 ([\\d.]+) ([\\d.]+)\\]").exec(pdf);
  if (!box) throw new Error("MediaBox 를 찾지 못했다");
  const pw = Number(box[1]), ph = Number(box[2]);

  // /oc0 → 레이어 이름
  const ocName = new Map<string, string>();
  const objName = new Map<string, string>();
  for (const m of pdf.matchAll(new RegExp("(\\d+) 0 obj\\s*<<[^>]*?/Type\\s*/OCG[^>]*?/Name\\s*\\(([^)]*)\\)", "g"))) {
    objName.set(m[1], m[2]);
  }
  const props = new RegExp("/Properties\\s*<<([^>]*)>>").exec(pdf);
  if (props) {
    for (const m of props[1].matchAll(new RegExp("/(oc\\d+)\\s+(\\d+) 0 R", "g"))) {
      ocName.set(m[1], objName.get(m[2]) ?? m[1]);
    }
  }

  // 내용 스트림 — aiExport 는 압축하지 않는다(/Filter 없음)
  // **스트림이 하나가 아니다.** 반복 모티프는 Form XObject 로 따로 정의되고 페이지는
  // `/M… Do` 로 부르기만 한다. 첫 스트림만 읽으면 모티프 앵커가 통째로 빠져 수치가
  // 실제보다 적게 나온다. 모티프는 **한 번만** 센다 — 파일에 한 벌만 들어 있으니까.
  const streams = [];
  {
    let at = 0;
    for (;;) {
      const si = pdf.indexOf("stream" + String.fromCharCode(10), at);
      if (si < 0) break;
      const ei = pdf.indexOf("endstream", si);
      if (ei < 0) break;
      streams.push(pdf.slice(si + 7, ei));
      at = ei + 9;
    }
  }
  if (!streams.length) throw new Error("내용 스트림을 찾지 못했다");
  const body = streams.join(String.fromCharCode(10));

  const dots: AiAnchors["dots"] = [];
  const handles: AiAnchors["handles"] = [];
  const byLayer = new Map<string, number>();
  const stack: number[] = [];
  const ocStack: string[] = [];
  const flip = (y: number) => ph - y;
  const add = (x: number, y: number, corner: boolean) => {
    // BDC 는 **기능 레이어 → 파트 하위레이어** 순으로 중첩된다. 집계는 바깥쪽(기능
    // 레이어)으로 한다 — 하위레이어로 세면 파트 수만큼 쪼개져 한눈에 안 들어온다.
    const layer = ocStack.length ? ocStack[ocStack.length - 1] : "(없음)";
    dots.push({ x, y: flip(y), corner, layer });
    byLayer.set(layer, (byLayer.get(layer) ?? 0) + 1);
  };

  // 토큰 훑기 — 숫자는 쌓고, 연산자를 만나면 소비한다
  const TOKEN = new RegExp("(-?\\d*\\.?\\d+)|(/oc\\d+)|(BDC|EMC|[mlc])", "g");
  let t: RegExpExecArray | null;
  let pendingOc: string | null = null;
  while ((t = TOKEN.exec(body))) {
    if (t[1] !== undefined) { stack.push(Number(t[1])); continue; }
    // `/oc0` 로 잡히지만 `ocName` 의 키는 슬래시가 없다 — 붙여 두면 조용히 전부 "(없음)" 이 된다
    if (t[2] !== undefined) { pendingOc = t[2].slice(1); continue; }
    const op = t[3];
    if (op === "BDC") { ocStack.unshift(ocName.get(pendingOc ?? "") ?? "(없음)"); pendingOc = null; stack.length = 0; continue; }
    if (op === "EMC") { ocStack.shift(); stack.length = 0; continue; }
    if (op === "m" || op === "l") {
      const n = stack.length;
      if (n >= 2) add(stack[n - 2], stack[n - 1], true);
    } else if (op === "c") {
      const n = stack.length;
      if (n >= 6) {
        handles.push([stack[n - 6], flip(stack[n - 5]), stack[n - 4], flip(stack[n - 3])]);
        add(stack[n - 2], stack[n - 1], false);
      }
    }
    stack.length = 0;
  }
  return { dots, handles, page: [pw, ph], byLayer };
}

// ── CLI ─────────────────────────────────────────────────────
if (process.argv[1]?.replace(new RegExp("\\\\", "g"), "/").endsWith("ai-anchor-render.ts")) {
  const argv = process.argv.slice(2);
  const name = argv.find((a) => !a.startsWith("--")) ?? "bag_1";
  const outs = argv.filter((a) => !a.startsWith("--"));
  const out = outs[1] ?? `outputs/v4/_verify/ai_anchors_${name}.png`;
  const autoArg = argv.find((a) => a.startsWith("--auto-zoom="));
  const tilesArg = argv.find((a) => a.startsWith("--tiles="));
  const winArg = argv.find((a) => a.startsWith("--win="));
  const zoomArg = argv.find((a) => a.startsWith("--zoom="));
  const longArg = argv.find((a) => a.startsWith("--long="));
  const LONG = Number(longArg?.slice(7) ?? 1500);
  const aiPath = `outputs/v4/v4_${name}/layered.ai`;

  const { dots, handles, page, byLayer } = await readAiAnchors(aiPath);
  const [pw, ph] = page;

  /**
   * 앵커가 몰린 창을 **겹치지 않게** 고른다.
   *
   * 손으로 좌표를 찍으면 제품마다 다시 찾아야 하고, "좋아 보이는 곳만 골랐다"는 의심을 살
   * 이유도 없다. 가장 빽빽한 곳부터 고르되, 한 번 고른 창은 지워서 같은 자리를 또 안 잡는다.
   */
  function pickWindows(win: number, count: number): [number, number, number, number][] {
    const wh = Math.round(win * 0.42);
    const cell = Math.max(8, Math.round(win / 6));
    const grid = new Map<string, number>();
    const key = (gx: number, gy: number) => `${gx},${gy}`;
    for (const d of dots) {
      const k = key(Math.floor(d.x / cell), Math.floor(d.y / cell));
      grid.set(k, (grid.get(k) ?? 0) + 1);
    }
    const cx = Math.ceil(win / cell), cy = Math.ceil(wh / cell);
    const picked: [number, number, number, number][] = [];
    for (let t = 0; t < count; t++) {
      let bx = 0, by = 0, bn = 0;
      for (const k of grid.keys()) {
        const [gx, gy] = k.split(",").map(Number);
        let n = 0;
        for (let i = 0; i < cx; i++) for (let j = 0; j < cy; j++) n += grid.get(key(gx + i, gy + j)) ?? 0;
        if (n > bn) { bn = n; bx = gx; by = gy; }
      }
      if (bn <= 0) break;
      picked.push([Math.max(0, bx * cell), Math.max(0, by * cell), win, wh]);
      // 고른 창은 비운다 — 안 그러면 한 칸 옆을 계속 다시 고른다
      for (let i = 0; i < cx; i++) for (let j = 0; j < cy; j++) grid.delete(key(bx + i, by + j));
    }
    return picked;
  }

  const winSize = Number(winArg?.slice(6) ?? autoArg?.slice(12) ?? 260) || 260;
  const windows: [number, number, number, number][] = zoomArg
    ? [zoomArg.slice(7).split(",").map(Number) as [number, number, number, number]]
    : tilesArg
      ? pickWindows(winSize, Number(tilesArg.slice(8)) || 4)
      : autoArg
        ? pickWindows(winSize, 1)
        : [];

  // 배경은 그 .ai 를 poppler 로 구운 것 — 우리 코드가 아닌 제3의 렌더러.
  // **확대할 때는 잘라 낼 창이 목표 너비가 되도록 페이지를 크게 굽는다.** 페이지 크기로
  // 굽고 나서 확대하면 배경만 뭉개져, 선명한 점이 흐린 그림 위에 뜬 그림이 된다.
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "aianc-"));
  const ZOOM_OUT = 1500;
  const zw0 = windows.length ? windows[0][2] : 0;
  const long = zw0 > 0 ? Math.min(12000, Math.round((ZOOM_OUT * pw) / zw0)) : LONG;
  const W = Math.round(pw >= ph ? long : long * (pw / ph));
  const H = Math.round(pw >= ph ? long * (ph / pw) : long);
  await run("pdftoppm", ["-png", "-r", "150", "-singlefile", "-scale-to-x", String(W), "-scale-to-y", String(H), aiPath, path.join(tmp, "page")]);
  const base = await sharp(path.join(tmp, "page.png")).flatten({ background: "#ffffff" }).png().toBuffer();

  const s = W / pw;
  const R = Math.max(1.7, Math.min(W, H) * 0.0018);
  const overlay =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">` +
    `<g stroke="#b9c4d0" stroke-width="${R * 0.45}" fill="none" opacity="0.85">` +
    handles.map(([x1, y1, x2, y2]) =>
      `<path d="M${(x1 * s).toFixed(1)} ${(y1 * s).toFixed(1)}L${(x2 * s).toFixed(1)} ${(y2 * s).toFixed(1)}"/>`).join("") +
    `</g><g>` +
    dots.map((d) =>
      `<circle cx="${(d.x * s).toFixed(1)}" cy="${(d.y * s).toFixed(1)}" r="${R}" ` +
      `fill="${d.corner ? "#e0342c" : "#2f6fd0"}" stroke="#fff" stroke-width="${R * 0.3}"/>`).join("") +
    `</g></svg>`;

  const composed = await sharp(base).composite([{ input: Buffer.from(overlay), top: 0, left: 0 }]).png().toBuffer();

  const corners = dots.filter((d) => d.corner).length;
  const layers = [...byLayer.entries()].sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k} ${v.toLocaleString()}`).join("  ·  ");
  const FONT = "Segoe UI, Malgun Gothic, sans-serif";
  const capH = 92;

  await fs.mkdir(path.dirname(out), { recursive: true });
  const ext = path.extname(out) || ".png";
  const stem = out.slice(0, out.length - ext.length);

  /** 한 창(또는 전체)을 잘라 머리말을 얹어 저장 */
  const emit = async (win: [number, number, number, number] | null, dest: string, note: string) => {
    let img = sharp(composed);
    let outW = W, outH = H;
    if (win) {
      const [zx, zy, zw, zh] = win;
      const left = Math.max(0, Math.min(W - 2, Math.round(zx * s)));
      const top = Math.max(0, Math.min(H - 2, Math.round(zy * s)));
      img = img.extract({
        left, top,
        width: Math.min(W - left, Math.round(zw * s)),
        height: Math.min(H - top, Math.round(zh * s)),
      }).resize({ width: ZOOM_OUT, withoutEnlargement: false });
      const mm = await sharp(await img.png().toBuffer()).metadata();
      outW = mm.width!; outH = mm.height!;
    }
    const png = await img.png().toBuffer();
    const cap =
      `<svg xmlns="http://www.w3.org/2000/svg" width="${outW}" height="${capH}">` +
      `<rect width="${outW}" height="${capH}" fill="#fff"/>` +
      `<text x="18" y="32" font-family="${FONT}" font-size="25" font-weight="700" fill="#111">` +
      `${name}.ai — 앵커 ${dots.length.toLocaleString()}개${note}</text>` +
      `<circle cx="27" cy="58" r="7" fill="#2f6fd0"/><text x="42" y="65" font-family="${FONT}" font-size="18" fill="#444">곡선 ${(dots.length - corners).toLocaleString()}</text>` +
      `<circle cx="175" cy="58" r="7" fill="#e0342c"/><text x="190" y="65" font-family="${FONT}" font-size="18" fill="#444">꺾임 ${corners.toLocaleString()}</text>` +
      `<text x="18" y="85" font-family="${FONT}" font-size="15" fill="#888">레이어별 ${layers}</text>` +
      `</svg>`;
    await sharp({ create: { width: outW, height: outH + capH, channels: 3, background: "#ffffff" } })
      .composite([{ input: Buffer.from(cap), top: 0, left: 0 }, { input: png, top: capH, left: 0 }])
      .png().toFile(dest);
  };

  if (!windows.length) {
    await emit(null, out, "");
  } else if (windows.length === 1) {
    await emit(windows[0], out, `  ·  확대 ${windows[0][0]},${windows[0][1]}`);
  } else {
    for (let i = 0; i < windows.length; i++) {
      const w = windows[i];
      await emit(w, `${stem}_${i + 1}${ext}`, `  ·  확대 ${i + 1}/${windows.length} (${w[0]},${w[1]})`);
    }
  }
  await fs.rm(tmp, { recursive: true, force: true });

  const where = windows.length > 1 ? `${stem}_1..${windows.length}${ext}` : out;
  console.log(`${name}.ai → ${where}  앵커 ${dots.length} (곡선 ${dots.length - corners} · 꺾임 ${corners})`);
}
