const MAX_ENTRIES = 4096;
const MAX_ENTRY_SIZE = 64 * 1024 * 1024;
const MAX_TOTAL_SIZE = 256 * 1024 * 1024;
const UTF8_FLAG = 0x0800;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8');
let crcTable;

function zipError(message) {
  const error = new Error(message);
  error.name = 'ZipError';
  return error;
}

function table() {
  if (crcTable) return crcTable;
  crcTable = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let value = n;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) ? (0xEDB88320 ^ (value >>> 1)) : (value >>> 1);
    }
    crcTable[n] = value >>> 0;
  }
  return crcTable;
}

function crc32(bytes) {
  const values = table();
  let crc = 0xFFFFFFFF;
  for (let index = 0; index < bytes.length; index += 1) {
    crc = values[(crc ^ bytes[index]) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function inputBytes(value, label = 'ZIP 数据') {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw zipError(`${label}必须是 ArrayBuffer 或 Uint8Array`);
}

function need(view, offset, length, message = 'ZIP 数据不完整或已损坏') {
  if (!Number.isInteger(offset) || !Number.isInteger(length) || offset < 0 || length < 0 || offset + length > view.byteLength) {
    throw zipError(message);
  }
}

function u16(view, offset) {
  need(view, offset, 2);
  return view.getUint16(offset, true);
}

function u32(view, offset) {
  need(view, offset, 4);
  return view.getUint32(offset, true);
}

function checkName(name) {
  if (typeof name !== 'string' || !name || name.includes('\0')) {
    throw zipError('ZIP 条目名称不能为空，且不能包含 NUL 字符');
  }
  if (name.includes('\\') || name.startsWith('/') || /^[A-Za-z]:/.test(name) || name.split('/').includes('..')) {
    throw zipError(`ZIP 条目“${name}”存在路径穿越风险`);
  }
  return name;
}

function findEnd(view) {
  if (view.byteLength < 22) throw zipError('文件不是有效的 ZIP：缺少结束目录');
  const earliest = Math.max(0, view.byteLength - 22 - 65535);
  for (let offset = view.byteLength - 22; offset >= earliest; offset -= 1) {
    if (u32(view, offset) !== 0x06054B50) continue;
    const commentLength = u16(view, offset + 20);
    if (offset + 22 + commentLength === view.byteLength) return offset;
  }
  throw zipError('文件不是有效的 ZIP：找不到中央目录结束记录');
}

function decodeName(bytes, utf8) {
  try {
    return utf8 ? new TextDecoder('utf-8', { fatal: true }).decode(bytes) : decoder.decode(bytes);
  } catch {
    throw zipError('ZIP 条目名称不是有效的 UTF-8 文本');
  }
}

function concatenate(chunks, size) {
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

async function inflate(raw, expectedSize, name) {
  if (typeof DecompressionStream !== 'function') {
    throw zipError('当前浏览器不支持 DecompressionStream，无法读取 Deflate 压缩条目');
  }
  const chunks = [];
  let size = 0;
  let reader;
  try {
    const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    reader = stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > expectedSize || size > MAX_ENTRY_SIZE || size > MAX_TOTAL_SIZE) {
        await reader.cancel();
        throw zipError(`ZIP 条目“${name}”的实际解压大小超出声明，疑似 ZIP 炸弹`);
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error && error.name === 'ZipError') throw error;
    throw zipError(`ZIP 条目“${name}”的 Deflate 数据无法解压或已损坏`);
  }
  if (size !== expectedSize) {
    throw zipError(`ZIP 条目“${name}”的解压大小与中央目录不一致`);
  }
  return concatenate(chunks, size);
}

/** Read a ZIP through its central directory. bytes() and text() are asynchronous. */
export async function readZip(buffer) {
  const bytes = inputBytes(buffer);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const endOffset = findEnd(view);
  const disk = u16(view, endOffset + 4);
  const centralDisk = u16(view, endOffset + 6);
  const diskEntries = u16(view, endOffset + 8);
  const count = u16(view, endOffset + 10);
  const centralSize = u32(view, endOffset + 12);
  const centralOffset = u32(view, endOffset + 16);

  if (count === 0xFFFF || diskEntries === 0xFFFF || centralSize === 0xFFFFFFFF || centralOffset === 0xFFFFFFFF ||
      (endOffset >= 20 && u32(view, endOffset - 20) === 0x07064B50)) {
    throw zipError('暂不支持 ZIP64 压缩包');
  }
  if (disk !== 0 || centralDisk !== 0 || diskEntries !== count) {
    throw zipError('暂不支持跨磁盘 ZIP 压缩包');
  }
  if (count > MAX_ENTRIES) throw zipError(`ZIP 条目数不能超过 ${MAX_ENTRIES}`);
  need(view, centralOffset, centralSize, 'ZIP 中央目录越界或已损坏');
  if (centralOffset + centralSize > endOffset) throw zipError('ZIP 中央目录位置无效');

  const entries = [];
  const byName = new Map();
  const cache = new Map();
  let offset = centralOffset;
  let declaredTotal = 0;
  for (let index = 0; index < count; index += 1) {
    need(view, offset, 46, 'ZIP 中央目录条目不完整');
    if (u32(view, offset) !== 0x02014B50) throw zipError('ZIP 中央目录条目签名无效');
    const flags = u16(view, offset + 8);
    const method = u16(view, offset + 10);
    const crc = u32(view, offset + 16);
    const compressedSize = u32(view, offset + 20);
    const uncompressedSize = u32(view, offset + 24);
    const nameLength = u16(view, offset + 28);
    const extraLength = u16(view, offset + 30);
    const commentLength = u16(view, offset + 32);
    const startDisk = u16(view, offset + 34);
    const localOffset = u32(view, offset + 42);
    const next = offset + 46 + nameLength + extraLength + commentLength;
    need(view, offset + 46, nameLength + extraLength + commentLength, 'ZIP 中央目录条目越界');
    if (next > centralOffset + centralSize) throw zipError('ZIP 中央目录大小不一致');
    if (compressedSize === 0xFFFFFFFF || uncompressedSize === 0xFFFFFFFF || localOffset === 0xFFFFFFFF || startDisk === 0xFFFF) {
      throw zipError('暂不支持 ZIP64 压缩包');
    }
    if (startDisk !== 0) throw zipError('暂不支持跨磁盘 ZIP 压缩包');
    if ((flags & 0x0001) || (flags & 0x0040)) throw zipError('暂不支持加密的 ZIP 条目');
    if (method !== 0 && method !== 8) throw zipError(`暂不支持 ZIP 压缩方法 ${method}，仅支持 stored 和 Deflate`);
    if (uncompressedSize > MAX_ENTRY_SIZE) throw zipError(`ZIP 单条解压大小不能超过 ${MAX_ENTRY_SIZE / 1024 / 1024} MiB`);
    declaredTotal += uncompressedSize;
    if (declaredTotal > MAX_TOTAL_SIZE) throw zipError(`ZIP 总解压大小不能超过 ${MAX_TOTAL_SIZE / 1024 / 1024} MiB`);

    const nameBytes = bytes.slice(offset + 46, offset + 46 + nameLength);
    const name = checkName(decodeName(nameBytes, Boolean(flags & UTF8_FLAG)));
    if (byName.has(name)) throw zipError(`ZIP 中存在重复条目“${name}”`);
    const entry = { name, nameBytes, flags, method, crc, compressedSize, uncompressedSize, localOffset };
    entries.push(entry);
    byName.set(name, entry);
    offset = next;
  }
  if (offset !== centralOffset + centralSize) throw zipError('ZIP 中央目录含有无法识别的额外数据');

  async function extract(entry) {
    const local = entry.localOffset;
    need(view, local, 30, `ZIP 条目“${entry.name}”的本地文件头越界`);
    if (local + 30 > centralOffset || u32(view, local) !== 0x04034B50) {
      throw zipError(`ZIP 条目“${entry.name}”的本地文件头无效`);
    }
    const localFlags = u16(view, local + 6);
    const localMethod = u16(view, local + 8);
    if ((localFlags & 0x0001) || (localFlags & 0x0040)) throw zipError(`ZIP 条目“${entry.name}”已加密，暂不支持`);
    if (localMethod !== entry.method) throw zipError(`ZIP 条目“${entry.name}”的本地与中央压缩方法不一致`);
    if (u32(view, local + 18) === 0xFFFFFFFF || u32(view, local + 22) === 0xFFFFFFFF) {
      throw zipError('暂不支持 ZIP64 压缩包');
    }
    const localNameLength = u16(view, local + 26);
    const localExtraLength = u16(view, local + 28);
    const dataOffset = local + 30 + localNameLength + localExtraLength;
    need(view, local + 30, localNameLength + localExtraLength, `ZIP 条目“${entry.name}”的本地文件头不完整`);
    const localName = decodeName(bytes.slice(local + 30, local + 30 + localNameLength), Boolean(localFlags & UTF8_FLAG));
    if (localName !== entry.name) throw zipError(`ZIP 条目“${entry.name}”的本地与中央文件名不一致`);
    need(view, dataOffset, entry.compressedSize, `ZIP 条目“${entry.name}”的压缩数据越界`);
    if (dataOffset + entry.compressedSize > centralOffset) throw zipError(`ZIP 条目“${entry.name}”与中央目录重叠`);
    const raw = bytes.subarray(dataOffset, dataOffset + entry.compressedSize);
    let output;
    if (entry.method === 0) {
      if (entry.compressedSize !== entry.uncompressedSize) throw zipError(`ZIP stored 条目“${entry.name}”的大小字段不一致`);
      output = raw.slice();
    } else {
      output = await inflate(raw, entry.uncompressedSize, entry.name);
    }
    if (crc32(output) !== entry.crc) throw zipError(`ZIP 条目“${entry.name}”的 CRC32 校验失败`);
    return output;
  }

  const api = {
    names() {
      return entries.map(entry => entry.name);
    },
    has(name) {
      return byName.has(name);
    },
    async bytes(name) {
      const entry = byName.get(name);
      if (!entry) throw zipError(`ZIP 中不存在条目“${name}”`);
      if (!cache.has(entry)) cache.set(entry, extract(entry));
      return cache.get(entry);
    },
    async text(name) {
      return decoder.decode(await api.bytes(name));
    },
  };
  return api;
}

/** Write a dependency-free, stored ZIP32 archive with UTF-8 entry names. */
export function writeZip(entries) {
  if (!Array.isArray(entries)) throw zipError('writeZip 的 entries 必须是数组');
  if (entries.length > MAX_ENTRIES) throw zipError(`ZIP 条目数不能超过 ${MAX_ENTRIES}`);
  const names = new Set();
  let dataTotal = 0;
  const prepared = entries.map(item => {
    if (!item || typeof item !== 'object') throw zipError('ZIP 条目必须是 {name,data} 对象');
    const name = checkName(item.name);
    if (names.has(name)) throw zipError(`ZIP 中存在重复条目“${name}”`);
    names.add(name);
    const nameBytes = encoder.encode(name);
    if (nameBytes.length > 65535) throw zipError(`ZIP 条目“${name}”的名称过长`);
    let data;
    if (typeof item.data === 'string') data = encoder.encode(item.data);
    else if (item.data instanceof Uint8Array) data = item.data;
    else throw zipError(`ZIP 条目“${name}”的 data 必须是 Uint8Array 或 UTF-8 string`);
    if (data.byteLength > MAX_ENTRY_SIZE) throw zipError(`ZIP 单条大小不能超过 ${MAX_ENTRY_SIZE / 1024 / 1024} MiB`);
    dataTotal += data.byteLength;
    if (dataTotal > MAX_TOTAL_SIZE) throw zipError(`ZIP 总大小不能超过 ${MAX_TOTAL_SIZE / 1024 / 1024} MiB`);
    return { name, nameBytes, data, crc: crc32(data), offset: 0 };
  });

  let localSize = 0;
  let centralSize = 0;
  for (const entry of prepared) {
    localSize += 30 + entry.nameBytes.length + entry.data.byteLength;
    centralSize += 46 + entry.nameBytes.length;
  }
  const totalSize = localSize + centralSize + 22;
  if (totalSize > 0xFFFFFFFF) throw zipError('ZIP32 输出不能超过 4 GiB，且暂不支持 ZIP64');
  const output = new Uint8Array(totalSize);
  const view = new DataView(output.buffer);
  let position = 0;

  for (const entry of prepared) {
    entry.offset = position;
    view.setUint32(position, 0x04034B50, true);
    view.setUint16(position + 4, 20, true);
    view.setUint16(position + 6, UTF8_FLAG, true);
    view.setUint16(position + 8, 0, true);
    view.setUint16(position + 10, 0, true);
    view.setUint16(position + 12, 0x0021, true);
    view.setUint32(position + 14, entry.crc, true);
    view.setUint32(position + 18, entry.data.byteLength, true);
    view.setUint32(position + 22, entry.data.byteLength, true);
    view.setUint16(position + 26, entry.nameBytes.length, true);
    view.setUint16(position + 28, 0, true);
    output.set(entry.nameBytes, position + 30);
    output.set(entry.data, position + 30 + entry.nameBytes.length);
    position += 30 + entry.nameBytes.length + entry.data.byteLength;
  }

  const centralOffset = position;
  for (const entry of prepared) {
    view.setUint32(position, 0x02014B50, true);
    view.setUint16(position + 4, 20, true);
    view.setUint16(position + 6, 20, true);
    view.setUint16(position + 8, UTF8_FLAG, true);
    view.setUint16(position + 10, 0, true);
    view.setUint16(position + 12, 0, true);
    view.setUint16(position + 14, 0x0021, true);
    view.setUint32(position + 16, entry.crc, true);
    view.setUint32(position + 20, entry.data.byteLength, true);
    view.setUint32(position + 24, entry.data.byteLength, true);
    view.setUint16(position + 28, entry.nameBytes.length, true);
    view.setUint16(position + 30, 0, true);
    view.setUint16(position + 32, 0, true);
    view.setUint16(position + 34, 0, true);
    view.setUint16(position + 36, 0, true);
    view.setUint32(position + 38, 0, true);
    view.setUint32(position + 42, entry.offset, true);
    output.set(entry.nameBytes, position + 46);
    position += 46 + entry.nameBytes.length;
  }

  view.setUint32(position, 0x06054B50, true);
  view.setUint16(position + 4, 0, true);
  view.setUint16(position + 6, 0, true);
  view.setUint16(position + 8, prepared.length, true);
  view.setUint16(position + 10, prepared.length, true);
  view.setUint32(position + 12, centralSize, true);
  view.setUint32(position + 16, centralOffset, true);
  view.setUint16(position + 20, 0, true);
  return output;
}
