import { apiErrorSchema } from '@time-tracker/shared';
import { describe, expect, it } from 'vitest';
import { useTestServer, type Reply } from './harness';

const server = useTestServer();

interface Issue {
  path: string;
  message: string;
  code: string;
}

function validationError(res: Reply): { message: string; issues: Issue[] } {
  expect(res.status).toBe(400);
  const { error } = apiErrorSchema.parse(res.json);
  expect(error.code).toBe('validation_failed');
  const issues = (error.details?.issues ?? []) as Issue[];
  expect(issues.length).toBeGreaterThan(0);
  return { message: error.message, issues };
}

describe('validation_failed', () => {
  it('a body that is not JSON', async () => {
    const res = await server.request('POST', '/api/switch', {
      rawBody: '{not json',
      headers: { 'Content-Type': 'application/json' },
    });
    expect(validationError(res).message).toMatch(/JSON/);
  });

  it('POST /api/switch without a category names the field in details', async () => {
    const { message, issues } = validationError(
      await server.post('/api/switch', { source: 'app' }),
    );
    expect(issues.map((i) => i.path)).toContain('categoryName');
    expect(message).toMatch(/categoryName/);
  });

  it('POST /api/switch with a bad source and time lists every issue', async () => {
    const { issues } = validationError(
      await server.post('/api/switch', { categoryName: 'X', source: 'siri', at: 'yesterday' }),
    );
    expect(issues.map((i) => i.path).sort()).toEqual(['at', 'source']);
  });

  it('POST /api/ops with no ops, or too many', async () => {
    validationError(await server.post('/api/ops', { ops: [] }));
    validationError(await server.post('/api/ops', {}));
    const tooMany = Array.from({ length: 201 }, (_, i) => ({ opId: `op-${i}` }));
    validationError(await server.post('/api/ops', { ops: tooMany }));
  });

  it('POST /api/ops with an op that has no opId', async () => {
    const { issues } = validationError(
      await server.post('/api/ops', { ops: [{ type: 'switch' }] }),
    );
    expect(issues[0]?.path).toBe('ops.0.opId');
  });

  it('GET /api/segments needs from and to', async () => {
    const { issues } = validationError(await server.get('/api/segments'));
    expect(issues.map((i) => i.path).sort()).toEqual(['from', 'to']);
  });

  it('GET /api/segments rejects from >= to', async () => {
    validationError(
      await server.get('/api/segments?from=2026-01-02T00:00:00.000Z&to=2026-01-01T00:00:00.000Z'),
    );
  });

  it('GET /api/segments allows 92 days and rejects more', async () => {
    const ok = await server.get(
      '/api/segments?from=2026-01-01T00:00:00.000Z&to=2026-04-03T00:00:00.000Z',
    );
    expect(ok.status).toBe(200);
    const { message } = validationError(
      await server.get('/api/segments?from=2026-01-01T00:00:00.000Z&to=2026-04-03T00:00:01.000Z'),
    );
    expect(message).toMatch(/92 days/);
  });

  it('GET /api/snapshot rejects a since that is not a timestamp', async () => {
    validationError(await server.get('/api/snapshot?since=last-tuesday'));
  });

  it('GET /api/export.csv rejects from after to', async () => {
    validationError(
      await server.get('/api/export.csv?from=2026-01-02T00:00:00.000Z&to=2026-01-01T00:00:00.000Z'),
    );
  });
});
