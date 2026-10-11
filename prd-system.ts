import { tool } from "@opencode-ai/plugin";

const PRD_SERVER = process.env.PRD_SERVER_URL || "http://localhost:42069";

async function fetchApi(path: string, options: RequestInit = {}): Promise<any> {
  const url = `${PRD_SERVER}/api/v1${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...options.headers,
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text}`);
  }

  return res.json();
}

async function fetchApiWithRetry(
  path: string,
  options: RequestInit = {},
  retries = 3,
  backoff = 1000,
): Promise<any> {
  for (let i = 0; i < retries; i++) {
    try {
      return await fetchApi(path, options);
    } catch (err) {
      if (i === retries - 1) throw err;
      await new Promise((r) => setTimeout(r, backoff * (i + 1)));
    }
  }
}

export const getConfig = tool({
  description: "Returns the PRD system agent count configuration.",
  args: {},
  async execute() {
    const counts = {
      alignment: 3,
      research: 3,
      review: 5,
      validation: 3,
      qa: 3,
    };
    return JSON.stringify(counts, null, 2);
  },
});

export const create = tool({
  description: "Creates a Product Requirement Document (PRD) in the system.",
  args: {
    gitRepo: tool.schema.string().describe("Git repository name"),
    name: tool.schema.string().min(25).max(250).describe("Name of the ticket"),
    jiraTicket: tool.schema
      .string()
      .min(2)
      .max(20)
      .optional()
      .describe("JIRA ticket ID"),
    description: tool.schema
      .string()
      .min(25)
      .max(2000)
      .describe("Description of the ticket"),
    targetBranch: tool.schema
      .string()
      .min(1)
      .max(100)
      .describe("Target branch for PR"),
    priority: tool.schema
      .enum(['P0', 'P1', 'P2', 'P3'])
      .optional()
      .describe("Priority: P0, P1, P2, or P3 (defaults to P2)"),
  },
  async execute({
    gitRepo,
    name,
    description,
    targetBranch,
    jiraTicket,
    priority,
  }) {
    const data = await fetchApiWithRetry("/tickets", {
      method: "POST",
      body: JSON.stringify({ repo: gitRepo, name, description, targetBranch, jiraTicket, priority }),
    });
    return `Ticket created with ID - ${data.id}`;
  },
});

export const getTicket = tool({
  description: "Gets a ticket by its ID.",
  args: {
    id: tool.schema.string().describe("Ticket ID"),
    gitRepo: tool.schema.string().describe("Git repository name"),
  },
  async execute({ id, gitRepo }) {
    const data = await fetchApiWithRetry(
      `/tickets/${id}?repo=${encodeURIComponent(gitRepo)}`,
    );
    return JSON.stringify(data, null, 2);
  },
});

export const escalate = tool({
  description: "Escalates a ticket for human intervention.",
  args: {
    id: tool.schema.string().describe("Ticket ID"),
    gitRepo: tool.schema.string().describe("Git repository name"),
    subtaskId: tool.schema.string().optional().describe("Subtask ID"),
  },
  async execute({ id, gitRepo, subtaskId }) {
    const ticket = await fetchApiWithRetry(
      `/tickets/${id}?repo=${encodeURIComponent(gitRepo)}`,
    );
    const target = subtaskId
      ? ticket.subtasks?.find((s: any) => s.id === subtaskId)
      : ticket;
    if (!target)
      return subtaskId
        ? `Subtask ${subtaskId} not found`
        : `Ticket ${id} not found`;

    const status = target.status;
    const terminalStatuses = ["Done", "Cancelled"];
    if (terminalStatuses.includes(status)) {
      return `${subtaskId ? `Subtask ${subtaskId}` : `Ticket ${id}`} is in terminal state (${status})`;
    }

    const flaggedMap: Record<string, string> = {
      "Needs Refinement": "NEEDS_HUMAN_CLARIFICATION",
      "Needs Plan": "NEEDS_HUMAN_CLARIFICATION",
      "Needs Plan Updating": "NEEDS_HUMAN_CLARIFICATION",
      "Ready Plan Review": "NEEDS_HUMAN_CLARIFICATION",
      "Needs Subtickets Processed": "NEEDS_HUMAN_SUBTICKETS",
      "Needs Validation": "NEEDS_HUMAN_IMPLEMENTATION",
      "Needs Implementing": "NEEDS_HUMAN_CLARIFICATION",
      "Needs Implementation Update": "NEEDS_HUMAN_CLARIFICATION",
      "Needs Review": "NEEDS_HUMAN_CLARIFICATION",
      "Needs Security Review": "NEEDS_HUMAN_CLARIFICATION",
      "Needs QA": "NEEDS_HUMAN_CLARIFICATION",
      "Needs PR": "NEEDS_HUMAN_PR",
      "Needs PR Maintenance": "NEEDS_HUMAN_PR_MAINTENANCE",
      "Awaiting Human Merge": "NEEDS_HUMAN_MERGE_CLARIFICATION",
      "Needs Git Merge": "NEEDS_HUMAN_GIT_MERGE",
      "Needs Reapproach": "NEEDS_HUMAN_REAPPROACH",
      Blocked: "NEEDS_HUMAN_UNBLOCK",
      "Needs Finalizing": "NEEDS_HUMAN_CLARIFICATION",
      "Needs Cleanup": "NEEDS_HUMAN_CLEANUP",
    };

    const newStatus = flaggedMap[status] || "NEEDS_HUMAN_CLARIFICATION";
    await fetchApiWithRetry(`/tickets/${id}/status`, {
      method: "PATCH",
      body: JSON.stringify({ newStatus }),
    });

    return `${subtaskId ? `Subtask ${subtaskId}` : `Ticket ${id}`} escalated to ${newStatus}.`;
  },
});

