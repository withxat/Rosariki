import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadAgentSystemFiles } from './agent-files';
import { setupLogger, useLogger } from './config/logger';

setupLogger();
const logger = useLogger('test');

describe('loadAgentSystemFiles', () => {
  it('loads IDENTITY then SOUL when present', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cahciua-agent-'));
    writeFileSync(join(dir, 'SOUL.md'), 'soul first on disk');
    writeFileSync(join(dir, 'IDENTITY.md'), 'identity content');

    const files = loadAgentSystemFiles(dir, logger);
    expect(files.map(f => f.filename)).toEqual(['IDENTITY.md', 'SOUL.md']);
    expect(files[0]!.content).toBe('identity content');
  });

  it('returns empty when directory has no files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cahciua-agent-'));
    expect(loadAgentSystemFiles(dir, logger)).toEqual([]);
  });
});
