import { createEntityId } from '../foundation/ids';
import type { OrbitBindings, R2BucketLike } from '../identity/bindings';
import type { MediaAssetView, MediaRepository } from '../repositories/media-repository';
import {
  ImageTransformError,
  ImageValidationError,
  inspectImage,
  transformImage,
  type MediaTransform,
  type ProcessedImage,
} from './image-processor';

export const AVATAR_UPLOAD_LIMIT = 5 * 1024 * 1024;
export const POST_IMAGE_UPLOAD_LIMIT = 10 * 1024 * 1024;
const IMAGE_HEADER_LIMIT = 64 * 1024;
const STAGED_RETENTION_MS = 24 * 60 * 60 * 1000;
const ORPHAN_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export class MediaServiceError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(status: number, code: string) {
    super(code);
    this.name = 'MediaServiceError';
    this.code = code;
    this.status = status;
  }
}

export function mediaEnabled(env: OrbitBindings): boolean {
  return env.ORBIT_MEDIA_ENABLED === 'true';
}

function requireMediaBucket(env: OrbitBindings): R2BucketLike {
  if (!mediaEnabled(env)) throw new MediaServiceError(503, 'media_disabled');
  if (!env.MEDIA) throw new MediaServiceError(503, 'media_binding_missing');
  return env.MEDIA;
}

function requireImagesBinding(env: OrbitBindings) {
  if (!mediaEnabled(env)) throw new MediaServiceError(503, 'media_disabled');
  if (!env.IMAGES) throw new MediaServiceError(503, 'media_transform_unavailable');
  return env.IMAGES;
}

export function utcMonth(now: number): string {
  return new Date(now).toISOString().slice(0, 7);
}

export interface ValidatedImageUpload {
  quarantineKey: string;
  byteSize: number;
  contentDigest: string;
  contentType: 'image/png' | 'image/jpeg' | 'image/webp';
  source: ReturnType<typeof inspectImage>;
  timings: {
    quarantineMs: number;
    inspectMs: number;
  };
}

function decodeDigest(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(value)) {
    throw new MediaServiceError(400, 'image_digest_invalid');
  }
  const standard = value.replaceAll('-', '+').replaceAll('_', '/');
  return Uint8Array.from(atob(`${standard}=`), (character) => character.charCodeAt(0));
}

export async function stageRawImageUpload(
  request: Request,
  env: OrbitBindings,
  maxBytes: number,
): Promise<ValidatedImageUpload> {
  const bucket = requireMediaBucket(env);
  const contentType = (request.headers.get('content-type') ?? '').toLowerCase();
  if (contentType !== 'image/png' && contentType !== 'image/jpeg' && contentType !== 'image/webp') {
    throw new MediaServiceError(415, 'image_type_unsupported');
  }
  const rawContentLength = request.headers.get('content-length');
  if (rawContentLength === null) throw new MediaServiceError(411, 'upload_length_required');
  const contentLength = Number(rawContentLength);
  if (!Number.isSafeInteger(contentLength) || contentLength < 1) {
    throw new MediaServiceError(400, 'upload_length_invalid');
  }
  if (contentLength > maxBytes) {
    throw new MediaServiceError(413, 'image_too_large');
  }
  const contentDigest = request.headers.get('x-orbit-content-sha256') ?? '';
  const checksum = decodeDigest(contentDigest);
  if (!request.body) throw new MediaServiceError(400, 'image_body_required');
  const quarantineKey = `quarantine/${createEntityId()}`;
  const quarantineStarted = performance.now();
  try {
    const stored = await bucket.put(quarantineKey, request.body, {
      sha256: checksum,
      httpMetadata: { contentType, cacheControl: 'private, no-store' },
      customMetadata: { state: 'quarantine' },
    });
    if (!stored || stored.size !== contentLength) {
      await bucket.delete(quarantineKey);
      throw new MediaServiceError(400, 'image_length_mismatch');
    }
  } catch (error) {
    await bucket.delete(quarantineKey).catch(() => undefined);
    if (error instanceof MediaServiceError) throw error;
    throw new MediaServiceError(400, 'image_checksum_mismatch');
  }
  const quarantineMs = performance.now() - quarantineStarted;
  const inspectStarted = performance.now();
  try {
    const header = await bucket.get(quarantineKey, {
      range: { offset: 0, length: Math.min(contentLength, IMAGE_HEADER_LIMIT) },
    });
    if (!header) throw new MediaServiceError(502, 'media_r2_quarantine_missing');
    const source = inspectImage(new Uint8Array(await header.arrayBuffer()), contentType);
    return {
      quarantineKey,
      byteSize: contentLength,
      contentDigest,
      contentType: source.contentType,
      source,
      timings: { quarantineMs, inspectMs: performance.now() - inspectStarted },
    };
  } catch (error) {
    await bucket.delete(quarantineKey).catch(() => undefined);
    if (error instanceof ImageValidationError) throw new MediaServiceError(415, error.code);
    throw error;
  }
}

