"use strict";

/**
 * 极简 zip 打包器：只做「把一个目录压成 zip」，但把两件事做对。
 *
 * 1. **文件名一律 UTF-8**，非 ASCII 时置通用标志位 bit 11。
 *    这样 Windows 资源管理器、macOS 归档工具、7-Zip、Python zipfile 看到的名字一致。
 * 2. **偏移量严格按实际字节累加**。
 *    Info-ZIP 3.0 的 `-UN=UTF8` 会把中央目录偏移写错 6 字节：unzip 能纠错，
 *    Python / 7-Zip 直接 "Bad magic number for central directory"。
 *
 * 只支持单文件 < 4GB、条目数 < 65535（发布包远小于这个量级），所以不写 Zip64。
 */

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

/* ---------------- CRC32 ---------------- */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/* ---------------- 目录遍历 ---------------- */

function walk(dir, base, out) {
  for (const name of fs.readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    const st = fs.lstatSync(full);
    if (st.isDirectory()) walk(full, base, out);
    else if (st.isFile()) out.push({ full, rel: path.relative(base, full).replace(/\\/g, "/") });
  }
  return out;
}

/* ---------------- DOS 时间 ---------------- */

function dosTime(d) {
  const time = ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((d.getSeconds() / 2) & 0x1f);
  const date = (((d.getFullYear() - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0x0f) << 5) | (d.getDate() & 0x1f);
  return { time, date };
}

/* ---------------- 主流程 ---------------- */

/**
 * @param {string} srcDir   要打包的目录
 * @param {string} outZip   输出 zip 路径
 * @param {string} rootName zip 内的顶层目录名（"" 表示直接平铺）
 * @param {{level?:number, onFile?:Function}} [opts]
 * @returns {{files:number, bytes:number, outBytes:number}}
 */
function pack(srcDir, outZip, rootName, opts = {}) {
  const level = opts.level == null ? 6 : opts.level;
  const files = walk(srcDir, srcDir, []);
  if (files.length > 0xfffe) throw new Error("条目太多，需要 Zip64：" + files.length);

  const chunks = [];
  const central = [];
  let offset = 0;
  let raw = 0;

  for (const f of files) {
    const data = fs.readFileSync(f.full);
    const comp = zlib.deflateRawSync(data, { level });
    const name = Buffer.from(rootName ? rootName + "/" + f.rel : f.rel, "utf8");
    const nonAscii = name.some((b) => b > 0x7f);
    const flags = nonAscii ? 0x800 : 0; // bit 11 = 文件名是 UTF-8
    const crc = crc32(data);
    const dt = dosTime(fs.statSync(f.full).mtime);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(dt.time, 10);
    local.writeUInt16LE(dt.date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);

    chunks.push(local, name, comp);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4); // version made by
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(flags, 8);
    cd.writeUInt16LE(8, 10);
    cd.writeUInt16LE(dt.time, 12);
    cd.writeUInt16LE(dt.date, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(comp.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt16LE(0, 30); // extra
    cd.writeUInt16LE(0, 32); // comment
    cd.writeUInt16LE(0, 34); // disk
    cd.writeUInt16LE(0, 36); // internal attrs
    cd.writeUInt32LE(0, 38); // external attrs
    cd.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([cd, name]));

    offset += local.length + name.length + comp.length;
    raw += data.length;
    if (opts.onFile) opts.onFile(f.rel, data.length);
  }

  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  fs.writeFileSync(outZip, Buffer.concat([...chunks, cdBuf, eocd]));
  return { files: files.length, bytes: raw, outBytes: fs.statSync(outZip).size };
}

module.exports = { pack, crc32 };
