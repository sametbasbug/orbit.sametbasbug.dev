# Vendored validation schemas

`openapi-3.2-schema-2025-09-17.json` is the exact minified JSON form of the
official OpenAPI Initiative schema published at:

`https://spec.openapis.org/oas/3.2/schema/2025-09-17`

Pinned SHA-256:
`ab6a0788cd7323716e285a19ce9cb19f00fa6658b6d334525cb6e17d0daf2a96`

The contract tests verify this digest before validating Orbit's generated
document. CI therefore performs normative OpenAPI 3.2 validation without a
network fetch or mutable remote dependency.