export async function assertPostImageUploadAllowed(
  repository: MediaRepository,
  agentId: string,
  dayUtc: string,
  checkQuota = true,
): Promise<void> {
  const allowance = await repository.getPostImageAllowance(agentId, dayUtc);
  if (!allowance.mediaEnabled) throw new MediaServiceError(403, 'media_not_allowed');
  if (checkQuota && allowance.usedToday >= allowance.dailyImageLimit) {
    throw new MediaServiceError(429, 'daily_media_quota_exceeded');
  }
}

export async function normalizeImage(
  env: OrbitBindings,
  upload: ValidatedImageUpload,
  transform: MediaTransform,
): Promise<ProcessedImage> {
  const images = requireImagesBinding(env);
  try {
    const source = await requireMediaBucket(env).get(upload.quarantineKey);
    if (!source) throw new MediaServiceError(502, 'media_r2_quarantine_missing');
    return await transformImage(images, source.body, upload.source, transform);
  } catch (error) {
    const transformError = error instanceof ImageTransformError
      ? error
      : new ImageTransformError('images_unknown');
    console.warn(JSON.stringify({
      event: 'media.transform_failed',
      provider: 'cloudflare_images',
      profile: transform,
      category: transformError.category,
      providerCode: transformError.providerCode,
    }));
    const serviceError = new MediaServiceError(503, 'media_transform_unavailable') as MediaServiceError & {
      transformCategory?: string;
    };
    serviceError.transformCategory = transformError.category;
    throw serviceError;
  }
}

export function newMediaAsset(input: {
  kind: MediaAssetView['mediaKind'];
  ownerAccountId?: string;
  ownerAgentId?: string;
  altText?: string;
  caption?: string | null;
  processed: ProcessedImage;
  now: number;
}): MediaAssetView {
  const id = createEntityId();
  const prefix = input.kind === 'account_avatar'
    ? `avatars/accounts/${input.ownerAccountId}`
    : input.kind === 'agent_avatar'
      ? `avatars/agents/${input.ownerAgentId}`
      : `posts/${input.ownerAgentId}`;
  return {
    id,
    mediaKind: input.kind,
    ownerAccountId: input.ownerAccountId ?? null,
    ownerAgentId: input.ownerAgentId ?? null,
    attachedRecordId: null,
    attachedRevisionId: null,
    objectKey: `${prefix}/${id}.webp`,
    contentType: 'image/webp',
    byteSize: 0,
    width: input.processed.width,
    height: input.processed.height,
    sha256Digest: '',
    altText: input.altText ?? null,
    caption: input.caption ?? null,
    state: input.kind === 'post_image' ? 'staged' : 'active',
    orphanReason: null,
    createdAt: input.now,
    activatedAt: input.kind === 'post_image' ? null : input.now,
    orphanedAt: null,
    deletedAt: null,
  };
}

