import { z } from 'zod';

/** A CQL parameter as the execute and test-run tools take it. */
export const cqlParameterSchema = z.object({
  name: z.string(),
  type: z.string().optional(),
  value: z.string(),
});

/** `[{ name, type, value }]`, the documented parameter form (ADR-0004 §2.2). */
export const cqlParametersSchema = z.array(cqlParameterSchema);