export const submitPR = tool({
  description: "Submits a PR for a ticket.",
  args: {
    id: tool.schema.string().describe("Ticket ID"),
    subtaskId: tool.schema.string().optional().describe("Subtask ID"),
    prUrl: tool.schema.string().optional().describe("PR URL"),
  },
  async execute({ id, prUrl, subtaskId }) {
    const data = await fetchApiWithRetry(`/tickets/${id}/status`, {
      method: "PATCH",
      body: JSON.stringify({ newStatus: "NEEDS_PR_MAINTENANCE" }),
    });
    if (prUrl) {
      await fetchApiWithRetry(`/tickets/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ prUrl }),
      });
    }
    return `${subtaskId ? `Subtask ${subtaskId}` : `Ticket ${id}`} PR submitted.`;
  },
});

export const flagPrRework = tool({
  description: "Flags a PR for rework.",
  args: {
    id: tool.schema.string().describe("Ticket ID"),
    subtaskId: tool.schema.string().optional().describe("Subtask ID"),
    rejectionType: tool.schema
      .string()
      .optional()
      .describe("'implementation' or 'approach'"),
    rejectionNotes: tool.schema.string().describe("Why rework is needed"),
  },
  async execute({ id, rejectionType, rejectionNotes, subtaskId }) {
    const newStatus =
      rejectionType === "approach"
        ? "NEEDS_REAPPROACH"
        : "NEEDS_IMPLEMENTATION_UPDATE";
    await fetchApiWithRetry(`/tickets/${id}/status`, {
      method: "PATCH",
      body: JSON.stringify({ newStatus }),
    });
    return `${subtaskId ? `Subtask ${subtaskId}` : `Ticket ${id}`} flagged for ${newStatus}.`;
  },
});

export const requestHumanMerge = tool({
  description: "Requests human merge for a PR.",
  args: {
    id: tool.schema.string().describe("Ticket ID"),
    subtaskId: tool.schema.string().optional().describe("Subtask ID"),
    ciResults: tool.schema
      .array(tool.schema.string())
      .describe("CI check results"),
  },
  async execute({ id, ciResults, subtaskId }) {
    await fetchApiWithRetry(`/tickets/${id}/status`, {
      method: "PATCH",
      body: JSON.stringify({ newStatus: "AWAITING_HUMAN_MERGE" }),
    });
    return `${subtaskId ? `Subtask ${subtaskId}` : `Ticket ${id}`} PR passed checks. Awaiting human merge.`;
  },
});

export const completeGitMerge = tool({
  description: "Completes git merge for a subtask.",
  args: {
    id: tool.schema.string().describe("Parent ticket ID"),
    subtaskId: tool.schema.string().describe("Subtask ID"),
  },
  async execute({ id, subtaskId }) {
    await fetchApiWithRetry(`/tickets/${subtaskId}/status`, {
      method: "PATCH",
      body: JSON.stringify({ newStatus: "NEEDS_FINALIZING" }),
    });
    return `Subtask ${subtaskId} git merge completed.`;
  },
});

export const updateName = tool({
  description: "Updates ticket name.",
  args: {
    id: tool.schema.string().describe("Ticket ID"),
    name: tool.schema.string().min(5).max(250).describe("New name"),
  },
  async execute({ id, name }) {
    await fetchApiWithRetry(`/tickets/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ name }),
    });
    return `Name updated for ${id}.`;
  },
});

