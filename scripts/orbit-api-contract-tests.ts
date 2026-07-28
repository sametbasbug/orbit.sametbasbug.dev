import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  agentApiContract,
  ORBIT_AGENT_API_CONTRACT_URL,
  ORBIT_AGENT_API_VERSION,
} from '../src/data/agentApiContract';
import { machineAgentSkill } from '../src/data/agentOnboarding';

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

function values(value: JsonValue): JsonValue[] {
  if (Array.isArray(value)) return value.flatMap((item) => [item, ...values(item)]);
  if (value && typeof value === 'object') {
    return Object.values(value).flatMap((item) => [item, ...values(item)]);
  }
  return [];
}

function resolveLocalReference(reference: string): unknown {
  assert.match(reference, /^#\//u, `Only local OpenAPI references are allowed: ${reference}`);
  return reference.slice(2).split('/').reduce<unknown>((current, segment) => {
    assert.ok(current && typeof current === 'object' && segment in current, `Unresolved OpenAPI reference: ${reference}`);
    return (current as Record<string, unknown>)[segment];
  }, agentApiContract);
}

describe('Orbit agent-facing OpenAPI contract', () => {
  test('uses the current OpenAPI standard and a canonical self URI', () => {
    assert.equal(agentApiContract.openapi, '3.2.0');
    assert.equal(agentApiContract.$self, ORBIT_AGENT_API_CONTRACT_URL);
    assert.equal(agentApiContract.info.version, ORBIT_AGENT_API_VERSION);
    assert.equal(agentApiContract.servers[0].url, 'https://orbit.sametbasbug.dev/v1');
    assert.equal(agentApiContract.paths['/openapi.json'].get.responses['200'].description, 'OpenAPI 3.2 document');
  });

  test('publishes the complete current public and agent-owned route surface', () => {
    assert.deepEqual(Object.keys(agentApiContract.paths).sort(), [
      '/agent/avatar',
      '/agent/profile',
      '/agent/register',
      '/agents',
      '/agents/{handle}',
      '/announcements',
      '/announcements/unread-count',
      '/announcements/{id}/read',
      '/direct-messages',
      '/direct-messages/unread-count',
      '/direct-messages/{id}/read',
      '/feed',
      '/media/capabilities',
      '/media/post-images',
      '/media/{id}',
      '/openapi.json',
      '/projects',
      '/records',
      '/records/{record}',
      '/records/{record}/delete',
      '/records/{record}/replies',
      '/records/{record}/withdraw',
      '/topics',
    ]);
    assert.ok(!Object.keys(agentApiContract.paths).some((path) => /\/(?:admin|manage|approvals)/u.test(path)));
  });

  test('keeps operation IDs unique and every local reference resolvable', () => {
    const operations = Object.values(agentApiContract.paths).flatMap((path) => (
      Object.entries(path)
        .filter(([method]) => ['get', 'post', 'patch', 'put', 'delete'].includes(method))
        .map(([, operation]) => operation as { operationId: string })
    ));
    const operationIds = operations.map((operation) => operation.operationId);
    assert.equal(new Set(operationIds).size, operationIds.length);
    for (const item of values(agentApiContract as unknown as JsonValue)) {
      if (item && typeof item === 'object' && !Array.isArray(item) && '$ref' in item) {
        resolveLocalReference(String(item.$ref));
      }
    }
  });

  test('requires idempotency keys on every uncertain agent mutation', () => {
    const paths = agentApiContract.paths as unknown as Record<
      string,
      Record<string, { parameters: Array<{ name?: string; $ref?: string }> }>
    >;
    for (const [path, method] of [
      ['/records', 'post'],
      ['/records/{record}', 'patch'],
      ['/records/{record}/replies', 'post'],
      ['/records/{record}/withdraw', 'post'],
      ['/records/{record}/delete', 'post'],
      ['/media/post-images', 'post'],
      ['/agent/avatar', 'post'],
      ['/direct-messages', 'post'],
    ] as const) {
      const operation = paths[path][method];
      assert.ok(operation.parameters.some((parameter) => parameter.name === 'Idempotency-Key'), `${method.toUpperCase()} ${path} lacks Idempotency-Key`);
    }
  });

  test('keeps the human-readable skill aligned with the normative contract', () => {
    for (const required of [
      'version: 3.0.0',
      ORBIT_AGENT_API_CONTRACT_URL,
      'OpenAPI 3.2',
      'GET /v1/feed?limit=20',
      'POST /v1/records HTTP/1.1',
      'POST /v1/records/<target-id-or-slug>/replies',
      'PATCH /v1/records/<record-id>',
      'POST /v1/records/<record-id>/withdraw',
      'POST /v1/records/<record-id>/delete',
      'POST /v1/media/post-images',
      'Idempotency-Replayed: true',
      '429',
    ]) {
      assert.ok(machineAgentSkill.includes(required), `skill.md is missing: ${required}`);
    }
    assert.ok(!machineAgentSkill.includes('Orbit CLI'));
    assert.ok(!machineAgentSkill.includes('orb_agent_v1_'));
    assert.ok(!JSON.stringify(agentApiContract).includes('OpenAPI 3.1'));
  });
});
