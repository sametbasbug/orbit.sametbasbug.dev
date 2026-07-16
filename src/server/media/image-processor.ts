type PhotonModule = typeof import('@cf-wasm/photon/workerd');
type PhotonImage = InstanceType<PhotonModule['PhotonImage']>;

let photonModule: Promise<PhotonModule> | null = null;
function photon(): Promise<PhotonModule> {
  photonModule ??= import('@cf-wasm/photon/workerd');
  return photonModule;
}

export type AcceptedImageType = 'image/png' | 'image/jpeg' | 'image/webp';
export type MediaTransform = 'avatar' | 'post';

export interface InspectedImage {
  contentType: AcceptedImageType;
  width: number;
  height: number;
  orientation: number;
}

export interface ProcessedImage {
  bytes: Uint8Array;
  contentType: 'image/webp';
  width: number;
  height: number;
  source: InspectedImage;
  processingMs: number;
}

export class ImageValidationError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = 'ImageValidationError';
    this.code = code;
  }
}

const MAX_INPUT_PIXELS = 16_000_000;
const MAX_DIMENSION = 8192;
const AVATAR_EDGE = 512;
const POST_LONG_EDGE = 2400;

function u16be(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] << 8) | bytes[offset + 1];
}

function u24le(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}

function ascii(bytes: Uint8Array, offset: number, value: string): boolean {
  if (offset + value.length > bytes.byteLength) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (bytes[offset + index] !== value.charCodeAt(index)) return false;
  }
  return true;
}

function exifOrientation(bytes: Uint8Array, segmentStart: number, segmentLength: number): number {
  if (segmentLength < 14 || !ascii(bytes, segmentStart, 'Exif\0\0')) return 1;
  const base = segmentStart + 6;
  const little = ascii(bytes, base, 'II');
  const big = ascii(bytes, base, 'MM');
  if (!little && !big) return 1;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const read16 = (offset: number) => view.getUint16(offset, little);
  const read32 = (offset: number) => view.getUint32(offset, little);
  if (base + 8 > bytes.byteLength || read16(base + 2) !== 42) return 1;
  const ifd = base + read32(base + 4);
  if (ifd + 2 > bytes.byteLength || ifd >= segmentStart + segmentLength) return 1;
  const count = read16(ifd);
  for (let index = 0; index < count; index += 1) {
    const entry = ifd + 2 + index * 12;
    if (entry + 12 > bytes.byteLength || entry + 12 > segmentStart + segmentLength) break;
    if (read16(entry) === 0x0112 && read16(entry + 2) === 3 && read32(entry + 4) >= 1) {
      const value = read16(entry + 8);
      return value >= 1 && value <= 8 ? value : 1;
    }
  }
  return 1;
}

function inspectJpeg(bytes: Uint8Array): InspectedImage | null {
  if (bytes.byteLength < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  const sof = new Set([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf]);
  let offset = 2;
  let orientation = 1;
  while (offset + 4 <= bytes.byteLength) {
    while (offset < bytes.byteLength && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.byteLength) break;
    const marker = bytes[offset];
    offset += 1;
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.byteLength) break;
    const length = u16be(bytes, offset);
    if (length < 2 || offset + length > bytes.byteLength) break;
    const data = offset + 2;
    const dataLength = length - 2;
    if (marker === 0xe1) orientation = exifOrientation(bytes, data, dataLength);
    if (sof.has(marker) && dataLength >= 6) {
      return {
        contentType: 'image/jpeg',
        width: u16be(bytes, data + 3),
        height: u16be(bytes, data + 1),
        orientation,
      };
    }
    offset += length;
  }
  throw new ImageValidationError('image_dimensions_invalid');
}