export const updateDescription = tool({
  description: "Updates ticket description.",
  args: {
    id: tool.schema.string().describe("Ticket ID"),
    description: tool.schema
      .string()
      .min(5)
      .max(2000)
      .describe("New description"),
  },
  async execute({ id, description }) {
    await fetchApiWithRetry(`/tickets/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ description }),
    });
    return `Description updated for ${id}.`;
  },
});

export const updatePriority = tool({
  description: "Updates ticket priority.",
  args: {
    id: tool.schema.string().describe("Ticket ID"),
    priority: tool.schema.enum(['P0', 'P1', 'P2', 'P3']).describe("Priority: P0, P1, P2, P3"),
  },
  async execute({ id, priority }) {
    await fetchApiWithRetry(`/tickets/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ priority }),
    });
    return `Priority for ${id} updated to ${priority}.`;
  },
});

export const createSubtask = tool({
  description: "Creates a subtask.",
  args: {
    id: tool.schema.string().describe("Parent ticket ID"),
    name: tool.schema.string().min(5).max(250).describe("Subtask name"),
    description: tool.schema
      .string()
      .min(5)
      .max(2000)
      .describe("Subtask description"),
  },
  async execute({ id, name, description }) {
    const data = await fetchApiWithRetry(`/tickets/${id}/subtasks`, {
      method: "POST",
      body: JSON.stringify({ name, description }),
    });
    return `Subtask created with ID ${data.id} for ticket ${id}.`;
  },
});

export const deleteSubtask = tool({
  description: "Deletes a subtask.",
  args: {
    id: tool.schema.string().describe("Parent ticket ID"),
    subtaskId: tool.schema.string().describe("Subtask ID"),
  },
  async execute({ id, subtaskId }) {
    await fetchApiWithRetry(`/tickets/${subtaskId}`, { method: "DELETE" });
    return `Subtask ${subtaskId} deleted from ticket ${id}.`;
  },
});

export const assignWorkspace = tool({
  description: "Assigns feature branch and worktree directory.",
  args: {
    id: tool.schema.string().describe("Ticket ID"),
    subtaskId: tool.schema.string().optional().describe("Subtask ID"),
    featureBranch: tool.schema
      .string()
      .min(1)
      .max(250)
      .describe("Feature branch name"),
    worktreeDir: tool.schema
      .string()
      .min(1)
      .max(500)
      .describe("Worktree directory path"),
  },
  async execute({ id, subtaskId, featureBranch, worktreeDir }) {
    const ticketId = subtaskId || id;
    await fetchApiWithRetry(`/tickets/${ticketId}`, {
      method: "PATCH",
      body: JSON.stringify({ featureBranch, worktreeDir }),
    });
    return `Workspace assigned: featureBranch="${featureBranch}", worktreeDir="${worktreeDir}".`;
  },
});

export const refineTicket = tool({
  description:
    "Refines a ticket with acceptance criteria, estimation, tech notes, dependencies.",
  args: {
    id: tool.schema.string().describe("Ticket ID"),
    subtaskId: tool.schema.string().optional().describe("Subtask ID"),
    acceptanceCriterias: tool.schema
      .array(tool.schema.string())
      .min(1)
      .describe("Acceptance criteria"),
    estimation: tool.schema.string().describe("Estimation"),
    techNotes: tool.schema
      .array(tool.schema.string())
      .describe("Technical notes"),
    dependencys: tool.schema
      .array(tool.schema.string())
      .describe("Dependencies"),
  },
  async execute({
    id,
    acceptanceCriterias,
    estimation,
    techNotes,
    dependencys,
    subtaskId,
  }) {
    const ticketId = subtaskId || id;
    await fetchApiWithRetry(`/tickets/${ticketId}`, {
      method: "PATCH",
      body: JSON.stringify({
        acceptanceCriterias,
        estimation,
        techNotes,
        dependencys,
      }),
    });
    return `Ticket ${id} refined successfully.`;
  },
});