export async function putMediaObject(
  env: OrbitBindings,
  asset: MediaAssetView,
  stream: ReadableStream<Uint8Array>,
): Promise<MediaAssetView> {
  const bucket = requireMediaBucket(env);
  const stored = await bucket.put(asset.objectKey, stream, {
    httpMetadata: {
      contentType: 'image/webp',
      cacheControl: 'private, no-store',
    },
    customMetadata: {
      mediaId: asset.id,
      mediaKind: asset.mediaKind,
      width: String(asset.width),
      height: String(asset.height),
    },
  });
  if (!stored || stored.size < 1 || stored.size > POST_IMAGE_UPLOAD_LIMIT) {
    await bucket.delete(asset.objectKey);
    const error = new MediaServiceError(503, 'media_transform_unavailable') as MediaServiceError & {
      transformCategory?: string;
    };
    error.transformCategory = 'images_output';
    throw error;
  }
  return {
    ...asset,
    byteSize: stored.size,
    sha256Digest: `r2-etag:${stored.etag}`,
  };
}

export async function discardMediaObject(env: OrbitBindings, objectKey: string): Promise<void> {
  if (!env.MEDIA) return;
  try { await env.MEDIA.delete(objectKey); } catch {}
}

export async function serveMedia(
  request: Request,
  env: OrbitBindings,
  repository: MediaRepository,
  mediaId: string,
  accountId: string | null,
): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response(null, { status: 405, headers: { allow: 'GET, HEAD' } });
  }
  const bucket = requireMediaBucket(env);
  const readable = await repository.getReadableAsset(mediaId, accountId);
  if (!readable) return new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } });
  const object = await bucket.get(readable.asset.objectKey);
  if (!object) return new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } });
  const headers = new Headers({
    'content-type': 'image/webp',
    'content-length': String(readable.asset.byteSize),
    'x-content-type-options': 'nosniff',
    etag: object.httpEtag ?? `"${object.etag}"`,
    'cache-control': readable.visibility === 'public'
      ? 'public, max-age=300, stale-while-revalidate=120'
      : 'private, no-store',
  });
  return new Response(request.method === 'HEAD' ? null : object.body, { status: 200, headers });
}

export async function cleanupMedia(
  env: OrbitBindings,
  repository: MediaRepository,
  now = Date.now(),
): Promise<{ candidates: number; deleted: number; failed: number }> {
  if (!mediaEnabled(env) || !env.MEDIA) return { candidates: 0, deleted: 0, failed: 0 };
  const candidates = await repository.listCleanupCandidates({
    stagedBefore: now - STAGED_RETENTION_MS,
    orphanedBefore: now - ORPHAN_RETENTION_MS,
    limit: 100,
  });
  let deleted = 0;
  let failed = 0;
  for (const item of candidates) {
    try {
      await env.MEDIA.delete(item.objectKey);
      await repository.markDeleted({ id: item.id, now });
      deleted += 1;
    } catch {
      failed += 1;
    }
  }
  console.log(JSON.stringify({
    event: 'media.cleanup',
    candidates: candidates.length,
    deleted,
    failed,
  }));
  return { candidates: candidates.length, deleted, failed };
}

export function logMediaUpload(input: {
  kind: MediaAssetView['mediaKind'];
  actorType: 'account' | 'agent';
  sourceBytes: number;
  outputBytes: number;
  processingMs: number;
  status: 'succeeded' | 'failed';
  phases?: Partial<Record<'quarantine' | 'inspect' | 'images' | 'finalR2' | 'd1', number>>;
}): void {
  console.log(JSON.stringify({
    event: 'media.upload',
    provider: 'cloudflare_images',
    kind: input.kind,
    actorType: input.actorType,
    sourceBytes: input.sourceBytes,
    outputBytes: input.outputBytes,
    processingMs: Math.round(input.processingMs),
    phases: input.phases ? Object.fromEntries(
      Object.entries(input.phases).map(([name, duration]) => [name, Math.round(Number(duration) * 100) / 100]),
    ) : undefined,
    status: input.status,
  }));
}
