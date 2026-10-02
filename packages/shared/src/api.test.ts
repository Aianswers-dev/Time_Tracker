import { describe, it, expect } from 'vitest';
import { healthResponseSchema, apiErrorSchema, errorCodeSchema } from './api';

describe('healthResponseSchema', () => {
  it('accepts valid health response with ok: true and ISO datetime', () => {
    const validData = {
      ok: true,
      time: new Date().toISOString(),
    };
    const result = healthResponseSchema.safeParse(validData);
    expect(result.success).toBe(true);
  });

  it('accepts valid health response with specific ISO datetime', () => {
    const validData = {
      ok: true,
      time: '2026-10-02T12:34:56.789Z',
    };
    const result = healthResponseSchema.safeParse(validData);
    expect(result.success).toBe(true);
  });

  it('rejects response with ok: false', () => {
    const invalidData = {
      ok: false,
      time: new Date().toISOString(),
    };
    const result = healthResponseSchema.safeParse(invalidData);
    expect(result.success).toBe(false);
  });

  it('rejects response with non-ISO time format', () => {
    const invalidData = {
      ok: true,
      time: '2026-10-02 12:34:56',
    };
    const result = healthResponseSchema.safeParse(invalidData);
    expect(result.success).toBe(false);
  });

  it('rejects response with invalid time string', () => {
    const invalidData = {
      ok: true,
      time: 'not a date',
    };
    const result = healthResponseSchema.safeParse(invalidData);
    expect(result.success).toBe(false);
  });

  it('rejects response missing time field', () => {
    const invalidData = {
      ok: true,
    };
    const result = healthResponseSchema.safeParse(invalidData);
    expect(result.success).toBe(false);
  });

  it('ignores extra fields so the server can add some without breaking older clients', () => {
    const data = {
      ok: true,
      time: new Date().toISOString(),
      extra: 'field',
    };
    const result = healthResponseSchema.safeParse(data);
    expect(result.success).toBe(true);
  });
});

describe('apiErrorSchema', () => {
  describe('accepts all defined error codes', () => {
    const codes = [
      'unauthorized',
      'validation_failed',
      'not_found',
      'conflict',
      'switch_before_open_start',
      'switch_in_future',
      'internal',
    ] as const;

    codes.forEach((code) => {
      it(`accepts error code: ${code}`, () => {
        const errorData = {
          error: {
            code,
            message: 'Test message',
          },
        };
        const result = apiErrorSchema.safeParse(errorData);
        expect(result.success).toBe(true);
      });
    });
  });

  it('rejects unknown error code', () => {
    const invalidData = {
      error: {
        code: 'unknown_error',
        message: 'Test message',
      },
    };
    const result = apiErrorSchema.safeParse(invalidData);
    expect(result.success).toBe(false);
  });

  it('accepts error with optional details field', () => {
    const validData = {
      error: {
        code: 'validation_failed',
        message: 'Validation failed',
        details: {
          field: 'categoryId',
          reason: 'invalid format',
        },
      },
    };
    const result = apiErrorSchema.safeParse(validData);
    expect(result.success).toBe(true);
  });

  it('accepts error with empty details object', () => {
    const validData = {
      error: {
        code: 'internal',
        message: 'Internal server error',
        details: {},
      },
    };
    const result = apiErrorSchema.safeParse(validData);
    expect(result.success).toBe(true);
  });

  it('accepts error with details containing various value types', () => {
    const validData = {
      error: {
        code: 'validation_failed',
        message: 'Validation failed',
        details: {
          stringField: 'value',
          numberField: 42,
          booleanField: true,
          nullField: null,
          arrayField: [1, 2, 3],
          objectField: { nested: 'value' },
        },
      },
    };
    const result = apiErrorSchema.safeParse(validData);
    expect(result.success).toBe(true);
  });

  it('rejects error missing message field', () => {
    const invalidData = {
      error: {
        code: 'internal',
      },
    };
    const result = apiErrorSchema.safeParse(invalidData);
    expect(result.success).toBe(false);
  });

  it('rejects error missing code field', () => {
    const invalidData = {
      error: {
        message: 'Test message',
      },
    };
    const result = apiErrorSchema.safeParse(invalidData);
    expect(result.success).toBe(false);
  });

  it('rejects error with non-string message', () => {
    const invalidData = {
      error: {
        code: 'internal',
        message: 123,
      },
    };
    const result = apiErrorSchema.safeParse(invalidData);
    expect(result.success).toBe(false);
  });

  it('rejects top-level missing error object', () => {
    const invalidData = {
      message: 'Test message',
      code: 'internal',
    };
    const result = apiErrorSchema.safeParse(invalidData);
    expect(result.success).toBe(false);
  });
});

describe('errorCodeSchema', () => {
  it('accepts all valid error codes', () => {
    const codes = [
      'unauthorized',
      'validation_failed',
      'not_found',
      'conflict',
      'switch_before_open_start',
      'switch_in_future',
      'internal',
    ];

    codes.forEach((code) => {
      const result = errorCodeSchema.safeParse(code);
      expect(result.success).toBe(true);
    });
  });

  it('rejects invalid error code', () => {
    const result = errorCodeSchema.safeParse('invalid_code');
    expect(result.success).toBe(false);
  });

  it('rejects non-string values', () => {
    expect(errorCodeSchema.safeParse(123).success).toBe(false);
    expect(errorCodeSchema.safeParse(null).success).toBe(false);
    expect(errorCodeSchema.safeParse(undefined).success).toBe(false);
  });
});
