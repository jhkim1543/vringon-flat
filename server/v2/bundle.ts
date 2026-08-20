/**
 * job_bundle.zip — "재현 가능한 모든 산출물·설정·모델 버전·seed를 포함"
 * (개발계획서 §최종 산출물 표).
 *
 * 외부 zip 의존성 없이 store(무압축) ZIP을 직접 쓴다. 압축이 목적이 아니라
 * **한 파일로 묶어 재현 세트를 넘기는 것**이 목적이고, 안에 든 PNG/SVG는
 * 이미 압축돼 있어 재압축 이득이 거의 없다.
 */
import path from "node:path";
import fs from "node:fs/promises";
import zlib from "node:zlib";

/** 번들에 넣을 것 — 중간 후보(candidates/, work/)는 용량이 커서 제외한다 */
const INCLUDE = [
  "layered.svg",
  "layer_manifest.json",
  "qa_report.json",
  "preview.png",
  "prompts.json",
  "canonical_input.png",
  "normalized.png",
];
const INCLUDE_DIRS = ["layers", "visible_masks"];

export async function bundleJob(jobDir: string): Promise<string> {
  const files: { name: string; data: Buffer }[] = [];

  for (const f of INCLUDE) {
    try {
      files.push({ name: f, data: await fs.readFile(path.join(jobDir, f)) });
    } catch { /* 없으면 건너뛴다 */ }
  }
  for (const d of INCLUDE_DIRS) {
    try {
      for (const f of await fs.readdir(path.join(jobDir, d)))
        files.push({ name: `${d}/${f}`, data: await fs.readFile(path.join(jobDir, d, f)) });
    } catch { /* 없으면 건너뛴다 */ }
  }

  const dest = path.join(jobDir, "job_bundle.zip");
  await fs.writeFile(dest, buildZip(files));
  return dest;
}

/** deflate 압축 ZIP (호환성을 위해 표준 구조만 사용) */
function buildZip(files: { name: string; data: Buffer }[]): Buffer {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const f of files) {
    const nameBuf = Buffer.from(f.name, "utf8");
    const compressed = zlib.deflateRawSync(f.data, { level: 6 });
    const crc = crc32(f.data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // local file header
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // flags: UTF-8 이름
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(0, 10); // time
    local.writeUInt16LE(0, 12); // date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(f.data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, compressed);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(8, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(compressed.length, 20);
    cd.writeUInt32LE(f.data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);

    offset += local.length + nameBuf.length + compressed.length;
  }

  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...chunks, centralBuf, end]);
}

let CRC_TABLE: Uint32Array | null = null;
function crc32(buf: Buffer): number {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
