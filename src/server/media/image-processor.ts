import type { ImagesBindingLike } from '../identity/bindings';

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

export type ImageTransformErrorCategory =
  | 'images_quota'
  | 'images_input'
  | 'images_service'
  | 'images_output'
  | 'images_unknown';

export class ImageValidationError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = 'ImageValidationError';
    this.code = code;
  }
}

export class ImageTransformError extends Error {
  readonly category: ImageTransformErrorCategory;
  readonly providerCode: number | null;
  constructor(category: ImageTransformErrorCategory, providerCode: number | null = null) {
    super('media_transform_unavailable');
    this.name = 'ImageTransformError';
    this.category = category;
    this.providerCode = providerCode;
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

function providerErrorCode(error: unknown): number | null {
  if (!error || typeof error !== 'object' || !('code' in error)) return null;
  const code = Number((error as { code?: unknown }).code);
  return Number.isSafeInteger(code) ? code : null;
}

function providerErrorCategory(code: number | null): ImageTransformErrorCategory {
  if (code === 9422) return 'images_quota';
  if (code !== null && code >= 9400 && code <= 9419) return 'images_input';
  if (code !== null && code >= 9420 && code <= 9499) return 'images_service';
  return 'images_unknown';
}

function imageStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new Blob([bytes.slice().buffer]).stream();
}

function validateOutput(source: InspectedImage, output: InspectedImage, transform: MediaTransform): void {
  const rejectOutput = (): never => {
    console.warn(JSON.stringify({
      event: 'media.transform_output_rejected',
      profile: transform,
      source: { width: source.width, height: source.height, orientation: source.orientation },
      output: { width: output.width, height: output.height, contentType: output.contentType },
    }));
    throw new ImageTransformError('images_output');
  };
  if (output.contentType !== 'image/webp') rejectOutput();
  if (transform === 'avatar') {
    if (output.width !== AVATAR_EDGE || output.height !== AVATAR_EDGE) {
      rejectOutput();
    }
    return;
  }
  if (Math.max(output.width, output.height) > POST_LONG_EDGE) {
    rejectOutput();
  }
  const sourceWidth = source.orientation >= 5 && source.orientation <= 8 ? source.height : source.width;
  const sourceHeight = source.orientation >= 5 && source.orientation <= 8 ? source.width : source.height;
  const sourceRatio = sourceWidth / sourceHeight;
  const outputRatio = output.width / output.height;
  if (Math.abs(sourceRatio - outputRatio) > 0.02) rejectOutput();
}

export async function transformImage(
  images: ImagesBindingLike,
  bytes: Uint8Array,
  declaredType: string,
  transform: MediaTransform,
): Promise<ProcessedImage> {
  const source = inspectImage(bytes, declaredType);
  const sourceWidth = source.orientation >= 5 && source.orientation <= 8 ? source.height : source.width;
  const sourceHeight = source.orientation >= 5 && source.orientation <= 8 ? source.width : source.height;
  const postTransform = sourceWidth >= sourceHeight
    ? { width: Math.min(sourceWidth, POST_LONG_EDGE), fit: 'scale-down' as const }
    : { height: Math.min(sourceHeight, POST_LONG_EDGE), fit: 'scale-down' as const };
  const started = performance.now();
  try {
    const transformer = images.input(imageStream(bytes)).transform(transform === 'avatar'
      ? { width: AVATAR_EDGE, height: AVATAR_EDGE, fit: 'cover', gravity: 'center' }
      : postTransform);
    const result = await transformer.output({ format: 'image/webp', quality: 85 });
    if (result.contentType().toLowerCase() !== 'image/webp') {
      throw new ImageTransformError('images_output');
    }
    const output = new Uint8Array(await new Response(result.image()).arrayBuffer());
    if (output.byteLength < 1 || output.byteLength > 10 * 1024 * 1024) {
      throw new ImageTransformError('images_output');
    }
    const inspectedOutput = inspectImage(output, 'image/webp');
    validateOutput(source, inspectedOutput, transform);
    return {
      bytes: output,
      contentType: 'image/webp',
      width: inspectedOutput.width,
      height: inspectedOutput.height,
      source,
      processingMs: Math.max(0, performance.now() - started),
    };
  } catch (error) {
    if (error instanceof ImageValidationError || error instanceof ImageTransformError) throw error;
    const code = providerErrorCode(error);
    throw new ImageTransformError(providerErrorCategory(code), code);
  }
}
