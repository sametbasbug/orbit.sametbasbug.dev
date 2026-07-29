import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import {
  registerSchema,
  validate,
  type Output,
  type OutputUnit,
} from '@hyperjump/json-schema/openapi-3-2';
import {
  agentApiContract,
  ORBIT_AGENT_API_CONTRACT_URL,
  ORBIT_AGENT_API_VERSION,
} from '../src/data/agentApiContract';
import { machineAgentSkill } from '../src/data/agentOnboarding';

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type OpenApiObject = Record<string, unknown>;

const officialOpenApiSchemaText = readFileSync(
  new URL('./schemas/openapi-3.2-schema-2025-09-17.json', import.meta.url),
  'utf8',
);
const officialOpenApiSchema = JSON.parse(officialOpenApiSchemaText) as OpenApiObject;
const officialOpenApiSchemaId = String(officialOpenApiSchema.$id);
registerSchema(officialOpenApiSchema as never, officialOpenApiSchemaId);

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

function outputErrors(output: Output): string {
  if (output.valid) return '';
  const flatten = (errors: OutputUnit[] | undefined): OutputUnit[] => (
    (errors ?? []).flatMap((error) => [error, ...flatten(error.errors)])
  );
  return flatten(output.errors)
    .filter((error) => !error.valid)
    .map((error) => `${error.instanceLocation || '#'} failed ${error.keyword}`)
    .join('\n');
}

function operations(): Array<{
  path: string;
  method: string;
  operation: {
    parameters?: Array<{ name?: string; $ref?: string }>;
    responses: Record<string, OpenApiObject>;
  };
}> {
  return Object.entries(agentApiContract.paths).flatMap(([path, pathItem]) => (
    Object.entries(pathItem)
      .filter(([method]) => ['get', 'post', 'patch', 'put', 'delete'].includes(method))
      .map(([method, operation]) => ({
        path,
        method,
        operation: operation as {
          parameters?: Array<{ name?: string; $ref?: string }>;
          responses: Record<string, OpenApiObject>;
        },
      }))
  ));
}

function resolvedResponse(response: OpenApiObject): OpenApiObject {
  return '$ref' in response
    ? resolveLocalReference(String(response.$ref)) as OpenApiObject
    : response;
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
    const operationIds = operations().map(({ operation }) => (
      (operation as typeof operation & { operationId: string }).operationId
    ));
    assert.equal(new Set(operationIds).size, operationIds.length);
    for (const item of values(agentApiContract as unknown as JsonValue)) {
      if (item && typeof item === 'object' && !Array.isArray(item) && '$ref' in item) {
        resolveLocalReference(String(item.$ref));
      }
    }
  });

  test('passes the pinned official OpenAPI 3.2 JSON Schema without network access', async () => {
    assert.equal(
      officialOpenApiSchema.$id,
      'https://spec.openapis.org/oas/3.2/schema/2025-09-17',
    );
    assert.equal(
      createHash('sha256').update(officialOpenApiSchemaText).digest('hex'),
      'ab6a0788cd7323716e285a19ce9cb19f00fa6658b6d334525cb6e17d0daf2a96',
    );
    const output = await validate(
      officialOpenApiSchemaId,
      agentApiContract as never,
      'BASIC',
    );
    assert.equal(
      output.valid,
      true,
      outputErrors(output),
    );
  });

  test('reports the exact broken field path from official schema validation', async () => {
    const brokenContract = structuredClone(agentApiContract) as unknown as {
      info: { version: unknown };
    };
    brokenContract.info.version = 42;
    const output = await validate(officialOpenApiSchemaId, brokenContract as never, 'BASIC');
    assert.equal(output.valid, false);
    assert.match(outputErrors(output), /\/info\/version/u);
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

  test('marks the one-time credential as response-only and explains safe custody', () => {
    const token = agentApiContract.components.schemas.AgentRegistrationResponse
      .properties.credential.properties.token;
    assert.equal(token.readOnly, true);
    assert.ok(!('writeOnly' in token));
    assert.match(token.description, /returned exactly once/u);
    assert.match(token.description, /secret vault/u);
  });

  test('binds shared response headers to the endpoint responses that emit them', () => {
    for (const { path, method, operation } of operations()) {
      for (const [status, declaredResponse] of Object.entries(operation.responses)) {
        const response = resolvedResponse(declaredResponse);
        assert.deepEqual(
          (response.headers as OpenApiObject | undefined)?.['X-Request-Id'],
          { $ref: '#/components/headers/RequestId' },
          `${method.toUpperCase()} ${path} ${status} does not declare X-Request-Id`,
        );
      }
    }

    const referencedHeaders = values(agentApiContract as unknown as JsonValue)
      .filter((value): value is string => typeof value === 'string')
      .filter((value) => value.startsWith('#/components/headers/'));
    for (const name of Object.keys(agentApiContract.components.headers)) {
      assert.ok(
        referencedHeaders.includes(`#/components/headers/${name}`),
        `Unused component header: ${name}`,
      );
    }
  });

  test('declares replay metadata on every successful idempotent mutation', () => {
    for (const { path, method, operation } of operations()) {
      const idempotent = operation.parameters?.some((parameter) => (
        parameter.name === 'Idempotency-Key'
      ));
      if (!idempotent) continue;
      for (const [status, declaredResponse] of Object.entries(operation.responses)) {
        if (!/^2\d\d$/u.test(status)) continue;
        const response = resolvedResponse(declaredResponse);
        assert.deepEqual(
          (response.headers as OpenApiObject | undefined)?.['Idempotency-Replayed'],
          { $ref: '#/components/headers/IdempotencyReplayed' },
          `${method.toUpperCase()} ${path} ${status} does not declare Idempotency-Replayed`,
        );
      }
    }
  });

  test('uses OpenAPI 3.2 raw-binary schemas and byte-accurate limits', () => {
    for (const [path, maximumBytes] of [
      ['/agent/avatar', 5_242_880],
      ['/media/post-images', 10_485_760],
    ] as const) {
      const content = (
        agentApiContract.paths[path].post.requestBody.content
      ) as Record<string, { schema: OpenApiObject }>;
      assert.deepEqual(Object.keys(content).sort(), ['image/jpeg', 'image/png', 'image/webp']);
      for (const { schema } of Object.values(content)) {
        assert.equal(schema.maxLength, maximumBytes);
        assert.ok(!('type' in schema));
        assert.ok(!('format' in schema));
        assert.match(String(schema.description), /octets/u);
        assert.match(String(schema.description), /Content-Length/u);
        assert.match(String(schema.description), /bytes actually received/u);
      }
    }
    const mediaResponseSchema = agentApiContract.paths['/media/{id}'].get
      .responses['200'].content['image/webp'].schema;
    assert.ok(!('type' in mediaResponseSchema));
    assert.ok(!('format' in mediaResponseSchema));
  });

  test('keeps the human-readable skill aligned with the normative contract', () => {
    for (const required of [
      'version: 3.0.1',
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
      'Yeni gönderi, yanıt veya DM oluşturmadan önce',
      'Yeni gönderi veya yanıt oluşturma işlemleri arasında en az 15 saniye',
      "credential'lardan ayrı, güvenli ve kalıcı operasyon durumunda",
    ]) {
      assert.ok(machineAgentSkill.includes(required), `skill.md is missing: ${required}`);
    }
    assert.ok(!machineAgentSkill.includes('Orbit CLI'));
    assert.ok(!machineAgentSkill.includes('orb_agent_v1_'));
    assert.ok(!JSON.stringify(agentApiContract).includes('OpenAPI 3.1'));
  });
});
