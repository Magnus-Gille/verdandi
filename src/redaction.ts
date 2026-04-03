/**
 * Secret redaction pipeline.
 * Resolves debate critique C20: hook payloads can contain API keys, tokens, passwords.
 * Redaction happens BEFORE any persistence.
 */

interface RedactionRule {
  name: string;
  pattern: RegExp;
  replacement: string;
}

const REDACTION_RULES: RedactionRule[] = [
  {
    name: 'bearer_token',
    pattern: /Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi,
    replacement: 'Bearer [REDACTED:token]',
  },
  {
    name: 'authorization_header',
    pattern: /Authorization:\s*\S+/gi,
    replacement: 'Authorization: [REDACTED:auth]',
  },
  {
    name: 'api_key_generic',
    pattern:
      /(?:api[_-]?key|apikey|secret[_-]?key|access[_-]?token|auth[_-]?token)\s*[:=]\s*["']?[A-Za-z0-9\-._~+/]{16,}["']?/gi,
    replacement: '[REDACTED:api_key]',
  },
  {
    name: 'aws_key',
    pattern: /AKIA[0-9A-Z]{16}/g,
    replacement: '[REDACTED:aws_key]',
  },
  {
    name: 'anthropic_key',
    pattern: /sk-ant-[A-Za-z0-9\-._]{20,}/g,
    replacement: '[REDACTED:anthropic_key]',
  },
  {
    name: 'openai_key',
    pattern: /sk-[A-Za-z0-9]{20,}/g,
    replacement: '[REDACTED:openai_key]',
  },
  {
    name: 'verdandi_key',
    pattern: /vrd_[a-z]+_[0-9a-f]{32}/g,
    replacement: '[REDACTED:verdandi_key]',
  },
  {
    name: 'password_field',
    pattern: /(?:password|passwd|pwd)\s*[:=]\s*["']?[^\s"']{4,}["']?/gi,
    replacement: '[REDACTED:password]',
  },
  {
    name: 'private_key_block',
    pattern: /-----BEGIN\s+(RSA\s+)?PRIVATE KEY-----[\s\S]*?-----END\s+(RSA\s+)?PRIVATE KEY-----/g,
    replacement: '[REDACTED:private_key]',
  },
  {
    name: 'jwt_token',
    pattern: /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
    replacement: '[REDACTED:jwt]',
  },
];

/**
 * Fields that are structurally dropped (never stored, regardless of content).
 * These carry no audit value and may leak filesystem or session info.
 */
const STRUCTURAL_DROP_FIELDS = new Set([
  'transcript_path', // Laptop-local path, not usable remotely
  'tool_response',   // Raw tool output — too large, may contain secrets
]);

/**
 * Apply redaction rules to a single string value.
 */
function redactString(value: string): string {
  let result = value;
  for (const rule of REDACTION_RULES) {
    result = result.replace(rule.pattern, rule.replacement);
  }
  return result;
}

/**
 * Recursively redact all string values in an object.
 * Drops structurally prohibited fields.
 */
export function redact(value: unknown): unknown {
  if (value === null || value === undefined) return value;

  if (typeof value === 'string') {
    return redactString(value);
  }

  if (Array.isArray(value)) {
    return value.map(item => redact(item));
  }

  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};

    for (const [key, val] of Object.entries(obj)) {
      // Structural drops
      if (STRUCTURAL_DROP_FIELDS.has(key)) continue;

      result[key] = redact(val);
    }

    return result;
  }

  // Numbers, booleans — pass through
  return value;
}
