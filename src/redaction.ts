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

const SENSITIVE_FIELD_LABELS = new Map<string, string>([
  ['authorization', 'auth'],
  ['proxyauthorization', 'auth'],
  ['password', 'password'],
  ['passwd', 'password'],
  ['pwd', 'password'],
  ['apikey', 'api_key'],
  ['secretkey', 'api_key'],
  ['clientsecret', 'api_key'],
  ['accesstoken', 'token'],
  ['authtoken', 'token'],
  ['idtoken', 'token'],
  ['refreshtoken', 'token'],
  ['token', 'token'],
  ['privatekey', 'private_key'],
  ['secret', 'secret'],
]);

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
      /((?:api[_-]?key|apikey|secret[_-]?key|access[_-]?token|auth[_-]?token)\s*[:=]\s*)(["']?)[A-Za-z0-9\-._~+/]{16,}=*\2/gi,
    replacement: '$1$2[REDACTED:api_key]$2',
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
    pattern: /vrd_[a-z0-9][a-z0-9_-]*_[0-9a-f]{32}/gi,
    replacement: '[REDACTED:verdandi_key]',
  },
  {
    name: 'password_field',
    pattern: /((?:password|passwd|pwd)\s*[:=]\s*)(["']?)[^\s"',;}]{4,}\2/gi,
    replacement: '$1$2[REDACTED:password]$2',
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

const JSON_SENSITIVE_FIELD_PATTERN =
  /(["'](?:authorization|proxy[_-]?authorization|password|passwd|pwd|api[_-]?key|secret[_-]?key|client[_-]?secret|access[_-]?token|auth[_-]?token|id[_-]?token|refresh[_-]?token|token|private[_-]?key|secret)["']\s*:\s*)(?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*')/gi;

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
export function redactText(value: string): string {
  let result = value.replace(
    JSON_SENSITIVE_FIELD_PATTERN,
    '$1"[REDACTED:sensitive_value]"'
  );
  for (const rule of REDACTION_RULES) {
    result = result.replace(rule.pattern, rule.replacement);
  }
  return result;
}

function normalizeFieldName(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Recursively redact all string values in an object.
 * Drops structurally prohibited fields.
 */
export function redact(value: unknown): unknown {
  if (value === null || value === undefined) return value;

  if (typeof value === 'string') {
    return redactText(value);
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

      const sensitiveLabel = SENSITIVE_FIELD_LABELS.get(normalizeFieldName(key));
      if (sensitiveLabel && val !== null && val !== undefined) {
        const specificallyRedacted = typeof val === 'string' ? redactText(val) : val;
        result[key] = specificallyRedacted !== val
          ? specificallyRedacted
          : `[REDACTED:${sensitiveLabel}]`;
      } else {
        result[key] = redact(val);
      }
    }

    return result;
  }

  // Numbers, booleans — pass through
  return value;
}
