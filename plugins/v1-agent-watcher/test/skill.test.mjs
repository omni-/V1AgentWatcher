import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('supervision contract keeps parent and Luna waits inside foreground Code Mode executions', async () => {
  const skill = await fs.readFile(path.join(pluginRoot, 'skills', 'supervise-v1-agent', 'SKILL.md'), 'utf8');

  assert.match(skill, /native V1 `wait_agent`[\s\S]*`timeout_ms=3600000`/);
  assert.match(skill, /\/\/ @exec: \{"yield_time_ms": 3600000\}[\s\S]*tools\.multi_agent_v1__wait_agent\([\s\S]*timeout_ms: 3600000/);
  assert.match(skill, /`wait_v1_agent` calls of at most 225000 ms/);
  assert.match(skill, /\/\/ @exec: \{"yield_time_ms": 240000\}[\s\S]*tools\.mcp__v1_agent_watcher__wait_v1_agent\([\s\S]*Math\.min\(225000, remainingHealthWindowMs\)/);
  assert.match(skill, /deliberate 15000 ms completion margin/);
  assert.match(skill, /900000 ms for Qwen, 300000 ms for Ornith, or 600000 ms for an unknown local worker/);
  assert.match(skill, /Repeated `wait\(cell_id\)` calls are not a normal or acceptable supervision path/);
  assert.match(skill, /unexpected Code Mode background-cell yield is an enclosing runtime failure/);
  assert.match(skill, /transport timeout contributes zero elapsed wait evidence/);
  assert.match(skill, /still `running` with recent persisted activity must be preserved/);
});