export const finalizeRefinement = tool({
  description: "Finalizes ticket refinement.",
  args: {
    id: tool.schema.string().describe("Ticket ID"),
  },
  async execute({ id }) {
    await fetchApiWithRetry(`/tickets/${id}/status`, {
      method: "PATCH",
      body: JSON.stringify({ newStatus: "NEEDS_PLAN" }),
    });
    return `Ticket ${id} finalized and marked as Needs Plan.`;
  },
});

export const savePlan = tool({
  description: "Saves implementation plan.",
  args: {
    id: tool.schema.string().describe("Ticket ID"),
    subtaskId: tool.schema.string().optional().describe("Subtask ID"),
    plan: tool.schema.string().min(10).describe("Markdown plan"),
  },
  async execute({ id, plan, subtaskId }) {
    const ticketId = subtaskId || id;
    await fetchApiWithRetry(`/tickets/${ticketId}`, {
      method: "PATCH",
      body: JSON.stringify({ plan, planIssues: "", blockingIssues: "" }),
    });
    return `Plan saved for ${subtaskId ? `subtask ${subtaskId}` : `ticket ${id}`}.`;
  },
});

export const finalizePlanning = tool({
  description: "Finalizes planning, moves to Ready Plan Review.",
  args: {
    id: tool.schema.string().describe("Ticket ID"),
    subtaskId: tool.schema.string().optional().describe("Subtask ID"),
  },
  async execute({ id, subtaskId }) {
    const ticketId = subtaskId || id;
    await fetchApiWithRetry(`/tickets/${ticketId}/status`, {
      method: "PATCH",
      body: JSON.stringify({ newStatus: "READY_PLAN_REVIEW" }),
    });
    return `${subtaskId ? `Subtask ${subtaskId}` : `Ticket ${id}`} finalized to Ready Plan Review.`;
  },
});

export const addPlanIssues = tool({
  description: "Records plan review issues.",
  args: {
    id: tool.schema.string().describe("Ticket ID"),
    subtaskId: tool.schema.string().optional().describe("Subtask ID"),
    issues: tool.schema
      .array(tool.schema.string())
      .describe("Non-blocking issues"),
    blockingIssues: tool.schema
      .array(tool.schema.string())
      .describe("Blocking issues"),
  },
  async execute({ id, issues, blockingIssues, subtaskId }) {
    const ticketId = subtaskId || id;
    await fetchApiWithRetry(`/tickets/${ticketId}`, {
      method: "PATCH",
      body: JSON.stringify({
        planIssues: issues.join("\n"),
        blockingIssues: blockingIssues.join("\n"),
      }),
    });
    return `Plan issues recorded for ${ticketId}.`;
  },
});

export const finishPlanReview = tool({
  description: "Finalizes plan review.",
  args: {
    id: tool.schema.string().describe("Ticket ID"),
    gitRepo: tool.schema.string().describe("Git repository name"),
    subtaskId: tool.schema.string().optional().describe("Subtask ID"),
  },
  async execute({ id, gitRepo, subtaskId }) {
    const ticketId = subtaskId || id;
    const ticket = await fetchApiWithRetry(
      `/tickets/${ticketId}?repo=${encodeURIComponent(gitRepo)}`,
    );
    const hasBlocking =
      ticket.blockingIssues && ticket.blockingIssues.length > 0;
    const iteration = ticket.planIteration || 0;

    if (hasBlocking && iteration > 6) {
      await fetchApiWithRetry(`/tickets/${ticketId}/status`, {
        method: "PATCH",
        body: JSON.stringify({ newStatus: "NEEDS_HUMAN_PLAN_REVIEW" }),
      });
      return `Escalated to Needs Human Plan Review.`;
    }
    if (hasBlocking) {
      await fetchApiWithRetry(`/tickets/${ticketId}/status`, {
        method: "PATCH",
        body: JSON.stringify({ newStatus: "NEEDS_PLAN_UPDATING" }),
      });
      return `Marked as Needs Plan Updating.`;
    }
    if (!subtaskId && iteration > 3) {
      const nextStatus = ticket.subtasks?.length
        ? "NEEDS_SUBTICKETS_PROCESSED"
        : "NEEDS_IMPLEMENTING";
      await fetchApiWithRetry(`/tickets/${ticketId}/status`, {
        method: "PATCH",
        body: JSON.stringify({ newStatus: nextStatus }),
      });
      return `Force-through to ${nextStatus}.`;
    }
    const issueCount = ticket.planIssues?.length || 0;
    if (issueCount > 0) {
      await fetchApiWithRetry(`/tickets/${ticketId}/status`, {
        method: "PATCH",
        body: JSON.stringify({ newStatus: "NEEDS_PLAN_UPDATING" }),
      });
      return `Marked as Needs Plan Updating (${issueCount} issues).`;
    }

    const targetStatus = subtaskId
      ? "NEEDS_IMPLEMENTING"
      : ticket.subtasks?.length
        ? "NEEDS_SUBTICKETS_PROCESSED"
        : "NEEDS_IMPLEMENTING";
    await fetchApiWithRetry(`/tickets/${ticketId}/status`, {
      method: "PATCH",
      body: JSON.stringify({ newStatus: targetStatus }),
    });
    return `Finalized to ${targetStatus}.`;
  },
});

