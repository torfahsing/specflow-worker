export interface JsonSchema {
  type: string;
  required?: string[];
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  enum?: string[];
}

export interface OutputSchema {
  name: string;
  schema: JsonSchema;
}

const REVIEW_PARSE_ERROR_TASK_ID = 'review-001';
const REVIEW_PARSE_ERROR_SEVERITY = 'high';
const REVIEW_PARSE_ERROR_FILE = 'unknown';
const REVIEW_PARSE_ERROR_LINE = 1;
const REVIEW_PARSE_ERROR_EXCERPT_LIMIT = 200;

export function parseStructuredOutput(text: string, schema: OutputSchema): unknown {
  const trimmed = text.trim();

  // Try direct JSON parse first
  let data = tryParseJson(trimmed);

  // Fallback 1: extract from fenced code blocks
  if (data === undefined) {
    const extracted = extractJsonFromFencedBlocks(trimmed);
    if (extracted) {
      data = tryParseJson(extracted);
    }
  }

  // Fallback 2: find JSON object/array embedded in prose
  if (data === undefined) {
    const extracted = extractJsonFromText(trimmed);
    if (extracted) {
      data = tryParseJson(extracted);
    }
  }

  if (data === undefined && schema.name === 'review-findings') {
    const lower = trimmed.toLowerCase();
    if (
      lower.includes('no problems found') ||
      lower.includes('all checks passed') ||
      lower === 'approve' ||
      lower === 'approved' ||
      lower.startsWith('approved.') ||
      lower.includes('recommendation: approve')
    ) {
      data = { recommendation: 'approve', findings: [] };
    } else if (trimmed.includes('```findings') || trimmed.includes('- [')) {
      const lines = trimmed.split('\n');
      const findings: Array<{ task_id: string; description: string; severity: string; file: string; line: number }> = [];
      for (const line of lines) {
        const m = line.match(/^-\s*\[(critical|important|suggestion|high|medium|low)\]\s*(?:task_id:)?\s*([^|]+)\|\s*(.+)$/i);
        if (m && m[1] && m[2] && m[3]) {
          const rawSev = m[1].toLowerCase();
          const sevMap: Record<string, string> = { critical: 'high', important: 'medium', suggestion: 'low', high: 'high', medium: 'medium', low: 'low' };
          findings.push({
            severity: sevMap[rawSev] || 'medium',
            task_id: m[2].trim(),
            description: m[3].trim(),
            file: 'unknown',
            line: 1,
          });
        }
      }
      if (findings.length > 0) {
        data = { recommendation: 'needs_changes', findings };
      } else if (lower.includes('needs changes') || lower.includes('needs_changes')) {
        data = { recommendation: 'needs_changes', findings: [] };
      }
    }

    // Fallback 3: fail closed — surface the parse failure as a visible finding
    if (data === undefined) {
      data = {
        recommendation: 'needs_changes',
        findings: [buildReviewParseErrorFinding(trimmed)],
      };
    }
  }

  if (data === undefined) {
    throw new Error(
      `Failed to parse structured output for schema "${schema.name}": no valid JSON found in agent output`,
    );
  }

  // Auto-wrap array if the schema expects a single-property object containing an array
  if (schema.schema.type === 'object' && Array.isArray(data)) {
    const isArrayOfObjects = data.length === 0 || (typeof data[0] === 'object' && data[0] !== null && !Array.isArray(data[0]));
    if (isArrayOfObjects) {
      const requiredKeys = schema.schema.required || [];
      if (requiredKeys.length === 1) {
        const singleKey = requiredKeys[0]!;
        const propSchema = schema.schema.properties?.[singleKey];
        if (propSchema && (propSchema as any).type === 'array') {
          data = { [singleKey]: data };
        }
      }
    }
  }

  validateAgainstSchema(data, schema.schema, schema.name);
  return data;
}

