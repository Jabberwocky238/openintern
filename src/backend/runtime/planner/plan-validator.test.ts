import { describe, expect, it } from 'vitest';
import { PlanValidationError, validatePlannerOutput } from './plan-validator.js';

describe('validatePlannerOutput', () => {
  it('normalizes tasks and computes layer index', () => {
    const output = validatePlannerOutput(
      {
        tasks: [
          { id: 't1', task: 'setup', role_id: 'role_a', depends_on: [] },
          { id: 't2', task: 'train', role_id: 'role_b', depends_on: ['t1'] },
        ],
      },
      ['role_a', 'role_b']
    );

    expect(output.tasks).toHaveLength(2);
    expect(output.tasks.find((task) => task.id === 't1')?.layerIndex).toBe(0);
    expect(output.tasks.find((task) => task.id === 't2')?.layerIndex).toBe(1);
  });

  it('throws on missing dependency', () => {
    expect(() => validatePlannerOutput(
      {
        tasks: [
          { id: 't1', task: 'setup', role_id: 'role_a', depends_on: ['t_missing'] },
        ],
      },
      ['role_a']
    )).toThrowError(PlanValidationError);
  });

  it('throws on dependency cycle', () => {
    expect(() => validatePlannerOutput(
      {
        tasks: [
          { id: 'a', task: 'A', role_id: 'role_a', depends_on: ['b'] },
          { id: 'b', task: 'B', role_id: 'role_a', depends_on: ['a'] },
        ],
      },
      ['role_a']
    )).toThrowError(PlanValidationError);
  });

  it('throws on unknown role', () => {
    expect(() => validatePlannerOutput(
      {
        tasks: [
          { id: 't1', task: 'setup', role_id: 'role_unknown', depends_on: [] },
        ],
      },
      ['role_a']
    )).toThrowError(PlanValidationError);
  });
});