export const completeImplementation = tool({
  description: "Marks implementation complete.",
  args: {
    id: tool.schema.string().describe("Ticket ID"),
    subtaskId: tool.schema.string().optional().describe("Subtask ID"),
    branch: tool.schema.string().optional().describe("Branch name"),
  },
  async execute({ id, branch, subtaskId }) {
    const ticketId = subtaskId || id;
    if (branch) {
      await fetchApiWithRetry(`/tickets/${ticketId}`, {
        method: "PATCH",
        body: JSON.stringify({ branch }),
      });
    }
    await fetchApiWithRetry(`/tickets/${ticketId}/status`, {
      method: "PATCH",
      body: JSON.stringify({ newStatus: "NEEDS_VALIDATION" }),
    });
    return `${subtaskId ? `Subtask ${subtaskId}` : `Ticket ${id}`} marked as Needs Validation.`;
  },
});

export const reviewImplementation = tool({
  description: "Reviews implementation.",
  args: {
    id: tool.schema.string().describe("Ticket ID"),
    subtaskId: tool.schema.string().optional().describe("Subtask ID"),
    passed: tool.schema.boolean().describe("Whether passed"),
    reviewComments: tool.schema
      .array(tool.schema.string())
      .describe("Review comments"),
  },
  async execute({ id, passed, reviewComments, subtaskId }) {
    const ticketId = subtaskId || id;
    if (!passed && (!reviewComments || reviewComments.length === 0)) {
      return "Review comments required when not passed.";
    }

    if (passed) {
      await fetchApiWithRetry(`/tickets/${ticketId}/status`, {
        method: "PATCH",
        body: JSON.stringify({ newStatus: "NEEDS_SECURITY_REVIEW" }),
      });
    } else {
      await fetchApiWithRetry(`/tickets/${ticketId}/status`, {
        method: "PATCH",
        body: JSON.stringify({ newStatus: "NEEDS_IMPLEMENTATION_UPDATE" }),
      });
    }
    return `${subtaskId ? `Subtask ${subtaskId}` : `Ticket ${id}`} reviewed.`;
  },
});

export const completeQA = tool({
  description: "Completes QA.",
  args: {
    id: tool.schema.string().describe("Ticket ID"),
    gitRepo: tool.schema.string().describe("Git repository name"),
    subtaskId: tool.schema.string().optional().describe("Subtask ID"),
    passed: tool.schema.boolean().describe("Whether QA passed"),
    qaNotes: tool.schema.array(tool.schema.string()).describe("QA notes"),
  },
  async execute({ id, gitRepo, passed, qaNotes, subtaskId }) {
    const ticketId = subtaskId || id;
    if (!passed && (!qaNotes || qaNotes.length === 0)) {
      return "QA notes required when not passed.";
    }

    if (passed) {
      const ticket = await fetchApiWithRetry(
        `/tickets/${ticketId}?repo=${encodeURIComponent(gitRepo)}`,
      );
      const nextStatus =
        subtaskId && !ticket.subtasksNeedPrs ? "NEEDS_GIT_MERGE" : "NEEDS_PR";
      await fetchApiWithRetry(`/tickets/${ticketId}/status`, {
        method: "PATCH",
        body: JSON.stringify({ newStatus: nextStatus }),
      });
    } else {
      await fetchApiWithRetry(`/tickets/${ticketId}/status`, {
        method: "PATCH",
        body: JSON.stringify({ newStatus: "NEEDS_IMPLEMENTATION_UPDATE" }),
      });
    }
    return `${subtaskId ? `Subtask ${subtaskId}` : `Ticket ${id}`} QA completed.`;
  },
});

