"""사내 SAM 3.1 파트 세그 워커 (H100) — vringon-flat 전용.

사내 워커(vringon-ai-workers-services `common.segmentation-sam3`)와 **같은 패키지·같은 엔진·
같은 문턱**으로 돌린다. 워커 저장소는 건드리지 않고, 벤더 런타임(`vendor/sam3_1-runtime`)과
S3 패키지만 그대로 가져와 쓴다.

두 가지 입구:
  · HTTP  : `python partseg_worker.py --serve 5202`  (모델 상주 — 운영 데모가 부른다)
        GET  /health                     → {"ok":true,"categories":[...],"loaded":[...]}
        POST /segment  X-Api-Key: <key>  {"image_b64":<png|jpg>, "category":"shoe", "threshold":0.5}
             → {"engine":"sam3.1","package":..., "width":W,"height":H,
                "classes":[{"name":..,"score":..,"instances":n,"png_b64":<white-on-black>}],
                "prompt_classes":[...]}
  · stdin : `python partseg_worker.py < req.json > res.json`  (SSH 호출용, 같은 JSON)

키는 파일 `~/vringon-flat-worker/partseg.key` 한 줄. GPU 는 시작 시 가장 빈 것을 고른다
(공유 장비 — h100-editlab 함정 1). 모델은 bf16 상주, 텍스트 인코더는 패키지 간 공유.
"""
from __future__ import annotations

import base64
import io
import json
import os
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HOME = Path.home()
SAM3_ROOT = Path(os.environ.get("SAM3_ROOT", HOME / "sam3_1"))
BUNDLE = os.environ.get("SAM3_BUNDLE", "sam3_1-worker-v1-20260820")
PKG_ROOT = Path(os.environ.get(
    "PART_SEGMENTATION_PRETRAINED_DIR",
    HOME / ".cache/vringon-ai-workers/models/part_segmentation")) / BUNDLE
KEY_FILE = HOME / "vringon-flat-worker/partseg.key"

# 사내 `segmentation_models._SAM3_PACKAGE_BY_CATEGORY` 그대로
PACKAGE_BY_CATEGORY = {
    "shoe": "vringon-shoes-260601",
    "bag": "vringon-bag-260415",
    "top/outwear-clothing": "vringon-top",
    "bottom-clothing": "vringon-bottom",
    "jewelry": "vringon-jewelry",
    "cosmetic": "vringon-cosmetic",
}


def pick_gpu() -> str:
    """가장 빈 GPU 번호 — 공유 장비라 고정하면 OOM 으로 죽는다."""
    if os.environ.get("CUDA_VISIBLE_DEVICES"):
        return os.environ["CUDA_VISIBLE_DEVICES"]
    try:
        out = subprocess.check_output(
            ["nvidia-smi", "--query-gpu=index,memory.used", "--format=csv,noheader,nounits"],
            text=True, timeout=20)
        rows = [tuple(int(v) for v in line.split(",")) for line in out.strip().splitlines()]
        rows.sort(key=lambda r: r[1])
        return str(rows[0][0])
    except Exception:
        return "0"


_gpu = pick_gpu()
os.environ["CUDA_VISIBLE_DEVICES"] = _gpu
sys.path.insert(0, str(SAM3_ROOT))
sys.path.insert(0, str(SAM3_ROOT / "sam3"))
os.environ.setdefault("SAM3_ROOT", str(SAM3_ROOT))

import numpy as np  # noqa: E402
from PIL import Image  # noqa: E402

_models: dict[str, object] = {}
_lock = threading.Lock()


def available_categories() -> list[str]:
    return [c for c, p in PACKAGE_BY_CATEGORY.items() if (PKG_ROOT / p / "weights.pt").is_file()]


def get_model(category: str):
    pkg = PACKAGE_BY_CATEGORY.get(category)
    if not pkg:
        raise ValueError(f"unsupported category: {category!r} (supported: {sorted(PACKAGE_BY_CATEGORY)})")
    pdir = PKG_ROOT / pkg
    if not (pdir / "weights.pt").is_file():
        raise FileNotFoundError(f"package not downloaded: {pdir}")
    with _lock:
        m = _models.get(category)
        if m is not None:
            return m
        from sam3_infer.engine import Sam3ConceptSegmenter
        t = time.time()
        m = Sam3ConceptSegmenter(
            str(pdir), device="cuda",
            prompt_chunk_size=int(os.environ.get("SAM3_PROMPT_CHUNK", "16")),
            offload_text_encoder=os.environ.get("SAM3_OFFLOAD_TEXT", "1") != "0",
            weights_dtype=os.environ.get("SAM3_WEIGHTS_DTYPE", "bf16"),
            share_text_encoder=True,
        )
        _models[category] = m
        print(f"[partseg] loaded {pkg} in {time.time() - t:.1f}s (gpu {_gpu})", file=sys.stderr, flush=True)
        return m


