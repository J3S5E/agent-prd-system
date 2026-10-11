import { z } from 'zod';
export declare const TicketStatusEnum: z.ZodEnum<{
    CREATE: "CREATE";
    DONE: "DONE";
    NEEDS_CLEANUP: "NEEDS_CLEANUP";
    NEEDS_FINALIZING: "NEEDS_FINALIZING";
    NEEDS_GIT_MERGE: "NEEDS_GIT_MERGE";
    NEEDS_HUMAN_CLARIFICATION: "NEEDS_HUMAN_CLARIFICATION";
    NEEDS_HUMAN_INTERVENTION: "NEEDS_HUMAN_INTERVENTION";
    NEEDS_HUMAN_PLAN_REVIEW: "NEEDS_HUMAN_PLAN_REVIEW";
    NEEDS_IMPLEMENTATION_UPDATE: "NEEDS_IMPLEMENTATION_UPDATE";
    NEEDS_IMPLEMENTING: "NEEDS_IMPLEMENTING";
    NEEDS_PLAN: "NEEDS_PLAN";
    NEEDS_PLAN_UPDATING: "NEEDS_PLAN_UPDATING";
    NEEDS_PR: "NEEDS_PR";
    NEEDS_PR_MAINTENANCE: "NEEDS_PR_MAINTENANCE";
    NEEDS_QA: "NEEDS_QA";
    NEEDS_REFINEMENT: "NEEDS_REFINEMENT";
    NEEDS_REVIEW: "NEEDS_REVIEW";
    NEEDS_SECURITY_REVIEW: "NEEDS_SECURITY_REVIEW";
    NEEDS_SUBTICKETS_PROCESSED: "NEEDS_SUBTICKETS_PROCESSED";
    NEEDS_VALIDATION: "NEEDS_VALIDATION";
    READY_PLAN_REVIEW: "READY_PLAN_REVIEW";
}>;
export type TicketStatus = z.infer<typeof TicketStatusEnum>;
export declare const STATUS_ORDER: TicketStatus[];
export declare const FLAGGED_STATUSES: TicketStatus[];
export declare const CreateTicketSchema: z.ZodObject<{
    repo: z.ZodString;
    name: z.ZodString;
    description: z.ZodOptional<z.ZodString>;
    targetBranch: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export declare const UpdateTicketSchema: z.ZodObject<{
    name: z.ZodOptional<z.ZodString>;
    description: z.ZodOptional<z.ZodString>;
    plan: z.ZodOptional<z.ZodString>;
    planIssues: z.ZodOptional<z.ZodString>;
    blockingIssues: z.ZodOptional<z.ZodString>;
    reviewComments: z.ZodOptional<z.ZodString>;
    securityNotes: z.ZodOptional<z.ZodString>;
    qaNotes: z.ZodOptional<z.ZodString>;
    featureBranch: z.ZodOptional<z.ZodString>;
    worktreeDir: z.ZodOptional<z.ZodString>;
    targetBranch: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export declare const UpdateTicketStatusSchema: z.ZodObject<{
    newStatus: z.ZodEnum<{
        CREATE: "CREATE";
        DONE: "DONE";
        NEEDS_CLEANUP: "NEEDS_CLEANUP";
        NEEDS_FINALIZING: "NEEDS_FINALIZING";
        NEEDS_GIT_MERGE: "NEEDS_GIT_MERGE";
        NEEDS_HUMAN_CLARIFICATION: "NEEDS_HUMAN_CLARIFICATION";
        NEEDS_HUMAN_INTERVENTION: "NEEDS_HUMAN_INTERVENTION";
        NEEDS_HUMAN_PLAN_REVIEW: "NEEDS_HUMAN_PLAN_REVIEW";
        NEEDS_IMPLEMENTATION_UPDATE: "NEEDS_IMPLEMENTATION_UPDATE";
        NEEDS_IMPLEMENTING: "NEEDS_IMPLEMENTING";
        NEEDS_PLAN: "NEEDS_PLAN";
        NEEDS_PLAN_UPDATING: "NEEDS_PLAN_UPDATING";
        NEEDS_PR: "NEEDS_PR";
        NEEDS_PR_MAINTENANCE: "NEEDS_PR_MAINTENANCE";
        NEEDS_QA: "NEEDS_QA";
        NEEDS_REFINEMENT: "NEEDS_REFINEMENT";
        NEEDS_REVIEW: "NEEDS_REVIEW";
        NEEDS_SECURITY_REVIEW: "NEEDS_SECURITY_REVIEW";
        NEEDS_SUBTICKETS_PROCESSED: "NEEDS_SUBTICKETS_PROCESSED";
        NEEDS_VALIDATION: "NEEDS_VALIDATION";
        READY_PLAN_REVIEW: "READY_PLAN_REVIEW";
    }>;
    comment: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export declare const UnblockTicketSchema: z.ZodObject<{
    direction: z.ZodEnum<{
        back: "back";
        forward: "forward";
    }>;
}, z.core.$strip>;
export declare const CreateSubtaskSchema: z.ZodObject<{
    name: z.ZodString;
    description: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export type CreateTicket = z.infer<typeof CreateTicketSchema>;
export type UpdateTicket = z.infer<typeof UpdateTicketSchema>;
export type UpdateTicketStatus = z.infer<typeof UpdateTicketStatusSchema>;
export type UnblockTicket = z.infer<typeof UnblockTicketSchema>;
export type CreateSubtask = z.infer<typeof CreateSubtaskSchema>;
//# sourceMappingURL=ticket.d.ts.map