export const completeSecurityReview = tool({
  description: "Completes security review.",
  args: {
    id: tool.schema.string().describe("Ticket ID"),
    subtaskId: tool.schema.string().optional().describe("Subtask ID"),
    passed: tool.schema.boolean().describe("Whether passed"),
    securityNotes: tool.schema
      .array(tool.schema.string())
      .describe("Security notes"),
  },
  async execute({ id, passed, securityNotes, subtaskId }) {
    const ticketId = subtaskId || id;
    if (!passed && (!securityNotes || securityNotes.length === 0)) {
      return "Security notes required when not passed.";
    }

    if (passed) {
      await fetchApiWithRetry(`/tickets/${ticketId}/status`, {
        method: "PATCH",
        body: JSON.stringify({ newStatus: "NEEDS_QA" }),
      });
    } else {
      await fetchApiWithRetry(`/tickets/${ticketId}/status`, {
        method: "PATCH",
        body: JSON.stringify({ newStatus: "NEEDS_IMPLEMENTATION_UPDATE" }),
      });
    }
    return `${subtaskId ? `Subtask ${subtaskId}` : `Ticket ${id}`} security review completed.`;
  },
});

export const completePR = tool({
  description: "Confirms PR merged.",
  args: {
    id: tool.schema.string().describe("Ticket ID"),
    subtaskId: tool.schema.string().optional().describe("Subtask ID"),
    prUrl: tool.schema.string().optional().describe("PR URL"),
    merged: tool.schema
      .boolean()
      .optional()
      .describe("Whether merged (default true)"),
  },
  async execute({ id, prUrl, merged, subtaskId }) {
    if (merged === false) {
      return "Use flagPrRework instead of completePR with merged=false.";
    }
    const ticketId = subtaskId || id;
    if (prUrl) {
      await fetchApiWithRetry(`/tickets/${ticketId}`, {
        method: "PATCH",
        body: JSON.stringify({ prUrl }),
      });
    }
    await fetchApiWithRetry(`/tickets/${ticketId}/status`, {
      method: "PATCH",
      body: JSON.stringify({ newStatus: "NEEDS_FINALIZING" }),
    });
    return `${subtaskId ? `Subtask ${subtaskId}` : `Ticket ${id}`} PR confirmed merged.`;
  },
});

export const finalizeReapproach = tool({
  description: "Finalizes reapproach.",
  args: {
    id: tool.schema.string().describe("Ticket ID"),
    subtaskId: tool.schema.string().optional().describe("Subtask ID"),
  },
  async execute({ id, subtaskId }) {
    const ticketId = subtaskId || id;
    await fetchApiWithRetry(`/tickets/${ticketId}/status`, {
      method: "PATCH",
      body: JSON.stringify({ newStatus: "NEEDS_PLAN_UPDATING" }),
    });
    return `${subtaskId ? `Subtask ${subtaskId}` : `Ticket ${id}`} reapproach finalized.`;
  },
});

export const finalizeTicket = tool({
  description: "Finalizes ticket to Needs Cleanup.",
  args: {
    id: tool.schema.string().describe("Ticket ID"),
    subtaskId: tool.schema.string().optional().describe("Subtask ID"),
  },
  async execute({ id, subtaskId }) {
    const ticketId = subtaskId || id;
    await fetchApiWithRetry(`/tickets/${ticketId}/status`, {
      method: "PATCH",
      body: JSON.stringify({ newStatus: "NEEDS_CLEANUP" }),
    });
    return `${subtaskId ? `Subtask ${subtaskId}` : `Ticket ${id}`} finalized to Needs Cleanup.`;
  },
});

export const completeCleanup = tool({
  description: "Completes cleanup, marks Done.",
  args: {
    id: tool.schema.string().describe("Ticket ID"),
    subtaskId: tool.schema.string().optional().describe("Subtask ID"),
  },
  async execute({ id, subtaskId }) {
    const ticketId = subtaskId || id;
    await fetchApiWithRetry(`/tickets/${ticketId}/status`, {
      method: "PATCH",
      body: JSON.stringify({ newStatus: "DONE" }),
    });
    return `${subtaskId ? `Subtask ${subtaskId}` : `Ticket ${id}`} cleanup complete, marked Done.`;
  },
});