def mask_png_b64(mask: np.ndarray) -> str:
    img = Image.fromarray((mask.astype(np.uint8) * 255), mode="L")
    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=True)
    return base64.b64encode(buf.getvalue()).decode()


def segment(req: dict) -> dict:
    category = str(req.get("category", "")).strip()
    model = get_model(category)
    thr = float(req.get("threshold") or model.default_threshold)
    image = Image.open(io.BytesIO(base64.b64decode(req["image_b64"]))).convert("RGB")
    np_image = np.asarray(image)
    h, w = np_image.shape[:2]
    prompts = req.get("prompts") or model.prompt_classes
    t = time.time()
    # 사내 어댑터(SAM3TextSegmenter.segment_with_text_prompts)와 같은 경로 — 한 번의 이미지
    # 인코딩으로 전 프롬프트를 청크 배치, 마스크는 원본 해상도로.
    grouped = model._batched_masks(np_image, list(prompts), thr, mask_space="original")
    classes = []
    for name in prompts:
        masks, scores = grouped.get(name, (None, []))
        if masks is None or len(masks) == 0:
            continue
        arr = np.asarray(masks)
        arr = arr.reshape(-1, arr.shape[-2], arr.shape[-1])
        keep = [i for i, s in enumerate(scores) if float(s) >= thr]
        if not keep:
            continue
        union = np.zeros((h, w), dtype=bool)
        for i in keep:
            m = arr[i]
            if m.shape != (h, w):
                m = np.asarray(Image.fromarray(m.astype(np.uint8) * 255).resize((w, h), Image.NEAREST)) > 127
            union |= m > 0.5 if m.dtype != bool else m
        classes.append({
            "name": name,
            "score": float(max(float(scores[i]) for i in keep)),
            "instances": len(keep),
            "area": int(union.sum()),
            "png_b64": mask_png_b64(union),
        })
    return {
        "engine": "sam3.1", "package": PACKAGE_BY_CATEGORY[category], "category": category,
        "threshold": thr, "width": int(w), "height": int(h),
        "prompt_classes": list(model.prompt_classes), "classes": classes,
        "ms": int((time.time() - t) * 1000),
    }


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):  # 조용히
        print(f"[partseg] {self.address_string()} {fmt % args}", file=sys.stderr, flush=True)

    def _send(self, code: int, body: dict):
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == "/health":
            self._send(200, {"ok": True, "categories": available_categories(), "loaded": sorted(_models), "gpu": _gpu})
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/segment":
            return self._send(404, {"error": "not found"})
        key = KEY_FILE.read_text().strip() if KEY_FILE.is_file() else ""
        if key and self.headers.get("X-Api-Key", "") != key:
            return self._send(401, {"error": "unauthorized"})
        n = int(self.headers.get("Content-Length", "0"))
        try:
            req = json.loads(self.rfile.read(n))
            self._send(200, segment(req))
        except (ValueError, FileNotFoundError) as e:
            self._send(400, {"error": str(e)})
        except Exception as e:  # noqa: BLE001
            import traceback
            traceback.print_exc()
            self._send(500, {"error": f"{type(e).__name__}: {e}"})


def main():
    if "--serve" in sys.argv:
        port = int(sys.argv[sys.argv.index("--serve") + 1])
        warm = os.environ.get("PARTSEG_WARM", "")
        for c in [c for c in warm.split(",") if c]:
            try:
                get_model(c)
            except Exception as e:  # noqa: BLE001
                print(f"[partseg] warm {c} failed: {e}", file=sys.stderr, flush=True)
        srv = ThreadingHTTPServer(("0.0.0.0", port), Handler)
        print(f"[partseg] serving :{port} gpu={_gpu} packages={available_categories()}", file=sys.stderr, flush=True)
        srv.serve_forever()
    else:
        req = json.load(sys.stdin)
        json.dump(segment(req), sys.stdout)


if __name__ == "__main__":
    main()
