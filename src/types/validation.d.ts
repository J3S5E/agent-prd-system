import { z } from 'zod';
export declare const ValidationCheckSchema: z.ZodObject<{
    name: z.ZodString;
    cmd: z.ZodString;
    timeoutMs: z.ZodDefault<z.ZodOptional<z.ZodNumber>>;
    env: z.ZodOptional<z.ZodRecord<z.ZodString, z.core.SomeType>>;
}, z.core.$strip>;
export declare const ValidationConfigSchema: z.ZodObject<{
    worktreeBase: z.ZodDefault<z.ZodString>;
    checks: z.ZodArray<z.ZodObject<{
        name: z.ZodString;
        cmd: z.ZodString;
        timeoutMs: z.ZodDefault<z.ZodOptional<z.ZodNumber>>;
        env: z.ZodOptional<z.ZodRecord<z.ZodString, z.core.SomeType>>;
    }, z.core.$strip>>;
    maxConcurrent: z.ZodDefault<z.ZodOptional<z.ZodNumber>>;
}, z.core.$strip>;
export declare const ValidationRunResultSchema: z.ZodObject<{
    checkName: z.ZodString;
    passed: z.ZodBoolean;
    evidenceId: z.ZodString;
    stdout: z.ZodString;
    stderr: z.ZodString;
    exitCode: z.ZodNumber;
    durationMs: z.ZodNumber;
}, z.core.$strip>;
export declare const SubmitValidationResultsSchema: z.ZodObject<{
    runId: z.ZodString;
    results: z.ZodArray<z.ZodObject<{
        checkName: z.ZodString;
        passed: z.ZodBoolean;
        evidenceId: z.ZodString;
        stdout: z.ZodString;
        stderr: z.ZodString;
        exitCode: z.ZodNumber;
        durationMs: z.ZodNumber;
    }, z.core.$strip>>;
}, z.core.$strip>;
export declare const GetValidationConfigSchema: z.ZodObject<{
    ticketId: z.ZodString;
}, z.core.$strip>;
export type ValidationCheck = z.infer<typeof ValidationCheckSchema>;
export type ValidationConfig = z.infer<typeof ValidationConfigSchema>;
export type ValidationRunResult = z.infer<typeof ValidationRunResultSchema>;
export type SubmitValidationResults = z.infer<typeof SubmitValidationResultsSchema>;
export type GetValidationConfig = z.infer<typeof GetValidationConfigSchema>;
//# sourceMappingURL=validation.d.ts.map