export const blockTicket = tool({
  description: "Blocks a ticket.",
  args: {
    id: tool.schema.string().describe("Ticket ID"),
    subtaskId: tool.schema.string().optional().describe("Subtask ID"),
    blockedReason: tool.schema.string().describe("Reason for blocking"),
  },
  async execute({ id, blockedReason, subtaskId }) {
    const ticketId = subtaskId || id;
    await fetchApiWithRetry(`/tickets/${ticketId}/status`, {
      method: "PATCH",
      body: JSON.stringify({ newStatus: "BLOCKED", comment: blockedReason }),
    });
    return `${subtaskId ? `Subtask ${subtaskId}` : `Ticket ${id}`} blocked: ${blockedReason}`;
  },
});

export const unblockTicket = tool({
  description: "Unblocks a ticket.",
  args: {
    id: tool.schema.string().describe("Ticket ID"),
    gitRepo: tool.schema.string().describe("Git repository name"),
    subtaskId: tool.schema.string().optional().describe("Subtask ID"),
  },
  async execute({ id, gitRepo, subtaskId }) {
    const ticketId = subtaskId || id;
    const ticket = await fetchApiWithRetry(
      `/tickets/${ticketId}?repo=${encodeURIComponent(gitRepo)}`,
    );
    const flaggedMap: Record<string, { back: string; forward: string }> = {
      NEEDS_HUMAN_INTERVENTION: {
        back: "NEEDS_IMPLEMENTATION_UPDATE",
        forward: "NEEDS_REVIEW",
      },
      NEEDS_HUMAN_CLARIFICATION: {
        back: "NEEDS_IMPLEMENTATION_UPDATE",
        forward: "NEEDS_REVIEW",
      },
      NEEDS_HUMAN_PLAN_REVIEW: {
        back: "NEEDS_PLAN_UPDATING",
        forward: "NEEDS_IMPLEMENTING",
      },
    };
    const targets = flaggedMap[ticket.status];
    if (!targets) return `Not a flagged state: ${ticket.status}`;

    await fetchApiWithRetry(`/tickets/${ticketId}/unblock`, {
      method: "POST",
      body: JSON.stringify({ direction: "forward" }),
    });
    return `${subtaskId ? `Subtask ${subtaskId}` : `Ticket ${id}`} unblocked forward.`;
  },
});

export const addSuggestion = tool({
  description: "Adds out-of-scope suggestion.",
  args: {
    id: tool.schema.string().describe("Ticket ID"),
    message: tool.schema
      .string()
      .min(10)
      .max(500)
      .describe("Suggestion message"),
    source: tool.schema
      .string()
      .describe("Source: planning, implementation, review, qa, security"),
    subtaskId: tool.schema.string().optional().describe("Subtask ID"),
  },
  async execute({ id, message, source, subtaskId }) {
    const ticketId = subtaskId || id;
    await fetchApiWithRetry(`/tickets/${ticketId}/suggestions`, {
      method: "POST",
      body: JSON.stringify({ description: message, source }),
    });
    return `Suggestion added to ${subtaskId ? `subtask ${subtaskId}` : `ticket ${id}`}.`;
  },
});

export const resolveSuggestion = tool({
  description: "Resolves a suggestion.",
  args: {
    id: tool.schema.string().describe("Ticket ID"),
    suggestionId: tool.schema.string().describe("Suggestion ID"),
    subtaskId: tool.schema.string().optional().describe("Subtask ID"),
  },
  async execute({ id, suggestionId, subtaskId }) {
    await fetchApiWithRetry(`/suggestions/${suggestionId}/resolve`, {
      method: "PATCH",
    });
    return `Suggestion ${suggestionId} resolved.`;
  },
});

export const addDeviation = tool({
  description: "Records a plan deviation.",
  args: {
    id: tool.schema.string().describe("Ticket ID"),
    planItem: tool.schema.string().min(5).max(250).describe("Plan item"),
    action: tool.schema.string().describe("omitted or replaced"),
    reason: tool.schema.string().min(10).max(500).describe("Reason"),
    replacement: tool.schema
      .string()
      .optional()
      .describe("What was done instead"),
  },
  async execute({ id, planItem, action, reason, replacement }) {
    await fetchApiWithRetry(`/tickets/${id}/deviations`, {
      method: "POST",
      body: JSON.stringify({
        action,
        description: `Plan item: ${planItem}. ${reason}. ${replacement ? `Replaced with: ${replacement}` : ""}`,
      }),
    });
    return `Deviation recorded for ${id}.`;
  },
});

