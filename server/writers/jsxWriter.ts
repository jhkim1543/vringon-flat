import type { VectorIR } from "../types.js";
import { parsePath } from "../vector/pathdata.js";

/**
 * Illustrator ExtendScript(.jsx) 생성기.
 *
 * Illustrator가 설치된 PC에서: 파일 > 스크립트 > 기타 스크립트(Ctrl+F12)로
 * 이 .jsx를 실행하면 레이어/그룹/패스가 Illustrator DOM으로 재구성되고
 * 진짜 네이티브 .ai로 저장된다. Adobe Firefly Services의 Custom Scripts
 * API 계정이 생기면 같은 스크립트를 서버 실행으로 올리면 된다.
 *
 * 좌표계: Illustrator 스크립팅은 y가 위로 증가 → y_il = -y_img.
 */
export function buildJsx(ir: VectorIR, outName: string): string {
  // anchor: [ax, ay, lx, ly, rx, ry] (left/right 핸들 포함, 이미지 좌표)
  type AnchorRow = number[];
  const data = ir.layers.map((layer) => ({
    n: layer.name,
    g: layer.groups.map((group) => ({
      n: group.name,
      p: group.paths.map((p) => {
        const subs = parsePath(p.d);
        return {
          f: p.fill,
          s: p.stroke,
          w: p.strokeWidth,
          sp: subs.map((sub) => {
            const anchors: AnchorRow[] = [];
            const pts = [sub.start, ...sub.segs.map((s) => s.end)];
            const n = sub.segs.length + 1;
            for (let i = 0; i < n; i++) {
              // 닫힌 패스면 마지막 anchor(=start 중복)는 건너뛰고 핸들을 첫 anchor로 넘김
              if (sub.closed && i === n - 1) break;
              const a = pts[i];
              const inSeg = i > 0 ? sub.segs[i - 1] : sub.closed ? sub.segs[n - 2] : null;
              const outSeg = i < sub.segs.length ? sub.segs[i] : null;
              const left = inSeg?.type === "C" ? inSeg.c2! : a;
              const right = outSeg?.type === "C" ? outSeg.c1! : a;
              anchors.push([a[0], a[1], left[0], left[1], right[0], right[1]].map(r2));
            }
            return { c: sub.closed ? 1 : 0, a: anchors };
          }),
        };
      }),
    })),
  }));

  return `// vringon-flat generated script — creates layered native .ai
// 실행: Illustrator > File > Scripts > Other Script... 로 이 파일 선택
var DATA = ${JSON.stringify(data)};
var W = ${ir.width}, H = ${ir.height};

var doc = app.documents.add(DocumentColorSpace.RGB, W, H);
app.executeMenuCommand && app.coordinateSystem !== undefined &&
  (app.coordinateSystem = CoordinateSystem.ARTBOARDCOORDINATESYSTEM);

function rgb(hex) {
  var c = new RGBColor();
  c.red = parseInt(hex.substr(1, 2), 16);
  c.green = parseInt(hex.substr(3, 2), 16);
  c.blue = parseInt(hex.substr(5, 2), 16);
  return c;
}

function buildPathItem(container, sub, spec) {
  var item = container.pathItems.add();
  item.closed = sub.c === 1;
  for (var i = 0; i < sub.a.length; i++) {
    var r = sub.a[i];
    var pp = item.pathPoints.add();
    pp.anchor = [r[0], -r[1]];
    pp.leftDirection = [r[2], -r[3]];
    pp.rightDirection = [r[4], -r[5]];
    pp.pointType = PointType.SMOOTH;
    if (r[2] === r[0] && r[3] === r[1] && r[4] === r[0] && r[5] === r[1])
      pp.pointType = PointType.CORNER;
  }
  applyStyle(item, spec);
  return item;
}

function applyStyle(item, spec) {
  item.filled = !!spec.f;
  if (spec.f) item.fillColor = rgb(spec.f);
  item.stroked = !!spec.s;
  if (spec.s) {
    item.strokeColor = rgb(spec.s);
    item.strokeWidth = spec.w || 1;
  }
}

// IR 배열은 페인팅 순서(아래→위). layers.add()는 위에 쌓이므로
// 순방향 생성 시 마지막 IR 레이어(Linework)가 최상단이 된다.
var baseLayer = doc.layers[0];
for (var li = 0; li < DATA.length; li++) {
  var L = DATA[li];
  var layer = doc.layers.add();
  layer.name = L.n;
  for (var gi = 0; gi < L.g.length; gi++) {
    var G = L.g[gi];
    var grp = layer.groupItems.add();
    grp.name = G.n;
    for (var pi = 0; pi < G.p.length; pi++) {
      var P = G.p[pi];
      if (P.sp.length > 1 && P.f) {
        // 구멍이 있는 도형 → CompoundPath
        var cp = grp.compoundPathItems.add();
        for (var si = 0; si < P.sp.length; si++) buildPathItem(cp, P.sp[si], P);
      } else {
        for (var sj = 0; sj < P.sp.length; sj++) buildPathItem(grp, P.sp[sj], P);
      }
    }
  }
}
baseLayer.remove();

// 저장 — 스크립트 파일과 같은 폴더에 네이티브 .ai 생성
var scriptFile = new File($.fileName);
var outFile = new File(scriptFile.parent + "/${outName}");
var opts = new IllustratorSaveOptions();
opts.compatibility = Compatibility.ILLUSTRATOR17;
opts.pdfCompatible = true;
doc.saveAs(outFile, opts);
alert("완료: " + outFile.fsName);
`;
}

function r2(n: number): number {
  return Math.round(n * 100) / 100;
}
