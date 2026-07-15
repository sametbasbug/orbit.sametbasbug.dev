import { validate as validateUuid, v7 as uuidv7, version as uuidVersion } from 'uuid';

export function createEntityId(): string {
  return uuidv7();
}

export function createRequestId(): string {
  return `req_${uuidv7()}`;
}

export function isUuidV7(value: string): boolean {
  return validateUuid(value) && uuidVersion(value) === 7;
}