export const reviewDeviation = tool({
  description: "Reviews a deviation.",
  args: {
    id: tool.schema.string().describe("Ticket ID"),
    deviationId: tool.schema.string().describe("Deviation ID"),
    accepted: tool.schema.boolean().describe("Accepted"),
    comment: tool.schema.string().optional().describe("Comment"),
  },
  async execute({ id, deviationId, accepted, comment }) {
    await fetchApiWithRetry(`/deviations/${deviationId}/review`, {
      method: "PATCH",
      body: JSON.stringify({ approved: accepted }),
    });
    return `Deviation ${deviationId} ${accepted ? "accepted" : "rejected"}.`;
  },
});

export const qaDeviation = tool({
  description: "QA validates a deviation.",
  args: {
    id: tool.schema.string().describe("Ticket ID"),
    deviationId: tool.schema.string().describe("Deviation ID"),
    validated: tool.schema.boolean().describe("Validated"),
    comment: tool.schema.string().optional().describe("Comment"),
  },
  async execute({ id, deviationId, validated, comment }) {
    await fetchApiWithRetry(`/deviations/${deviationId}/qa`, {
      method: "PATCH",
      body: JSON.stringify({ approved: validated }),
    });
    return `Deviation ${deviationId} ${validated ? "validated" : "flagged"}.`;
  },
});

export const addEvidence = tool({
  description: "Adds evidence from a file.",
  args: {
    id: tool.schema.string().describe("Ticket ID"),
    description: tool.schema
      .string()
      .min(3)
      .max(500)
      .describe("Evidence description"),
    type: tool.schema
      .string()
      .describe(
        "Type: screenshot, api_response, build_output, test_output, migration_output, log_evidence, security_scan",
      ),
    source: tool.schema
      .string()
      .describe("Source: implementation, review, qa, security, pr_maintenance"),
    existingFilePath: tool.schema.string().describe("Absolute path to file"),
    subtaskId: tool.schema.string().optional().describe("Subtask ID"),
  },
  async execute({
    id,
    description,
    type,
    source,
    existingFilePath,
    subtaskId,
  }) {
    const ticketId = subtaskId || id;
    const data = await fetchApiWithRetry(`/tickets/${ticketId}/evidence`, {
      method: "POST",
      body: JSON.stringify({
        ticketId,
        description,
        type,
        source,
        filePath: existingFilePath,
      }),
    });
    return `Evidence added with ID ${data.id}.`;
  },
});

export const removeEvidence = tool({
  description: "Removes evidence.",
  args: {
    id: tool.schema.string().describe("Ticket ID"),
    evidenceId: tool.schema.string().describe("Evidence ID"),
    subtaskId: tool.schema.string().optional().describe("Subtask ID"),
  },
  async execute({ id, evidenceId, subtaskId }) {
    await fetchApiWithRetry(`/evidence/${evidenceId}`, { method: "DELETE" });
    return `Evidence ${evidenceId} removed.`;
  },
});

export const getEvidence = tool({
  description: "Gets evidence for a ticket.",
  args: {
    id: tool.schema.string().describe("Ticket ID"),
    subtaskId: tool.schema.string().optional().describe("Subtask ID"),
    evidenceId: tool.schema
      .string()
      .optional()
      .describe("Specific evidence ID"),
    source: tool.schema
      .string()
      .optional()
      .describe("Filter by source: validation, implementation, review, qa, security, pr_maintenance"),
    passed: tool.schema
      .boolean()
      .optional()
      .describe("Filter by pass/fail (only for validation source)"),
    maxChars: tool.schema.number().optional().describe("Max chars to read"),
  },
  async execute({ id, subtaskId, evidenceId, source, passed, maxChars }) {
    const ticketId = subtaskId || id;
    if (evidenceId) {
      return fetchApiWithRetry(`/evidence/${evidenceId}`);
    }
    const params = new URLSearchParams();
    if (source) params.set('source', source);
    if (passed !== undefined) params.set('passed', String(passed));
    if (maxChars) params.set('maxChars', String(maxChars));
    const query = params.toString();
    return fetchApiWithRetry(`/tickets/${ticketId}/evidence${query ? `?${query}` : ''}`);
  },
});