export function repairJson(text: string): string {
  let trimmed = text.trim();
  let braces = 0;
  let brackets = 0;
  let inString = false;
  let escape = false;

  for (let i = 0; i < trimmed.length; i++) {
    const char = trimmed[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (char === '\\') {
      escape = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (!inString) {
      if (char === '{') braces++;
      else if (char === '}') braces--;
      else if (char === '[') brackets++;
      else if (char === ']') brackets--;
    }
  }

  if (brackets > 0 && braces <= 0) {
    const lastBraceIdx = trimmed.lastIndexOf('}');
    if (lastBraceIdx !== -1) {
      trimmed = trimmed.slice(0, lastBraceIdx) + ']'.repeat(brackets) + trimmed.slice(lastBraceIdx);
    }
  } else {
    if (brackets > 0) trimmed += ']'.repeat(brackets);
    if (braces > 0) trimmed += '}'.repeat(braces);
  }

  return trimmed;
}

export function tryParseJson(text: string): unknown | undefined {
  let candidate = text;
  const jsonFenceMatch = candidate.match(/^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/);
  if (jsonFenceMatch && jsonFenceMatch[1]) {
    candidate = jsonFenceMatch[1];
  }

  candidate = repairJson(candidate);

  try {
    return JSON.parse(candidate);
  } catch {
    return undefined;
  }
}

export function extractJsonFromFencedBlocks(text: string): string | null {
  const fenceStart = '```json';
  const fenceEnd = '```';

  let searchFrom = 0;
  while (searchFrom < text.length) {
    const startIdx = text.indexOf(fenceStart, searchFrom);
    if (startIdx === -1) break;

    const afterStart = startIdx + fenceStart.length;
    const lineEnd = text.indexOf('\n', afterStart);
    if (lineEnd === -1) break;

    const endIdx = text.indexOf(fenceEnd, lineEnd + 1);
    if (endIdx === -1) break;

    const content = text.slice(lineEnd + 1, endIdx).trim();
    if (content.startsWith('{') || content.startsWith('[')) {
      return content;
    }

    searchFrom = endIdx + fenceEnd.length;
  }

  return null;
}

export function extractJsonFromText(text: string): string | null {
  const firstBrace = text.indexOf('{');
  const firstBracket = text.indexOf('[');

  let start: number;
  let openChar: string;
  let closeChar: string;

  if (firstBrace === -1 && firstBracket === -1) return null;

  if (firstBracket === -1 || (firstBrace !== -1 && firstBrace < firstBracket)) {
    start = firstBrace;
    openChar = '{';
    closeChar = '}';
  } else {
    start = firstBracket;
    openChar = '[';
    closeChar = ']';
  }

  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (char === '\\') {
      escape = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (!inString) {
      if (char === openChar) {
        depth++;
      } else if (char === closeChar) {
        depth--;
        if (depth === 0) {
          return text.slice(start, i + 1);
        }
      }
    }
  }

  const lastEnd = text.lastIndexOf(closeChar);
  if (lastEnd <= start) return null;

  return text.slice(start, lastEnd + 1);
}

function buildReviewParseErrorFinding(rawText: string): Record<string, unknown> {
  const excerpt = rawText.replace(/\s+/g, ' ').trim().slice(0, REVIEW_PARSE_ERROR_EXCERPT_LIMIT);
  return {
    task_id: REVIEW_PARSE_ERROR_TASK_ID,
    description:
      'Reviewer output could not be parsed as review-findings JSON: no valid JSON object was found in the model output. ' +
      `Raw output (truncated to ${REVIEW_PARSE_ERROR_EXCERPT_LIMIT} chars): "${excerpt}". ` +
      'This finding is synthetic — the review did not complete.',
    severity: REVIEW_PARSE_ERROR_SEVERITY,
    file: REVIEW_PARSE_ERROR_FILE,
    line: REVIEW_PARSE_ERROR_LINE,
  };
}

function validateAgainstSchema(data: unknown, schema: JsonSchema, schemaName: string): void {
  const errors = collectErrors(data, schema, '');
  if (errors.length > 0) {
    throw new Error(
      `Structured output validation failed for "${schemaName}":\n${errors.join('\n')}`,
    );
  }
}

function collectErrors(data: unknown, schema: JsonSchema, path: string): string[] {
  const errors: string[] = [];
  const loc = path || 'root';

  if (schema.type === 'object') {
    if (typeof data !== 'object' || data === null || Array.isArray(data)) {
      errors.push(`${loc}: expected object, got ${Array.isArray(data) ? 'array' : typeof data}`);
      return errors;
    }

    const obj = data as Record<string, unknown>;

    if (schema.required) {
      for (const key of schema.required) {
        if (!(key in obj)) {
          errors.push(`${loc}: missing required field "${key}"`);
        }
      }
    }

    if (schema.properties) {
      for (const [key, propSchema] of Object.entries(schema.properties)) {
        if (key in obj) {
          errors.push(...collectErrors(obj[key], propSchema, `${path}.${key}`));
        }
      }
    }
  } else if (schema.type === 'array') {
    if (!Array.isArray(data)) {
      errors.push(`${loc}: expected array, got ${typeof data}`);
      return errors;
    }

    if (schema.items) {
      for (let i = 0; i < data.length; i++) {
        errors.push(...collectErrors(data[i], schema.items, `${path}[${i}]`));
      }
    }
  } else if (schema.type === 'string') {
    if (typeof data !== 'string') {
      errors.push(`${loc}: expected string, got ${typeof data}`);
    } else if (schema.enum && !schema.enum.includes(data)) {
      errors.push(`${loc}: value "${data}" not in allowed values: ${schema.enum.join(', ')}`);
    }
  } else if (schema.type === 'integer') {
    if (typeof data !== 'number') {
      errors.push(`${loc}: expected integer, got ${typeof data}`);
    } else if (!Number.isInteger(data)) {
      errors.push(`${loc}: expected integer, got ${data}`);
    }
  } else if (schema.type === 'number') {
    if (typeof data !== 'number') {
      errors.push(`${loc}: expected number, got ${typeof data}`);
    }
  } else if (schema.type === 'boolean') {
    if (typeof data !== 'boolean') {
      errors.push(`${loc}: expected boolean, got ${typeof data}`);
    }
  }

  return errors;
}
