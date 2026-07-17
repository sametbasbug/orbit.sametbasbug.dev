export interface ApiErrorEnvelope {
  error: {
    code: string;
    message: string;
    requestId: string;
    details: Record<string, unknown>;
  };
}

export function createErrorEnvelope(
  code: string,
  message: string,
  requestId: string,
  details: Record<string, unknown> = {},
): ApiErrorEnvelope {
  return {
    error: {
      code,
      message,
      requestId,
      details,
    },
  };
}
