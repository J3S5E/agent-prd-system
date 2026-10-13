import { z } from 'zod';

export const ValidationCheckSchema = z.object({
  name: z.string().min(1),
  cmd: z.string().min(1),
  timeoutMs: z.number().int().positive().optional().default(1860000),
  env: z.record(z.string()).optional(),
});

export const ValidationConfigSchema = z.object({
  worktreeBase: z.string().default('.'),
  checks: z.array(ValidationCheckSchema).min(1),
  maxConcurrent: z.number().int().positive().optional().default(1),
});

export const ValidationRunResultSchema = z.object({
  checkName: z.string(),
  passed: z.boolean(),
  evidenceId: z.string(),
  stdout: z.string(),
  stderr: z.string(),
  exitCode: z.number().int(),
  durationMs: z.number().int(),
});

export const SubmitValidationResultsSchema = z.object({
  runId: z.string(),
  results: z.array(ValidationRunResultSchema).min(1),
});

export const GetValidationConfigSchema = z.object({
  ticketId: z.string(),
});

export type ValidationCheck = z.infer<typeof ValidationCheckSchema>;
export type ValidationConfig = z.infer<typeof ValidationConfigSchema>;
export type ValidationRunResult = z.infer<typeof ValidationRunResultSchema>;
export type SubmitValidationResults = z.infer<typeof SubmitValidationResultsSchema>;
export type GetValidationConfig = z.infer<typeof GetValidationConfigSchema>;