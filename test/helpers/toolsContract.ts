import { z, type ZodRawShape } from 'zod';

/** Reduces `tools/list` entries to the contract recorded in test/fixtures/tools-contract.json. */
const KEPT = [
  'type',
  'description',
  'enum',
  'minimum',
  'exclusiveMinimum',
  'maximum',
  'minItems',
  'minLength',
  'default',
  'items',
  'anyOf',
  'properties',
  'required',
];

/** Reduce a JSON schema to the parts that matter to a client, with stable key order. */
function normalize(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(normalize);
  if (schema === null || typeof schema !== 'object') return schema;
  const s = schema as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of KEPT) {
    if (!(key in s)) continue;
    const v = s[key];
    // zod emits the safe-integer range for every .int(); that is noise, not a constraint.
    if ((key === 'minimum' || key === 'maximum') && Math.abs(v as number) === Number.MAX_SAFE_INTEGER) continue;
    if (key === 'properties') {
      const props: Record<string, unknown> = {};
      for (const name of Object.keys(v as object).sort()) props[name] = normalize((v as Record<string, unknown>)[name]);
      out[key] = props;
    } else {
      out[key] = normalize(v);
    }
  }
  return out;
}

export interface ToolContract {
  name: string;
  description: string;
  required: string[];
  args: Record<string, unknown>;
}

export function contractOf(tools: Array<{ name: string; description?: string; inputSchema: unknown }>): ToolContract[] {
  return tools.map((t) => {
    const schema = (t.inputSchema ?? {}) as { properties?: Record<string, unknown>; required?: string[] };
    const args: Record<string, unknown> = {};
    for (const name of Object.keys(schema.properties ?? {}).sort()) {
      args[name] = normalize(schema.properties![name]);
    }
    return { name: t.name, description: t.description ?? '', required: [...(schema.required ?? [])].sort(), args };
  });
}


/** Argument names the tool's zod schema rejects for `args` (validation lives in the schema, not the handler). */
export function invalidArgNames(tool: { inputSchema: ZodRawShape }, args: unknown): string[] {
  const parsed = z.object(tool.inputSchema).safeParse(args);
  return parsed.success ? [] : parsed.error.issues.map((i) => String(i.path[0]));
}
