const SECRET_KEY_PATTERN = /(?:authorization|cookie|csrf|oauth|password|secret|token)/i;
const ORBIT_SECRET_PATTERN = /orb_(?:inv|sess|agent)_v\d+_[A-Za-z0-9_-]+_[A-Za-z0-9_-]+/g;

const REDACTED = '[REDACTED]';

function redactString(value: string): string {
  return value.replace(ORBIT_SECRET_PATTERN, REDACTED);
}

export function redactSecrets(value: unknown): unknown {
  if (typeof value === 'string') {
    return redactString(value);
  }

  if (Array.isArray(value)) {
    return value.map(redactSecrets);
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, nestedValue]) => [
        key,
        SECRET_KEY_PATTERN.test(key) ? REDACTED : redactSecrets(nestedValue),
      ]),
    );
  }

  return value;
}
