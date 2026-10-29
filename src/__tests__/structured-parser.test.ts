import { describe, it, expect } from 'bun:test';
import { parseStructuredOutput, type OutputSchema } from '../providers/structured-parser';

const REVIEW_FINDINGS_SCHEMA: OutputSchema = {
  name: 'review-findings',
  schema: {
    type: 'object',
    required: ['findings', 'recommendation'],
    properties: {
      recommendation: {
        type: 'string',
        enum: ['approve', 'needs_changes'],
      },
      findings: {
        type: 'array',
        items: {
          type: 'object',
          required: ['task_id', 'description', 'severity', 'file'],
          properties: {
            task_id: { type: 'string' },
            description: { type: 'string' },
            severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
            file: { type: 'string' },
            line: { type: 'integer' },
          },
        },
      },
    },
  },
};

describe('parseStructuredOutput in specflow-worker', () => {
  it('parses raw JSON review approval', () => {
    const input = JSON.stringify({ recommendation: 'approve', findings: [] });
    const result = parseStructuredOutput(input, REVIEW_FINDINGS_SCHEMA) as any;
    expect(result.recommendation).toBe('approve');
    expect(result.findings).toEqual([]);
  });

  it('extracts trailing JSON approval when agent outputs multi-turn reasoning and code snippets with braces', () => {
    const input = `I'll inspect the changed files and related contracts to verify spec fidelity. Let me start by reading the full modified component and the orchestrator test file referenced in the fix-build criterion.
interface WorkflowControlsProps {
  isCompleted: boolean;
  onToggle: () => void;
}
Let me check the implementation:
const config = { enabled: true };
All checks pass and requirements are met.
{
  "recommendation": "approve",
  "findings": []
}`;
    const result = parseStructuredOutput(input, REVIEW_FINDINGS_SCHEMA) as any;
    expect(result.recommendation).toBe('approve');
    expect(result.findings).toEqual([]);
  });

  it('parses JSON with trailing commas', () => {
    const input = `{
  "recommendation": "approve",
  "findings": [],
}`;
    const result = parseStructuredOutput(input, REVIEW_FINDINGS_SCHEMA) as any;
    expect(result.recommendation).toBe('approve');
    expect(result.findings).toEqual([]);
  });

  it('throws on unparseable output so runner can trigger 1-turn repair', () => {
    expect(() => parseStructuredOutput('Random gibberish without any findings or approval', REVIEW_FINDINGS_SCHEMA))
      .toThrow('Failed to parse structured output');
  });
});