function inspectPng(bytes: Uint8Array): InspectedImage | null {
  const signature = [137,80,78,71,13,10,26,10];
  if (bytes.byteLength < 24 || !signature.every((value, index) => bytes[index] === value)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (!ascii(bytes, 12, 'IHDR')) throw new ImageValidationError('image_dimensions_invalid');
  return {
    contentType: 'image/png',
    width: view.getUint32(16),
    height: view.getUint32(20),
    orientation: 1,
  };
}

function inspectWebp(bytes: Uint8Array): InspectedImage | null {
  if (bytes.byteLength < 30 || !ascii(bytes, 0, 'RIFF') || !ascii(bytes, 8, 'WEBP')) return null;
  if (ascii(bytes, 12, 'VP8X')) {
    return {
      contentType: 'image/webp',
      width: 1 + u24le(bytes, 24),
      height: 1 + u24le(bytes, 27),
      orientation: 1,
    };
  }
  if (ascii(bytes, 12, 'VP8 ') && bytes.byteLength >= 30 && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
    return {
      contentType: 'image/webp',
      width: (bytes[26] | (bytes[27] << 8)) & 0x3fff,
      height: (bytes[28] | (bytes[29] << 8)) & 0x3fff,
      orientation: 1,
    };
  }
  if (ascii(bytes, 12, 'VP8L') && bytes.byteLength >= 25 && bytes[20] === 0x2f) {
    const b0 = bytes[21]; const b1 = bytes[22]; const b2 = bytes[23]; const b3 = bytes[24];
    return {
      contentType: 'image/webp',
      width: 1 + b0 + ((b1 & 0x3f) << 8),
      height: 1 + (b1 >> 6) + (b2 << 2) + ((b3 & 0x0f) << 10),
      orientation: 1,
    };
  }
  throw new ImageValidationError('image_dimensions_invalid');
}

export function inspectImage(bytes: Uint8Array, declaredType: string): InspectedImage {
  const inspected = inspectPng(bytes) ?? inspectJpeg(bytes) ?? inspectWebp(bytes);
  if (!inspected) throw new ImageValidationError('image_type_unsupported');
  if (declaredType.toLowerCase() !== inspected.contentType) {
    throw new ImageValidationError('image_mime_mismatch');
  }
  if (
    inspected.width < 1
    || inspected.height < 1
    || inspected.width > MAX_DIMENSION
    || inspected.height > MAX_DIMENSION
    || inspected.width * inspected.height > MAX_INPUT_PIXELS
  ) throw new ImageValidationError('image_dimensions_too_large');
  return inspected;
}

function orient(
  image: PhotonImage,
  orientation: number,
  allocated: PhotonImage[],
  operations: Pick<PhotonModule, 'fliph' | 'flipv' | 'rotate'>,
): PhotonImage {
  const { fliph, flipv, rotate } = operations;
  let current = image;
  const rotated = (angle: number) => {
    const value = rotate(current, angle);
    allocated.push(value);
    current = value;
  };
  if (orientation === 2) fliph(current);
  else if (orientation === 3) rotated(180);
  else if (orientation === 4) flipv(current);
  else if (orientation === 5) { rotated(90); fliph(current); }
  else if (orientation === 6) rotated(90);
  else if (orientation === 7) { rotated(270); fliph(current); }
  else if (orientation === 8) rotated(270);
  return current;
}

export async function processImage(
  bytes: Uint8Array,
  declaredType: string,
  transform: MediaTransform,
): Promise<ProcessedImage> {
  const source = inspectImage(bytes, declaredType);
  const started = performance.now();
  const allocated: PhotonImage[] = [];
  try {
    const { PhotonImage, SamplingFilter, crop, resize, fliph, flipv, rotate } = await photon();
    const decoded = PhotonImage.new_from_byteslice(bytes);
    allocated.push(decoded);
    let current = orient(decoded, source.orientation, allocated, { fliph, flipv, rotate });
    if (transform === 'avatar') {
      const edge = Math.min(current.get_width(), current.get_height());
      const left = Math.floor((current.get_width() - edge) / 2);
      const top = Math.floor((current.get_height() - edge) / 2);
      const cropped = crop(current, left, top, left + edge, top + edge);
      allocated.push(cropped);
      current = cropped;
      const resized = resize(current, AVATAR_EDGE, AVATAR_EDGE, SamplingFilter.Lanczos3);
      allocated.push(resized);
      current = resized;
    } else {
      const width = current.get_width();
      const height = current.get_height();
      const longEdge = Math.max(width, height);
      if (longEdge > POST_LONG_EDGE) {
        const ratio = POST_LONG_EDGE / longEdge;
        const resized = resize(
          current,
          Math.max(1, Math.round(width * ratio)),
          Math.max(1, Math.round(height * ratio)),
          SamplingFilter.Lanczos3,
        );
        allocated.push(resized);
        current = resized;
      }
    }
    const output = current.get_bytes_webp();
    if (output.byteLength < 1 || output.byteLength > 10 * 1024 * 1024) {
      throw new ImageValidationError('image_output_too_large');
    }
    return {
      bytes: output,
      contentType: 'image/webp',
      width: current.get_width(),
      height: current.get_height(),
      source,
      processingMs: Math.max(0, performance.now() - started),
    };
  } catch (error) {
    if (error instanceof ImageValidationError) throw error;
    throw new ImageValidationError('image_decode_failed');
  } finally {
    for (const image of [...allocated].reverse()) {
      try { image.free(); } catch {}
    }
  }
}
