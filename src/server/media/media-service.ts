import { createEntityId } from '../foundation/ids';
import { sha256Base64Url } from '../identity/tokens';
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
const MULTIPART_OVERHEAD_ALLOWANCE = 1024 * 1024;
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
  bytes: Uint8Array;
  contentType: 'image/png' | 'image/jpeg' | 'image/webp';
  source: ReturnType<typeof inspectImage>;
  form: FormData;
}

export async function readImageUpload(
  request: Request,
  maxBytes: number,
): Promise<ValidatedImageUpload> {
  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().startsWith('multipart/form-data;')) {
    throw new MediaServiceError(415, 'multipart_required');
  }
  const rawContentLength = request.headers.get('content-length');
  if (rawContentLength === null) throw new MediaServiceError(411, 'upload_length_required');
  const contentLength = Number(rawContentLength);
  if (!Number.isSafeInteger(contentLength) || contentLength < 1) {
    throw new MediaServiceError(400, 'upload_length_invalid');
  }
  if (contentLength > maxBytes + MULTIPART_OVERHEAD_ALLOWANCE) {
    throw new MediaServiceError(413, 'image_too_large');
  }
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    throw new MediaServiceError(400, 'multipart_invalid');
  }
  const file = form.get('file');
  if (!(file instanceof File)) throw new MediaServiceError(400, 'image_file_required');
  if (file.size < 1 || file.size > maxBytes) throw new MediaServiceError(413, 'image_too_large');
  const bytes = new Uint8Array(await file.arrayBuffer());
  try {
    const source = inspectImage(bytes, file.type);
    return { bytes, contentType: source.contentType, source, form };
  } catch (error) {
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
  repository: MediaRepository,
  upload: ValidatedImageUpload,
  transform: MediaTransform,
  actor: { type: 'account' | 'agent'; id: string },
  now: number,
): Promise<ProcessedImage> {
  const images = requireImagesBinding(env);
  const claimId = createEntityId();
  try {
    await repository.reserveTransform({
      id: claimId,
      monthUtc: utcMonth(now),
      profile: transform,
      actorType: actor.type,
      actorId: actor.id,
      sourceContentType: upload.contentType,
      sourceByteSize: upload.bytes.byteLength,
      now,
    });
  } catch (error) {
    if (error instanceof Error && /media_transform_budget_exhausted/u.test(error.message)) {
      console.warn(JSON.stringify({
        event: 'media.transform_rejected',
        provider: 'cloudflare_images',
        profile: transform,
        actorType: actor.type,
        category: 'safety_limit',
      }));
      throw new MediaServiceError(503, 'media_transform_unavailable');
    }
    throw error;
  }

  try {
    const processed = await transformImage(images, upload.bytes, upload.contentType, transform);
    await repository.completeTransform({
      claimId,
      status: 'succeeded',
      errorCategory: null,
      outputByteSize: processed.bytes.byteLength,
      now,
    });
    return processed;
  } catch (error) {
    const transformError = error instanceof ImageTransformError
      ? error
      : new ImageTransformError('images_unknown');
    try {
      await repository.completeTransform({
        claimId,
        status: 'failed',
        errorCategory: transformError.category,
        outputByteSize: null,
        now,
      });
    } catch {
      // The reservation remains counted. This is deliberately conservative.
    }
    console.warn(JSON.stringify({
      event: 'media.transform_failed',
      provider: 'cloudflare_images',
      profile: transform,
      actorType: actor.type,
      category: transformError.category,
      providerCode: transformError.providerCode,
    }));
    throw new MediaServiceError(503, 'media_transform_unavailable');
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
    byteSize: input.processed.bytes.byteLength,
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
  bytes: Uint8Array,
): Promise<MediaAssetView> {
  const bucket = requireMediaBucket(env);
  const digest = await sha256Base64Url(bytes);
  const storedAsset = { ...asset, sha256Digest: digest };
  await bucket.put(asset.objectKey, bytes, {
    httpMetadata: {
      contentType: 'image/webp',
      cacheControl: 'private, no-store',
    },
    customMetadata: {
      mediaId: asset.id,
      mediaKind: asset.mediaKind,
      sha256Digest: digest,
      width: String(asset.width),
      height: String(asset.height),
    },
  });
  const readback = await bucket.get(asset.objectKey);
  if (!readback) throw new MediaServiceError(502, 'media_r2_readback_missing');
  const readbackBytes = new Uint8Array(await readback.arrayBuffer());
  if (readbackBytes.byteLength !== bytes.byteLength || await sha256Base64Url(readbackBytes) !== digest) {
    await bucket.delete(asset.objectKey);
    throw new MediaServiceError(502, 'media_r2_readback_checksum_failed');
  }
  return storedAsset;
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
    etag: `"${readable.asset.sha256Digest}"`,
    'cache-control': readable.visibility === 'public'
      ? 'public, max-age=300, stale-while-revalidate=120'
      : 'private, no-store',
  });
  return new Response(request.method === 'HEAD' ? null : await object.arrayBuffer(), { status: 200, headers });
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
}): void {
  console.log(JSON.stringify({
    event: 'media.upload',
    provider: 'cloudflare_images',
    kind: input.kind,
    actorType: input.actorType,
    sourceBytes: input.sourceBytes,
    outputBytes: input.outputBytes,
    processingMs: Math.round(input.processingMs),
    status: input.status,
  }));
}
