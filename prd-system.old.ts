import { tool } from "@opencode-ai/plugin";
import * as fs from "fs";
import * as path from "path";
import crypto from "crypto";

type Suggestion = {
  suggestionId: string;
  message: string;
  source: "planning" | "implementation" | "review" | "qa" | "security";
  createdAt: string;
  resolvedAt?: string;
};

type Deviation = {
  deviationId: string;
  planItem: string;
  action: "omitted" | "replaced";
  replacement?: string;
  reason: string;
  createdAt: string;
  reviewResult?: { accepted: boolean; comment?: string };
  qaResult?: { validated: boolean; comment?: string };
};

type Evidence = {
  evidenceId: string;
  description: string;
  type: "screenshot" | "api_response" | "build_output" | "test_output" | "migration_output" | "log_evidence" | "security_scan";
  source: "implementation" | "review" | "qa" | "security" | "pr_maintenance";
  filePath: string;
  contentType: string;
  createdAt: string;
};

type Prd = Ticket & {
  gitRepo: string;
  jiraTicket?: string;
  subtasks?: Ticket[];
  planIteration: number;
  subtasksNeedPrs?: boolean;
};

type Ticket = {
  id: string;
  name: string;
  description?: string;
  status: string;
  priority?: "P0" | "P1" | "P2" | "P3";
  acceptanceCriterias?: string[];
  estimation?: string;
  techNotes?: string[];
  dependencys?: string[];
  plan?: string;
  suggestions?: Suggestion[];
  deviations?: Deviation[];
  planIssues?: string[];
  blockingIssues?: string[];
  targetBranch: string;
  featureBranch: string;
  worktreeDir: string;
  branch?: string;
  reviewComments?: string[];
  securityNotes?: string[];
  qaNotes?: string[];
  prUrl?: string;
  merged?: boolean;
  rejectionNotes?: string;
  prCiResults?: string[];
  prCommentsValidated?: boolean;
  blockedReason?: string;
  previousStatus?: string;
  evidence?: Evidence[];
  planIteration?: number;
  implementationRetryCount?: number;
};

const EXT_MAP: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "text/plain": ".txt",
  "application/json": ".json",
  "text/html": ".html",
  "text/markdown": ".md",
};

function extForContentType(contentType: string): string {
  return EXT_MAP[contentType] || ".bin";
}

function assertPathWithinPrds(resolved: string): void {
  const prds = path.resolve(getPrdsFolder());
  const target = path.resolve(resolved);
  if (!target.startsWith(prds + path.sep) && target !== prds) {
    throw new Error(`Path traversal denied: ${target} is outside ${prds}`);
  }
}

function validateTicketId(id: string): void {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
    throw new Error(
      `Invalid ticket ID: "${id}". Must contain only alphanumeric characters, hyphens, and underscores.`,
    );
  }
}

function validateGitRepo(gitRepo: string): void {
  if (!/^[a-zA-Z0-9_-]+$/.test(gitRepo)) {
    throw new Error(
      `Invalid git repo: "${gitRepo}". Must contain only alphanumeric characters, hyphens, and underscores.`,
    );
  }
}

function hasSubtasks(prd: Prd): boolean {
  return !!prd.subtasks && prd.subtasks.length > 0;
}

function getPrdsFolder(): string {
  // ralph.js at the same project level uses path.join(__dirname, "prds") successfully
  // This tool lives in the tools/ subdirectory, so we go up one level to reach prds/
  return path.resolve(__dirname, "..", "prds");
}

function getPrd(id: string, gitRepo: string): Prd | null {
  validateTicketId(id);
  validateGitRepo(gitRepo);
  const prdsFolder = getPrdsFolder();
  const prdPath = path.join(prdsFolder, `${gitRepo}__${id}.json`);
  if (!fs.existsSync(prdPath)) {
    return null;
  }
  const prdData = fs.readFileSync(prdPath, "utf-8");
  return JSON.parse(prdData);
}

function updatePrd(prd: Prd, gitRepo: string): void {
  validateTicketId(prd.id);
  validateGitRepo(gitRepo);
  const prdsFolder = getPrdsFolder();
  const prdPath = path.join(prdsFolder, `${gitRepo}__${prd.id}.json`);
  fs.writeFileSync(prdPath, JSON.stringify(prd, null, 2), "utf-8");
}

const PRD_AGENT_COUNTS = {
  alignment: 3,
  research: 3,
  review: 5,
  validation: 3,
  qa: 3,
};

export const getConfig = tool({
  description:
    "Returns the PRD system agent count configuration. Call this once at the start of a skill session to get configured minimum agent counts. Each config key corresponds to a step type: alignment (consensus checks), research (codebase exploration), review (detailed plan/review), validation (verifying issues/fixes), qa (quality assurance). Keys used in skill files are wrapped in backticks, e.g. `alignment`.",
  args: {},
  async execute() {
    return JSON.stringify(PRD_AGENT_COUNTS, null, 2);
  },
});

export const create = tool({
  description:
    "Creates a Product Requirement Document (PRDs) in the system with their descriptions.",
  args: {
    gitRepo: tool.schema
      .string()
      .describe(
        "The name of the Git repository to filter PRDs by. If not provided, lists all PRDs.",
      ),
    name: tool.schema.string().min(25).max(250).describe("Name of the ticket"),
    jiraTicket: tool.schema
      .string()
      .min(2)
      .max(20)
      .optional()
      .describe("Name of the JIRA ticket - if provided"),
    description: tool.schema
      .string()
      .min(25)
      .max(2000)
      .describe("Description of the ticket"),
    id: tool.schema
      .string()
      .optional()
      .describe("Id of the ticket - if you have one"),
    targetBranch: tool.schema
      .string()
      .min(1)
      .max(100)
      .describe("Target branch for the PR (where code will be merged into)"),
    priority: tool.schema
      .string()
      .optional()
      .describe("Priority: P0, P1, P2, or P3 (defaults to P2)"),
  },
  async execute({ gitRepo, name, description, id, targetBranch, priority, jiraTicket }) {
    const existingPrd = id ? getPrd(id, gitRepo) : null;
    if (existingPrd) {
      return `Ticket with ID ${id} already exists. Please use a different ID or omit the ID to generate a new one.`;
    }

    const ticketId = id || crypto.randomUUID();

    const prdData = {
      id: ticketId,
      gitRepo,
      name,
      description,
      status: "Needs Refinement",
      priority: priority || "P2",
      createdAt: new Date().toISOString(),
      jiraTicket,
      planIteration: 0,
      targetBranch,
      featureBranch: "",
      worktreeDir: "",
      evidence: [],
    };

    updatePrd(prdData, gitRepo);

    return `Ticket created with ID - ${ticketId}`;
  },
});

export const getTicket = tool({
  description: "Gets a ticket by its ID.",
  args: {
    id: tool.schema.string().describe("Id of the ticket"),
    gitRepo: tool.schema
      .string()
      .describe(
        "The name of the Git repository to filter PRDs by. If not provided, lists all PRDs.",
      ),
  },
  async execute({ id, gitRepo }) {
    const prdData = getPrd(id, gitRepo);
    if (!prdData) {
      return `Ticket with ID ${id} not found.`;
    }
    return JSON.stringify(prdData, null, 2);
  },
});

export const escalate = tool({
  description: "Escalates a ticket for human intervention.",
  args: {
    id: tool.schema.string().describe("Id of the ticket"),
    gitRepo: tool.schema
      .string()
      .describe(
        "The name of the Git repository to filter PRDs by. If not provided, lists all PRDs.",
      ),
    subtaskId: tool.schema
      .string()
      .optional()
      .describe("Id of the subtask to escalate"),
  },
  async execute({ id, gitRepo, subtaskId }) {
    const prd = getPrd(id, gitRepo);

    if (!prd) {
      return `Ticket with ID ${id} not found.`;
    }

    const ticket = subtaskId
      ? prd.subtasks?.find((subtask: any) => subtask.id === subtaskId)
      : prd;
    if (!ticket) {
      return subtaskId
        ? `Subtask with ID ${subtaskId} not found in ticket with ID ${id}.`
        : `Ticket with ID ${id} not found.`;
    }

    const status = ticket.status;
    const terminalStatuses = ["Done", "Cancelled"];
    if (terminalStatuses.includes(status)) {
      const label = subtaskId ? `Subtask ${subtaskId}` : `Ticket ${id}`;
      return `${label} is in a terminal state (${status}) and cannot be escalated.`;
    }

    if (status === "Needs Human Clarification") {
      const label = subtaskId ? `Subtask ${subtaskId}` : `Ticket ${id}`;
      return `${label} is already escalated for human clarification.`;
    } else if (status === "Needs Refinement") {
      ticket.status = "Needs Human Clarification";
    } else if (status === "Needs Plan" || status === "Needs Plan Updating") {
      ticket.status = "Needs Human Clarification";
    } else if (status === "Ready Plan Review") {
      ticket.status = "Needs Human Clarification";
    } else if (status === "Needs Subtickets Processed") {
      ticket.status = "Needs Human Subtickets";
    } else if (status === "Needs Validation") {
      // Automated validation couldn't run or was bypassed — route to human for manual review and decision
      ticket.status = "Needs Human Implementation";
    } else if (status === "Needs Implementing" || status === "Needs Implementation Update") {
      ticket.status = "Needs Human Clarification";
    } else if (status === "Needs Review") {
      ticket.status = "Needs Human Clarification";
    } else if (status === "Needs Security Review") {
      ticket.status = "Needs Human Clarification";
    } else if (status === "Needs QA") {
      ticket.status = "Needs Human Clarification";
    } else if (status === "Needs PR") {
      ticket.status = "Needs Human PR";
    } else if (status === "Needs PR Maintenance") {
      ticket.status = "Needs Human PR Maintenance";
    } else if (status === "Awaiting Human Merge") {
      ticket.status = "Needs Human Merge Clarification";
    } else if (status === "Needs Git Merge") {
      ticket.status = "Needs Human Git Merge";
    } else if (status === "Needs Reapproach") {
      ticket.status = "Needs Human Reapproach";
    } else if (status === "Blocked") {
      ticket.status = "Needs Human Unblock";
    } else if (status === "Needs Finalizing") {
      ticket.status = "Needs Human Clarification";
    } else if (status === "Needs Cleanup") {
      ticket.status = "Needs Human Cleanup";
    } else {
      ticket.status = "Needs Human Clarification";
    }

    updatePrd(prd, gitRepo);

    const label = subtaskId ? `Subtask ${subtaskId}` : `Ticket ${id}`;
    return `${label} escalated to ${ticket.status}.`;
  },
});

export const submitPR = tool({
  description:
    "Submits a PR for a ticket and transitions it from Needs PR to Needs PR Maintenance. Resets prCiResults, prCommentsValidated, and rejectionNotes for a clean maintenance cycle. Used by the prd-pr-creation skill after creating the pull request.",
  args: {
    id: tool.schema.string().describe("Id of the ticket"),
    gitRepo: tool.schema.string().describe("The Git repository name"),
    subtaskId: tool.schema
      .string()
      .optional()
      .describe("Id of the subtask the PR is for"),
    prUrl: tool.schema
      .string()
      .optional()
      .describe("URL of the pull request — optional if already on the ticket"),
  },
  async execute({ id, gitRepo, prUrl, subtaskId }) {
    const prd = getPrd(id, gitRepo);
    if (!prd) {
      return `Ticket with ID ${id} not found.`;
    }

    const ticket = subtaskId
      ? prd.subtasks?.find((subtask: any) => subtask.id === subtaskId)
      : prd;
    if (!ticket) {
      return subtaskId
        ? `Subtask with ID ${subtaskId} not found in ticket with ID ${id}.`
        : `Ticket with ID ${id} not found.`;
    }

    if (ticket.status !== "Needs PR") {
      const label = subtaskId ? `Subtask ${subtaskId}` : `Ticket ${id}`;
      return `${label} is not in a state that allows PR submission. Current status: ${ticket.status}.`;
    }

    if (!prUrl && !ticket.prUrl) {
      return "No PR URL provided and no PR URL found on the ticket. Provide a prUrl or ensure the ticket already has one.";
    }

    if (prUrl) {
      ticket.prUrl = prUrl;
    }
    ticket.prCiResults = undefined;
    ticket.prCommentsValidated = undefined;
    ticket.rejectionNotes = undefined;
    ticket.status = "Needs PR Maintenance";

    updatePrd(prd, gitRepo);

    const label = subtaskId ? `Subtask ${subtaskId}` : `Ticket ${id}`;
    return `${label} PR submitted and marked as Needs PR Maintenance.`;
  },
});

export const flagPrRework = tool({
  description:
    "Flags a ticket in Needs PR Maintenance for rework. Routes to Needs Implementation Update (code changes) or Needs Reapproach (wrong approach).",
  args: {
    id: tool.schema.string().describe("Id of the ticket"),
    gitRepo: tool.schema.string().describe("The Git repository name"),
    subtaskId: tool.schema
      .string()
      .optional()
      .describe("Id of the subtask to flag for rework"),
    rejectionType: tool.schema
      .string()
      .optional()
      .describe(
        "'implementation' (default, code-level fixes) or 'approach' (replanning needed)",
      ),
    rejectionNotes: tool.schema
      .string()
      .describe("Why the PR needs rework — required"),
  },
  async execute({ id, gitRepo, rejectionType, rejectionNotes, subtaskId }) {
    const prd = getPrd(id, gitRepo);
    if (!prd) {
      return `Ticket with ID ${id} not found.`;
    }

    const ticket = subtaskId
      ? prd.subtasks?.find((subtask: any) => subtask.id === subtaskId)
      : prd;
    if (!ticket) {
      return subtaskId
        ? `Subtask with ID ${subtaskId} not found in ticket with ID ${id}.`
        : `Ticket with ID ${id} not found.`;
    }

    if (ticket.status !== "Needs PR Maintenance") {
      const label = subtaskId ? `Subtask ${subtaskId}` : `Ticket ${id}`;
      return `${label} is not in a state that allows flagging rework. Current status: ${ticket.status}.`;
    }

    if (rejectionType !== undefined && !["implementation", "approach"].includes(rejectionType)) {
      return `Invalid rejectionType: "${rejectionType}". Must be "implementation" or "approach".`;
    }
    const type = rejectionType || "implementation";

    if (!rejectionNotes || rejectionNotes.trim() === "") {
      return "Rejection notes are required.";
    }

    ticket.rejectionNotes = rejectionNotes;
    ticket.status = type === "approach" ? "Needs Reapproach" : "Needs Implementation Update";

    updatePrd(prd, gitRepo);

    const label = subtaskId ? `Subtask ${subtaskId}` : `Ticket ${id}`;
    return `${label} flagged for rework and marked as ${ticket.status}.`;
  },
});

export const requestHumanMerge = tool({
  description:
    "Marks a ticket in Needs PR Maintenance as ready for human merge. Stores CI results, sets prCommentsValidated=true, transitions to Awaiting Human Merge. After the human merges the PR, they use an external tool to return the ticket to Needs PR Maintenance, where the maintenance skill will detect the merge and call completePR.",
  args: {
    id: tool.schema.string().describe("Id of the ticket"),
    gitRepo: tool.schema.string().describe("The Git repository name"),
    subtaskId: tool.schema
      .string()
      .optional()
      .describe("Id of the subtask requesting merge"),
    ciResults: tool.schema
      .array(tool.schema.string())
      .describe("CI check results (names/statuses to store as evidence)"),
  },
  async execute({ id, gitRepo, ciResults, subtaskId }) {
    const prd = getPrd(id, gitRepo);
    if (!prd) {
      return `Ticket with ID ${id} not found.`;
    }

    const ticket = subtaskId
      ? prd.subtasks?.find((subtask: any) => subtask.id === subtaskId)
      : prd;
    if (!ticket) {
      return subtaskId
        ? `Subtask with ID ${subtaskId} not found in ticket with ID ${id}.`
        : `Ticket with ID ${id} not found.`;
    }

    if (ticket.status !== "Needs PR Maintenance") {
      const label = subtaskId ? `Subtask ${subtaskId}` : `Ticket ${id}`;
      return `${label} is not in a state that allows requesting human merge. Current status: ${ticket.status}.`;
    }

    ticket.prCiResults = ciResults;
    ticket.prCommentsValidated = true;
    ticket.status = "Awaiting Human Merge";

    updatePrd(prd, gitRepo);

    const label = subtaskId ? `Subtask ${subtaskId}` : `Ticket ${id}`;
    return `${label} PR passed all checks. Awaiting human merge.`;
  },
});

export const completeGitMerge = tool({
  description:
    "Completes a direct git merge for a subtask only (no PR needed). Requires both id (parent) and subtaskId — this tool only operates on subtasks. Transitions from Needs Git Merge to Needs Finalizing.",
  args: {
    id: tool.schema.string().describe("Id of the parent ticket (required — this tool only operates on subtasks)"),
    gitRepo: tool.schema.string().describe("The Git repository name"),
    subtaskId: tool.schema
      .string()
      .describe("Id of the subtask that was merged (required — this tool only operates on subtasks)"),
  },
  async execute({ id, gitRepo, subtaskId }) {
    const prd = getPrd(id, gitRepo);
    if (!prd) {
      return `Parent ticket with ID ${id} not found.`;
    }

    const terminalStatuses = ["Done", "Cancelled"];
    if (terminalStatuses.includes(prd.status)) {
      return `Parent ticket is ${prd.status}. Cannot merge subtask into a completed parent.`;
    }

    const ticket = prd.subtasks?.find((subtask: any) => subtask.id === subtaskId);
    if (!ticket) {
      return `Subtask with ID ${subtaskId} not found in ticket with ID ${id}.`;
    }

    if (ticket.status !== "Needs Git Merge") {
      return `Subtask ${subtaskId} is not in a state that allows completing git merge. Current status: ${ticket.status}.`;
    }

    ticket.merged = true;
    ticket.status = "Needs Finalizing";

    updatePrd(prd, gitRepo);

    return `Subtask ${subtaskId} git merge completed and marked as Needs Finalizing.`;
  },
});

export const updateName = tool({
  description: "Updates the name of a ticket.",
  args: {
    id: tool.schema.string().describe("Id of the ticket"),
    gitRepo: tool.schema
      .string()
      .describe(
        "The name of the Git repository to filter PRDs by. If not provided, lists all PRDs.",
      ),
    name: tool.schema
      .string()
      .min(5)
      .max(250)
      .describe("New name of the ticket"),
  },
  async execute({ id, gitRepo, name }) {
    const prd = getPrd(id, gitRepo);
    if (!prd) {
      return `Ticket with ID ${id} not found.`;
    }

    if (
      prd.status !== "Needs Human Title and Description refinement" &&
      prd.status !== "Needs Refinement"
    ) {
      return `Ticket with ID ${id} is not in a state that allows name updates. Current status: ${prd.status}.`;
    }

    prd.name = name;
    updatePrd(prd, gitRepo);

    return `Name for ticket with ID ${id} updated successfully.`;
  },
});

export const updateDescription = tool({
  description: "Updates the description of a ticket.",
  args: {
    id: tool.schema.string().describe("Id of the ticket"),
    gitRepo: tool.schema
      .string()
      .describe(
        "The name of the Git repository to filter PRDs by. If not provided, lists all PRDs.",
      ),
    description: tool.schema
      .string()
      .min(5)
      .max(2000)
      .describe("New description of the ticket"),
  },
  async execute({ id, gitRepo, description }) {
    const prd = getPrd(id, gitRepo);
    if (!prd) {
      return `Ticket with ID ${id} not found.`;
    }

    if (
      prd.status !== "Needs Human Title and Description refinement" &&
      prd.status !== "Needs Refinement"
    ) {
      return `Ticket with ID ${id} is not in a state that allows description updates. Current status: ${prd.status}.`;
    }

    prd.description = description;

    updatePrd(prd, gitRepo);

    return `Description for ticket with ID ${id} updated successfully.`;
  },
});

export const updatePriority = tool({
  description: "Updates the priority of a ticket.",
  args: {
    id: tool.schema.string().describe("Id of the ticket"),
    gitRepo: tool.schema
      .string()
      .describe(
        "The name of the Git repository to filter PRDs by. If not provided, lists all PRDs.",
      ),
    priority: tool.schema
      .string()
      .describe("Priority: P0, P1, P2, or P3"),
  },
  async execute({ id, gitRepo, priority }) {
    const prd = getPrd(id, gitRepo);
    if (!prd) {
      return `Ticket with ID ${id} not found.`;
    }

    if (!["P0", "P1", "P2", "P3"].includes(priority)) {
      return `Invalid priority: ${priority}. Must be P0, P1, P2, or P3.`;
    }

    const terminalStatuses = ["Done", "Cancelled"];
    if (terminalStatuses.includes(prd.status)) {
      return `Ticket with ID ${id} is in a terminal state (${prd.status}) and cannot be updated.`;
    }

    prd.priority = priority as "P0" | "P1" | "P2" | "P3";
    updatePrd(prd, gitRepo);

    return `Priority for ticket with ID ${id} updated to ${priority}.`;
  },
});

export const createSubtask = tool({
  description: "Creates a subtask for a given ticket.",
  args: {
    id: tool.schema.string().describe("Id of the parent ticket"),
    gitRepo: tool.schema
      .string()
      .describe(
        "The name of the Git repository to filter PRDs by. If not provided, lists all PRDs.",
      ),
    name: tool.schema.string().min(5).max(250).describe("Name of the subtask"),
    description: tool.schema
      .string()
      .min(5)
      .max(2000)
      .describe("Description of the subtask"),
  },
  async execute({ id, gitRepo, name, description }) {
    const prd = getPrd(id, gitRepo);
    if (!prd) {
      return `Parent ticket with ID ${id} not found.`;
    }

    const status = prd.status;
    if (status !== "Needs Refinement") {
      return `Ticket with ID ${id} is not in a state that allows subtask creation. Current status: ${status}.`;
    }

    const subtaskId = crypto.randomUUID();
    const subtask = {
      id: subtaskId,
      name,
      description,
      status: "Needs Refinement",
      createdAt: new Date().toISOString(),
      targetBranch: prd.featureBranch,
      featureBranch: "",
      worktreeDir: "",
      planIteration: 0,
      implementationRetryCount: 0,
    };

    if (!prd.subtasks) {
      prd.subtasks = [];
    }
    prd.subtasks.push(subtask);
    updatePrd(prd, gitRepo);

    return `Subtask created with ID ${subtaskId} for ticket with ID ${id}. Inherited targetBranch="${prd.featureBranch}" from parent's featureBranch.`;
  },
});

export const deleteSubtask = tool({
  description: "Deletes a subtask from a given ticket.",
  args: {
    id: tool.schema.string().describe("Id of the parent ticket"),
    gitRepo: tool.schema
      .string()
      .describe(
        "The name of the Git repository to filter PRDs by. If not provided, lists all PRDs.",
      ),
    subtaskId: tool.schema.string().describe("Id of the subtask to delete"),
  },
  async execute({ id, gitRepo, subtaskId }) {
    const prd = getPrd(id, gitRepo);
    if (!prd) {
      return `Parent ticket with ID ${id} not found.`;
    }

    if (!prd.subtasks) {
      return `No subtasks found for ticket with ID ${id}.`;
    }

    const status = prd.status;
    if (status !== "Needs Refinement") {
      return `Ticket with ID ${id} is not in a state that allows subtask deletion. Current status: ${status}.`;
    }

    const subtaskIndex = prd.subtasks.findIndex(
      (subtask: any) => subtask.id === subtaskId,
    );
    if (subtaskIndex === -1) {
      return `Subtask with ID ${subtaskId} not found in ticket with ID ${id}.`;
    }

    prd.subtasks.splice(subtaskIndex, 1);
    updatePrd(prd, gitRepo);

    return `Subtask with ID ${subtaskId} deleted from ticket with ID ${id}.`;
  },
});

export const assignWorkspace = tool({
  description:
    "Assigns a feature branch and worktree directory to a ticket or subtask. Used during planning to determine where implementation work will happen.",
  args: {
    id: tool.schema.string().describe("Id of the ticket"),
    gitRepo: tool.schema.string().describe("The Git repository name"),
    subtaskId: tool.schema
      .string()
      .optional()
      .describe("Id of the subtask to assign workspace for"),
    featureBranch: tool.schema
      .string()
      .min(1)
      .max(250)
      .describe("Name of the feature branch to create"),
    worktreeDir: tool.schema
      .string()
      .min(1)
      .max(500)
      .regex(/^[a-zA-Z0-9_\/\\\.-]+$/, "Must contain only alphanumeric, underscore, hyphen, dot, forward-slash and backslash characters")
      .describe("Path to the git worktree directory"),
  },
  async execute({ id, gitRepo, subtaskId, featureBranch, worktreeDir }) {
    const prd = getPrd(id, gitRepo);
    if (!prd) {
      return `Ticket with ID ${id} not found.`;
    }

    const ticket = subtaskId
      ? prd.subtasks?.find((subtask: any) => subtask.id === subtaskId)
      : prd;
    if (!ticket) {
      return subtaskId
        ? `Subtask with ID ${subtaskId} not found in ticket with ID ${id}.`
        : `Ticket with ID ${id} not found.`;
    }

    if (ticket.status !== "Needs Plan" && ticket.status !== "Needs Plan Updating") {
      return `Ticket with ID ${id} is not in a state that allows workspace assignment. Current status: ${ticket.status}.`;
    }

    ticket.featureBranch = featureBranch;
    ticket.worktreeDir = worktreeDir;
    if (subtaskId) {
      if (!prd.featureBranch) {
        return `Cannot assign workspace for subtask: parent ticket ${id} has no featureBranch yet. Assign parent workspace first.`;
      }
      ticket.targetBranch = prd.featureBranch;
    }
    updatePrd(prd, gitRepo);

    const target = subtaskId ? `subtask ${subtaskId}` : `ticket ${id}`;
    return `Workspace assigned for ${target}: featureBranch="${featureBranch}", worktreeDir="${worktreeDir}".`;
  },
});

export const refineTicket = tool({
  description:
    "Refines a ticket by updating its required fields (replaces existing so all fields must be provided).",
  args: {
    id: tool.schema.string().describe("Id of the ticket to refine"),
    subtaskId: tool.schema
      .string()
      .optional()
      .describe("Id of the subtask to refine - if refining a subtask"),
    gitRepo: tool.schema
      .string()
      .describe(
        "The name of the Git repository to filter PRDs by. If not provided, lists all PRDs.",
      ),
    acceptanceCriterias: tool.schema
      .array(tool.schema.string())
      .min(1)
      .describe("List of acceptance criterias for the ticket"),
    estimation: tool.schema.string().describe("Estimation for the ticket"),
    dependencys: tool.schema
      .array(tool.schema.string())
      .describe("List of dependencies for the ticket - if any"),
    techNotes: tool.schema
      .array(tool.schema.string())
      .describe("Technical notes for the ticket - if any"),
  },
  async execute({
    id,
    gitRepo,
    acceptanceCriterias,
    estimation,
    techNotes,
    dependencys,
    subtaskId,
  }) {
    const prd = getPrd(id, gitRepo);
    if (!prd) {
      return `Ticket with ID ${id} not found.`;
    }

    const ticket = subtaskId
      ? prd.subtasks?.find((subtask: any) => subtask.id === subtaskId)
      : prd;
    if (!ticket) {
      return subtaskId
        ? `Subtask with ID ${subtaskId} not found in ticket with ID ${id}.`
        : `Ticket with ID ${id} not found.`;
    }

    if (ticket.status !== "Needs Refinement") {
      const label = subtaskId ? `Subtask ${subtaskId}` : `Ticket ${id}`;
      return `${label} is not in a state that allows refinement. Current status: ${ticket.status}.`;
    }

    const acCount = acceptanceCriterias.length;
    if (acCount < 3 || acCount > 5) {
      return `Tickets should have 3–5 acceptance criteria. Got ${acCount}. Please split or consolidate.`;
    }

    const implPattern = /\.(tsx?|jsx?|vue|svelte)$|(function|import |ALTER TABLE|CREATE TABLE|INSERT INTO|SELECT .* FROM|node_modules|extends |implements |interface |type )/i;
    const flagged = acceptanceCriterias.filter(ac => implPattern.test(ac));
    if (flagged.length > 0) {
      return `The following acceptance criteria contain implementation details (file paths, function names, SQL). Move these to techNotes:\n${flagged.map(f => `  - ${f}`).join("\n")}`;
    }

    ticket.acceptanceCriterias = acceptanceCriterias;
    ticket.estimation = estimation;
    ticket.techNotes = techNotes;
    ticket.dependencys = dependencys;

    updatePrd(prd, gitRepo);

    return `Ticket with ID ${id} refined successfully -- ${JSON.stringify(prd)}`;
  },
});

export const finalizeRefinement = tool({
  description: "Finalizes the refinement of a ticket, marking it as ready.",
  args: {
    id: tool.schema.string().describe("Id of the ticket to finalize"),
    gitRepo: tool.schema
      .string()
      .describe(
        "The name of the Git repository to filter PRDs by. If not provided, lists all PRDs.",
      ),
  },
  async execute({ id, gitRepo }) {
    const prd = getPrd(id, gitRepo);
    if (!prd) {
      return `Ticket with ID ${id} not found.`;
    }

    if (prd.status !== "Needs Refinement") {
      return `Ticket with ID ${id} is not in a state that allows finalizing refinement. Current status: ${prd.status}.`;
    }

    // Check if all required fields are filled
    if (
      !prd.acceptanceCriterias ||
      prd.acceptanceCriterias.length === 0 ||
      !prd.estimation
    ) {
      return `Ticket with ID ${id} cannot be finalized. Please ensure all required fields (acceptance criterias and estimation) are filled.`;
    }

    const parentCount = prd.acceptanceCriterias.length;
    if (parentCount < 3 || parentCount > 5) {
      return `Ticket with ID ${id} has ${parentCount} acceptance criteria. Must have 3–5. Please refine before finalizing.`;
    }

    prd.status = "Needs Plan";
    for (const subtask of prd.subtasks || []) {
      if (
        !subtask.acceptanceCriterias ||
        subtask.acceptanceCriterias.length === 0 ||
        !subtask.estimation
      ) {
        return `Subtask with ID ${subtask.id} cannot be finalized. Please ensure all required fields (acceptance criterias and estimation) are filled for all subtasks.`;
      }
      const subCount = subtask.acceptanceCriterias.length;
      if (subCount < 3 || subCount > 5) {
        return `Subtask with ID ${subtask.id} has ${subCount} acceptance criteria. Must have 3–5. Please refine before finalizing.`;
      }
      subtask.status = "Needs Plan";
    }
    updatePrd(prd, gitRepo);

    return `Ticket with ID ${id} finalized and marked as Ready.`;
  },
});

export const savePlan = tool({
  description:
    "Saves an implementation plan for a ticket or subtask. The plan is free-form markdown describing the implementation approach, ordered steps, files to change, and testing strategy. Can also be used to update an existing plan when a ticket is in 'Needs Plan Updating' status.",
  args: {
    id: tool.schema.string().describe("Id of the ticket"),
    gitRepo: tool.schema
      .string()
      .describe(
        "The name of the Git repository to filter PRDs by. If not provided, lists all PRDs.",
      ),
    subtaskId: tool.schema
      .string()
      .optional()
      .describe(
        "Id of the subtask to save the plan for - if saving for a subtask",
      ),
    plan: tool.schema
      .string()
      .min(10)
      .describe("Free-form markdown implementation plan"),
  },
  async execute({ id, gitRepo, plan, subtaskId }) {
    const prd = getPrd(id, gitRepo);
    if (!prd) {
      return `Ticket with ID ${id} not found.`;
    }

    const ticket = subtaskId
      ? prd.subtasks?.find((subtask: any) => subtask.id === subtaskId)
      : prd;
    if (!ticket) {
      return subtaskId
        ? `Subtask with ID ${subtaskId} not found in ticket with ID ${id}.`
        : `Ticket with ID ${id} not found.`;
    }

    if (ticket.status !== "Needs Plan" && ticket.status !== "Needs Plan Updating") {
      return `Ticket with ID ${id} is not in a state that allows saving a plan. Current status: ${ticket.status}.`;
    }

    ticket.plan = plan;
    ticket.planIssues = [];
    ticket.blockingIssues = [];
    updatePrd(prd, gitRepo);

    const target = subtaskId ? `subtask ${subtaskId}` : `ticket ${id}`;
    return `Plan saved for ${target}.`;
  },
});

export const finalizePlanning = tool({
  description:
    "Finalizes the planning of a ticket, marking it as ready for plan review. Validates that the ticket and all subtasks have a plan before transitioning status. Can also be used to finalize an updated plan when a ticket is in 'Needs Plan Updating' status.",
  args: {
    id: tool.schema.string().describe("Id of the ticket to finalize"),
    gitRepo: tool.schema
      .string()
      .describe(
        "The name of the Git repository to filter PRDs by. If not provided, lists all PRDs.",
      ),
    subtaskId: tool.schema
      .string()
      .optional()
      .describe("Id of the subtask to finalize — if finalizing a single subtask"),
  },
  async execute({ id, gitRepo, subtaskId }) {
    const prd = getPrd(id, gitRepo);
    if (!prd) {
      return `Ticket with ID ${id} not found.`;
    }

    const ticket = subtaskId
      ? prd.subtasks?.find((subtask: any) => subtask.id === subtaskId)
      : prd;
    if (!ticket) {
      return subtaskId
        ? `Subtask with ID ${subtaskId} not found in ticket with ID ${id}.`
        : `Ticket with ID ${id} not found.`;
    }

    if (ticket.status !== "Needs Plan" && ticket.status !== "Needs Plan Updating") {
      return `${subtaskId ? `Subtask ${subtaskId}` : `Ticket ${id}`} is not in a state that allows finalizing planning. Current status: ${ticket.status}.`;
    }

    if (subtaskId) {
      if (!ticket.plan) {
        return `Subtask ${subtaskId} cannot be finalized. Please ensure a plan is saved before finalizing.`;
      }
      if (!ticket.featureBranch || !ticket.worktreeDir) {
        return `Subtask ${subtaskId} cannot be finalized. Please assign a feature branch and worktree dir via assignWorkspace before finalizing.`;
      }
      if (!ticket.targetBranch) {
        return `Subtask ${subtaskId} cannot be finalized. Target branch not set — assignWorkspace on the subtask should set it to the parent's featureBranch.`;
      }
      if (ticket.targetBranch !== prd.featureBranch) {
        return `Subtask ${subtaskId} targetBranch="${ticket.targetBranch}" does not match parent's featureBranch="${prd.featureBranch}". Re-run assignWorkspace on the subtask to fix.`;
      }
      ticket.status = "Ready Plan Review";
      ticket.planIteration = (ticket.planIteration || 0) + 1;
    } else {
      if (!prd.plan) {
        return `Ticket with ID ${id} cannot be finalized. Please ensure the plan is saved before finalizing.`;
      }
      if (!prd.targetBranch) {
        return `Ticket with ID ${id} cannot be finalized. No target branch set.`;
      }
      if (!prd.featureBranch || !prd.worktreeDir) {
        return `Ticket with ID ${id} cannot be finalized. Please assign a feature branch and worktree dir via assignWorkspace before finalizing.`;
      }
      for (const subtask of prd.subtasks || []) {
        if (!subtask.plan) {
          return `Subtask with ID ${subtask.id} cannot be finalized. Please ensure a plan is saved for all subtasks.`;
        }
        if (!subtask.featureBranch || !subtask.worktreeDir) {
          return `Subtask with ID ${subtask.id} cannot be finalized. Please assign a feature branch and worktree dir via assignWorkspace before finalizing.`;
        }
        if (!subtask.targetBranch) {
          return `Subtask with ID ${subtask.id} cannot be finalized. Target branch not set — assignWorkspace on the subtask should set it to the parent's featureBranch.`;
        }
        if (subtask.targetBranch !== prd.featureBranch) {
          return `Subtask with ID ${subtask.id} targetBranch="${subtask.targetBranch}" does not match parent's featureBranch="${prd.featureBranch}". Re-run assignWorkspace on the subtask to fix.`;
        }
        subtask.status = "Ready Plan Review";
      }
      prd.status = "Ready Plan Review";
      prd.planIteration++;
    }

    updatePrd(prd, gitRepo);

    return `${subtaskId ? `Subtask ${subtaskId}` : `Ticket ${id}`} finalized and marked as Ready Plan Review.`;
  },
});

export const addPlanIssues = tool({
  description:
    "Records validated issues found during plan review on a ticket or subtask. Accepts both non-blocking issues and blocking issues. Used by finishPlanReview to determine the next status.",
  args: {
    id: tool.schema.string().describe("Id of the ticket"),
    gitRepo: tool.schema
      .string()
      .describe(
        "The name of the Git repository to filter PRDs by. If not provided, lists all PRDs.",
      ),
    subtaskId: tool.schema
      .string()
      .optional()
      .describe("Id of the subtask to record issues for"),
    issues: tool.schema
      .array(tool.schema.string())
      .describe(
        "List of validated non-blocking issues found during plan review — can be empty",
      ),
    blockingIssues: tool.schema
      .array(tool.schema.string())
      .describe(
        "List of validated blocking issues found during plan review — can be empty",
      ),
  },
  async execute({ id, gitRepo, issues, blockingIssues, subtaskId }) {
    const prd = getPrd(id, gitRepo);
    if (!prd) {
      return `Ticket with ID ${id} not found.`;
    }

    const ticket = subtaskId
      ? prd.subtasks?.find((subtask: any) => subtask.id === subtaskId)
      : prd;
    if (!ticket) {
      return subtaskId
        ? `Subtask with ID ${subtaskId} not found in ticket with ID ${id}.`
        : `Ticket with ID ${id} not found.`;
    }

    if (ticket.status !== "Ready Plan Review") {
      const label = subtaskId ? `Subtask ${subtaskId}` : `Ticket ${id}`;
      return `${label} is not in a state that allows adding plan issues. Current status: ${ticket.status}.`;
    }

    ticket.planIssues = issues;
    ticket.blockingIssues = blockingIssues;
    updatePrd(prd, gitRepo);

    const target = subtaskId ? `subtask ${subtaskId}` : `ticket ${id}`;
    return `Plan issues recorded for ${target} (${issues.length} non-blocking, ${blockingIssues.length} blocking).`;
  },
});

export const finishPlanReview = tool({
  description:
    "Finalizes the plan review of a ticket or subtask. Decision logic: blockingIssues + planIteration > 6 → escalate; blockingIssues exist → Needs Plan Updating; planIteration > 3 → force through; planIssues exist → Needs Plan Updating; otherwise → next status. Subtasks use planIteration 0 (no force-through), and always transition to Needs Implementing on clean pass.",
  args: {
    id: tool.schema.string().describe("Id of the ticket to finalize"),
    gitRepo: tool.schema
      .string()
      .describe(
        "The name of the Git repository to filter PRDs by. If not provided, lists all PRDs.",
      ),
    subtaskId: tool.schema
      .string()
      .optional()
      .describe("Id of the subtask to finalize plan review for"),
  },
  async execute({ id, gitRepo, subtaskId }) {
    const prd = getPrd(id, gitRepo);
    if (!prd) {
      return `Ticket with ID ${id} not found.`;
    }

    const ticket = subtaskId
      ? prd.subtasks?.find((subtask: any) => subtask.id === subtaskId)
      : prd;
    if (!ticket) {
      return subtaskId
        ? `Subtask with ID ${subtaskId} not found in ticket with ID ${id}.`
        : `Ticket with ID ${id} not found.`;
    }

    if (ticket.status !== "Ready Plan Review") {
      const label = subtaskId ? `Subtask ${subtaskId}` : `Ticket ${id}`;
      return `${label} is not in a state that allows finalizing plan review. Current status: ${ticket.status}.`;
    }

    const hasBlockingIssues =
      ticket.blockingIssues && ticket.blockingIssues.length > 0;
    const hasIssues = ticket.planIssues && ticket.planIssues.length > 0;
    const iteration = subtaskId ? (ticket.planIteration || 0) : (prd.planIteration || 0);

    // Blocking issues + max iterations reached → escalate to human
    if (hasBlockingIssues && iteration > 6) {
      ticket.status = "Needs Human Plan Review";
      updatePrd(prd, gitRepo);
      const label = subtaskId ? `Subtask ${subtaskId}` : `Ticket ${id}`;
      return `${label} escalated to Needs Human Plan Review (${ticket.blockingIssues?.length} blocking issues unresolved after ${iteration} iterations).`;
    }

    // Blocking issues exist, still within iteration limit → send back
    if (hasBlockingIssues) {
      ticket.status = "Needs Plan Updating";
      updatePrd(prd, gitRepo);
      const label = subtaskId ? `Subtask ${subtaskId}` : `Ticket ${id}`;
      return `${label} marked as Needs Plan Updating (${ticket.blockingIssues?.length} blocking issues to resolve).`;
    }

    // No blocking issues and past iteration 3 → force through (subtasks never force-through)
    if (!subtaskId && iteration > 3) {
      const targetStatus = subtaskId
        ? "Needs Implementing"
        : hasSubtasks(prd)
          ? "Needs Subtickets Processed"
          : "Needs Implementing";
      ticket.status = targetStatus;
      updatePrd(prd, gitRepo);
      const label = subtaskId ? `Subtask ${subtaskId}` : `Ticket ${id}`;
      return `${label} finalized and marked as ${targetStatus} (planIteration ${iteration} > 3, no blocking issues).`;
    }

    // Non-blocking issues exist, still in early iterations → send back
    if (hasIssues) {
      const issueCount = ticket.planIssues!.length;
      ticket.status = "Needs Plan Updating";
      updatePrd(prd, gitRepo);
      const label = subtaskId ? `Subtask ${subtaskId}` : `Ticket ${id}`;
      return `${label} marked as Needs Plan Updating (${issueCount} non-blocking issues recorded).`;
    }

    // Clean pass
    const targetStatus = subtaskId
      ? "Needs Implementing"
      : hasSubtasks(prd)
        ? "Needs Subtickets Processed"
        : "Needs Implementing";
    ticket.status = targetStatus;
    updatePrd(prd, gitRepo);
    const label = subtaskId ? `Subtask ${subtaskId}` : `Ticket ${id}`;

    return `${label} finalized and marked as ${targetStatus}.`;
  },
});

export const completeImplementation = tool({
  description:
    "Marks implementation as complete, transitioning the ticket to Needs Validation (Ralph runs external validation before it reaches Needs Review). Accepts optional branch name. If subtaskId is provided, marks the subtask as complete.",
  args: {
    id: tool.schema.string().describe("Id of the ticket"),
    gitRepo: tool.schema.string().describe("The Git repository name"),
    subtaskId: tool.schema
      .string()
      .optional()
      .describe("Id of the subtask to mark as complete"),
    branch: tool.schema
      .string()
      .optional()
      .describe("Branch name where the implementation was done"),
  },
  async execute({ id, gitRepo, branch, subtaskId }) {
    const prd = getPrd(id, gitRepo);
    if (!prd) {
      return `Ticket with ID ${id} not found.`;
    }

    const ticket = subtaskId
      ? prd.subtasks?.find((subtask: any) => subtask.id === subtaskId)
      : prd;
    if (!ticket) {
      return `Subtask with ID ${subtaskId} not found in ticket with ID ${id}.`;
    }

    if (
      ticket.status !== "Needs Implementing" &&
      ticket.status !== "Needs Implementation Update"
    ) {
      const label = subtaskId ? `Subtask ${subtaskId}` : `Ticket ${id}`;
      return `${label} is not in a state that allows completing implementation. Current status: ${ticket.status}.`;
    }

    if (branch && branch.trim() === "") {
      return "Branch name must be non-empty if provided.";
    }

    if (branch) {
      ticket.branch = branch;
    }
    ticket.reviewComments = [];
    ticket.securityNotes = [];
    ticket.qaNotes = [];
    ticket.status = "Needs Validation";
    updatePrd(prd, gitRepo);

    const label = subtaskId ? `Subtask ${subtaskId}` : `Ticket ${id}`;
    return `${label} marked as Needs Validation.`;
  },
});

export const reviewImplementation = tool({
  description:
    "Reviews an implemented ticket. If passed, transitions to Needs Security Review. If failed, transitions to Needs Implementation Update with comments.",
  args: {
    id: tool.schema.string().describe("Id of the ticket"),
    gitRepo: tool.schema.string().describe("The Git repository name"),
    subtaskId: tool.schema
      .string()
      .optional()
      .describe("Id of the subtask to review"),
    passed: tool.schema
      .boolean()
      .describe("Whether the implementation passed review"),
    reviewComments: tool.schema
      .array(tool.schema.string())
      .describe("Review comments — required at least 1 if not passed"),
  },
  async execute({ id, gitRepo, passed, reviewComments, subtaskId }) {
    const prd = getPrd(id, gitRepo);
    if (!prd) {
      return `Ticket with ID ${id} not found.`;
    }

    const ticket = subtaskId
      ? prd.subtasks?.find((subtask: any) => subtask.id === subtaskId)
      : prd;
    if (!ticket) {
      return `Subtask with ID ${subtaskId} not found in ticket with ID ${id}.`;
    }

    if (ticket.status !== "Needs Review") {
      const label = subtaskId ? `Subtask ${subtaskId}` : `Ticket ${id}`;
      return `${label} is not in a state that allows review. Current status: ${ticket.status}.`;
    }

    if (!passed && (!reviewComments || reviewComments.length === 0)) {
      return "Review comments are required when the implementation does not pass review.";
    }

    ticket.reviewComments = reviewComments;
    if (passed) {
      ticket.status = "Needs Security Review";
    } else {
      ticket.implementationRetryCount = (ticket.implementationRetryCount || 0) + 1;
      if (ticket.implementationRetryCount > 3) {
        ticket.status = "Needs Human Clarification";
        updatePrd(prd, gitRepo);
        const label = subtaskId ? `Subtask ${subtaskId}` : `Ticket ${id}`;
        return `${label} escalated to Needs Human Clarification (implementation rejected ${ticket.implementationRetryCount} times across review/QA/security).`;
      }
      ticket.status = "Needs Implementation Update";
    }
    updatePrd(prd, gitRepo);

    const outcome = ticket.status;
    const label = subtaskId ? `Subtask ${subtaskId}` : `Ticket ${id}`;
    return `${label} reviewed and marked as ${outcome}.`;
  },
});

export const completeQA = tool({
  description:
    "Completes QA for a ticket. If passed, transitions to Needs PR (for parent tickets or subtasks with subtasksNeedPrs=true) or Needs Git Merge (for subtasks with subtasksNeedPrs=false). If failed, transitions to Needs Implementation Update with QA notes.",
  args: {
    id: tool.schema.string().describe("Id of the ticket"),
    gitRepo: tool.schema.string().describe("The Git repository name"),
    subtaskId: tool.schema
      .string()
      .optional()
      .describe("Id of the subtask to QA"),
    passed: tool.schema.boolean().describe("Whether QA passed"),
    qaNotes: tool.schema
      .array(tool.schema.string())
      .describe("QA notes — required at least 1 if not passed"),
  },
  async execute({ id, gitRepo, passed, qaNotes, subtaskId }) {
    const prd = getPrd(id, gitRepo);
    if (!prd) {
      return `Ticket with ID ${id} not found.`;
    }

    const ticket = subtaskId
      ? prd.subtasks?.find((subtask: any) => subtask.id === subtaskId)
      : prd;
    if (!ticket) {
      return `Subtask with ID ${subtaskId} not found in ticket with ID ${id}.`;
    }

    if (ticket.status !== "Needs QA") {
      const label = subtaskId ? `Subtask ${subtaskId}` : `Ticket ${id}`;
      return `${label} is not in a state that allows QA. Current status: ${ticket.status}.`;
    }

    if (!passed && (!qaNotes || qaNotes.length === 0)) {
      return "QA notes are required when QA does not pass.";
    }

    ticket.qaNotes = qaNotes;
    if (passed) {
      ticket.implementationRetryCount = 0;
      if (subtaskId && !prd.subtasksNeedPrs) {
        ticket.status = "Needs Git Merge";
      } else {
        ticket.status = "Needs PR";
      }
    } else {
      ticket.implementationRetryCount = (ticket.implementationRetryCount || 0) + 1;
      if (ticket.implementationRetryCount > 3) {
        ticket.status = "Needs Human Clarification";
      } else {
        ticket.status = "Needs Implementation Update";
      }
    }
    updatePrd(prd, gitRepo);

    const outcome = ticket.status;
    const label = subtaskId ? `Subtask ${subtaskId}` : `Ticket ${id}`;
    return `${label} QA completed and marked as ${outcome}.`;
  },
});

export const completeSecurityReview = tool({
  description:
    "Completes the security review for a ticket. If passed, transitions to Needs QA. If failed, transitions to Needs Implementation Update with security notes.",
  args: {
    id: tool.schema.string().describe("Id of the ticket"),
    gitRepo: tool.schema.string().describe("The Git repository name"),
    subtaskId: tool.schema
      .string()
      .optional()
      .describe("Id of the subtask to complete security review for"),
    passed: tool.schema.boolean().describe("Whether the security review passed"),
    securityNotes: tool.schema
      .array(tool.schema.string())
      .describe("Security review notes — required at least 1 if not passed"),
  },
  async execute({ id, gitRepo, passed, securityNotes, subtaskId }) {
    const prd = getPrd(id, gitRepo);
    if (!prd) {
      return `Ticket with ID ${id} not found.`;
    }

    const ticket = subtaskId
      ? prd.subtasks?.find((subtask: any) => subtask.id === subtaskId)
      : prd;
    if (!ticket) {
      return `Subtask with ID ${subtaskId} not found in ticket with ID ${id}.`;
    }

    if (ticket.status !== "Needs Security Review") {
      const label = subtaskId ? `Subtask ${subtaskId}` : `Ticket ${id}`;
      return `${label} is not in a state that allows security review. Current status: ${ticket.status}.`;
    }

    if (!passed && (!securityNotes || securityNotes.length === 0)) {
      return "Security notes are required when the security review does not pass.";
    }

    ticket.securityNotes = securityNotes;
    if (passed) {
      ticket.status = "Needs QA";
    } else {
      ticket.implementationRetryCount = (ticket.implementationRetryCount || 0) + 1;
      if (ticket.implementationRetryCount > 3) {
        ticket.status = "Needs Human Clarification";
      } else {
        ticket.status = "Needs Implementation Update";
      }
    }
    updatePrd(prd, gitRepo);

    const outcome = ticket.status;
    const label = subtaskId ? `Subtask ${subtaskId}` : `Ticket ${id}`;
    return `${label} security review completed and marked as ${outcome}.`;
  },
});

export const completePR = tool({
  description:
    "Confirms a PR was merged and transitions the ticket from Needs PR Maintenance to Needs Finalizing. Accepts an optional `merged` param (defaults to true) for defense-in-depth — if explicitly passed as false, returns an error guiding the caller to use flagPrRework instead.",
  args: {
    id: tool.schema.string().describe("Id of the ticket"),
    gitRepo: tool.schema.string().describe("The Git repository name"),
    subtaskId: tool.schema
      .string()
      .optional()
      .describe("Id of the subtask the PR is for"),
    prUrl: tool.schema
      .string()
      .optional()
      .describe("URL of the pull request — optional if already on the ticket"),
    merged: tool.schema
      .boolean()
      .optional()
      .describe(
        "Whether the PR was merged. Defaults to true. Pass false to reject — use flagPrRework instead.",
      ),
  },
  async execute({ id, gitRepo, prUrl, merged, subtaskId }) {
    const prd = getPrd(id, gitRepo);
    if (!prd) {
      return `Ticket with ID ${id} not found.`;
    }

    const ticket = subtaskId
      ? prd.subtasks?.find((subtask: any) => subtask.id === subtaskId)
      : prd;
    if (!ticket) {
      return subtaskId
        ? `Subtask with ID ${subtaskId} not found in ticket with ID ${id}.`
        : `Ticket with ID ${id} not found.`;
    }

    if (ticket.status !== "Needs PR Maintenance") {
      const label = subtaskId ? `Subtask ${subtaskId}` : `Ticket ${id}`;
      return `${label} is not in a state that allows completing a PR. Current status: ${ticket.status}.`;
    }

    if (merged === false) {
      return "PR not merged. Use flagPrRework to flag for rework instead of completePR.";
    }

    if (prUrl) {
      ticket.prUrl = prUrl;
    }
    ticket.merged = true;
    ticket.status = "Needs Finalizing";

    updatePrd(prd, gitRepo);

    const label = subtaskId ? `Subtask ${subtaskId}` : `Ticket ${id}`;
    return `${label} PR confirmed merged and marked as Needs Finalizing.`;
  },
});

export const finalizeReapproach = tool({
  description:
    "Finalizes the reapproach process. Marks the ticket as Needs Plan Updating so a new plan can be created.",
  args: {
    id: tool.schema.string().describe("Id of the ticket"),
    gitRepo: tool.schema.string().describe("The Git repository name"),
    subtaskId: tool.schema
      .string()
      .optional()
      .describe("Id of the subtask to finalize reapproach for"),
  },
  async execute({ id, gitRepo, subtaskId }) {
    const prd = getPrd(id, gitRepo);
    if (!prd) {
      return `Ticket with ID ${id} not found.`;
    }

    const ticket = subtaskId
      ? prd.subtasks?.find((subtask: any) => subtask.id === subtaskId)
      : prd;
    if (!ticket) {
      return `Subtask with ID ${subtaskId} not found in ticket with ID ${id}.`;
    }

    if (ticket.status !== "Needs Reapproach") {
      const label = subtaskId ? `Subtask ${subtaskId}` : `Ticket ${id}`;
      return `${label} is not in a state that allows finalizing reapproach. Current status: ${ticket.status}.`;
    }

    ticket.status = "Needs Plan Updating";
    ticket.planIssues = undefined;
    ticket.blockingIssues = undefined;
    ticket.evidence = [];
    ticket.planIteration = 0;
    ticket.implementationRetryCount = 0;
    if (!subtaskId) {
      prd.planIteration = 0;
    }
    updatePrd(prd, gitRepo);

    const label = subtaskId ? `Subtask ${subtaskId}` : `Ticket ${id}`;
    return `${label} reapproach finalized and marked as Needs Plan Updating.`;
  },
});

export const finalizeTicket = tool({
  description:
    "Finalizes a ticket, transitioning it to Needs Cleanup (precursor to Done). The ticket will be marked Done after the cleanup stage.",
  args: {
    id: tool.schema.string().describe("Id of the ticket"),
    gitRepo: tool.schema.string().describe("The Git repository name"),
    subtaskId: tool.schema
      .string()
      .optional()
      .describe("Id of the subtask to finalize"),
  },
  async execute({ id, gitRepo, subtaskId }) {
    const prd = getPrd(id, gitRepo);
    if (!prd) {
      return `Ticket with ID ${id} not found.`;
    }

    const ticket = subtaskId
      ? prd.subtasks?.find((subtask: any) => subtask.id === subtaskId)
      : prd;
    if (!ticket) {
      return `Subtask with ID ${subtaskId} not found in ticket with ID ${id}.`;
    }

    if (ticket.status !== "Needs Finalizing") {
      const label = subtaskId ? `Subtask ${subtaskId}` : `Ticket ${id}`;
      return `${label} is not in a state that allows finalizing. Current status: ${ticket.status}.`;
    }

    if (!subtaskId && prd.subtasks?.length) {
      const undone = prd.subtasks.filter(s => s.status !== "Done");
      if (undone.length > 0) {
        return `Cannot finalize parent ticket: subtasks [${undone.map(s => s.id).join(", ")}] are not Done. Complete or cancel all subtasks first.`;
      }
    }

    ticket.status = "Needs Cleanup";

    updatePrd(prd, gitRepo);

    const label = subtaskId ? `Subtask ${subtaskId}` : `Ticket ${id}`;
    return `${label} finalized and marked as Needs Cleanup.`;
  },
});

export const completeCleanup = tool({
  description:
    "Completes the cleanup stage after worktree removal and branch deletion, transitioning a ticket or subtask from 'Needs Cleanup' to 'Done'. If a subtask was cleaned up and all subtasks are now Done, advances the parent from 'Needs Subtickets Processed' to 'Needs Implementing'.",
  args: {
    id: tool.schema.string().describe("Id of the ticket"),
    gitRepo: tool.schema.string().describe("The Git repository name"),
    subtaskId: tool.schema
      .string()
      .optional()
      .describe("Id of the subtask to complete cleanup for"),
  },
  async execute({ id, gitRepo, subtaskId }) {
    const prd = getPrd(id, gitRepo);
    if (!prd) {
      return `Ticket with ID ${id} not found.`;
    }

    const ticket = subtaskId
      ? prd.subtasks?.find((subtask: any) => subtask.id === subtaskId)
      : prd;
    if (!ticket) {
      return subtaskId
        ? `Subtask with ID ${subtaskId} not found in ticket with ID ${id}.`
        : `Ticket with ID ${id} not found.`;
    }

    if (ticket.status !== "Needs Cleanup") {
      const label = subtaskId ? `Subtask ${subtaskId}` : `Ticket ${id}`;
      return `${label} is not in a state that allows completing cleanup. Current status: ${ticket.status}.`;
    }

    // Remove evidence directory for this ticket (parent tickets only)
    if (!subtaskId) {
      const evPath = path.join(getPrdsFolder(), "evidence", `${gitRepo}__${id}`);
      if (fs.existsSync(evPath)) {
        try {
          assertPathWithinPrds(evPath);
          fs.rmSync(evPath, { recursive: true, force: true });
        } catch {
          // non-fatal
        }
      }
    }

    ticket.status = "Done";

    // If a subtask was cleaned up and parent is waiting on subtickets, check if all are now Done
    if (subtaskId && prd.status === "Needs Subtickets Processed") {
      const allDone = prd.subtasks!.every(
        (s: any) => s.status === "Done"
      );
      if (allDone) {
        prd.status = "Needs Implementing";
        updatePrd(prd, gitRepo);
        const label = subtaskId ? `Subtask ${subtaskId}` : `Ticket ${id}`;
        return `${label} cleanup complete and marked as Done. All subtasks complete — parent ticket ${id} advanced to Needs Implementing.`;
      }
    }

    updatePrd(prd, gitRepo);

    const label = subtaskId ? `Subtask ${subtaskId}` : `Ticket ${id}`;
    return `${label} cleanup complete and marked as Done.`;
  },
});

export const blockTicket = tool({
  description:
    "Blocks a ticket, saving its current status and storing the reason. The ticket will stay in Blocked until unblockTicket is called.",
  args: {
    id: tool.schema.string().describe("Id of the ticket"),
    gitRepo: tool.schema.string().describe("The Git repository name"),
    subtaskId: tool.schema
      .string()
      .optional()
      .describe("Id of the subtask to block"),
    blockedReason: tool.schema
      .string()
      .describe("Reason the ticket is blocked — what external dependency is it waiting on?"),
  },
  async execute({ id, gitRepo, blockedReason, subtaskId }) {
    const prd = getPrd(id, gitRepo);
    if (!prd) {
      return `Ticket with ID ${id} not found.`;
    }

    const ticket = subtaskId
      ? prd.subtasks?.find((subtask: any) => subtask.id === subtaskId)
      : prd;
    if (!ticket) {
      return `Subtask with ID ${subtaskId} not found in ticket with ID ${id}.`;
    }

    const terminalStatuses = ["Done", "Cancelled"];
    if (terminalStatuses.includes(ticket.status)) {
      const label = subtaskId ? `Subtask ${subtaskId}` : `Ticket ${id}`;
      return `${label} is in a terminal state (${ticket.status}) and cannot be blocked.`;
    }

    if (ticket.status === "Blocked") {
      const label = subtaskId ? `Subtask ${subtaskId}` : `Ticket ${id}`;
      return `${label} is already blocked.`;
    }

    if (!blockedReason || blockedReason.trim() === "") {
      return "Blocked reason is required.";
    }

    ticket.previousStatus = ticket.status;
    ticket.blockedReason = blockedReason;
    ticket.status = "Blocked";
    updatePrd(prd, gitRepo);

    const label = subtaskId ? `Subtask ${subtaskId}` : `Ticket ${id}`;
    return `${label} blocked. Reason: ${blockedReason}`;
  },
});

export const unblockTicket = tool({
  description:
    "Unblocks a ticket, restoring it to the status it had before being blocked. Clears blockedReason and previousStatus.",
  args: {
    id: tool.schema.string().describe("Id of the ticket"),
    gitRepo: tool.schema.string().describe("The Git repository name"),
    subtaskId: tool.schema
      .string()
      .optional()
      .describe("Id of the subtask to unblock"),
  },
  async execute({ id, gitRepo, subtaskId }) {
    const prd = getPrd(id, gitRepo);
    if (!prd) {
      return `Ticket with ID ${id} not found.`;
    }

    const ticket = subtaskId
      ? prd.subtasks?.find((subtask: any) => subtask.id === subtaskId)
      : prd;
    if (!ticket) {
      return `Subtask with ID ${subtaskId} not found in ticket with ID ${id}.`;
    }

    if (ticket.status !== "Blocked" && ticket.status !== "Needs Human Unblock") {
      const label = subtaskId ? `Subtask ${subtaskId}` : `Ticket ${id}`;
      return `${label} is not currently blocked.`;
    }

    if (!ticket.previousStatus) {
      const label = subtaskId ? `Subtask ${subtaskId}` : `Ticket ${id}`;
      return `${label} is blocked but has no previous status recorded. Use escalate instead.`;
    }

    const restoredStatus = ticket.previousStatus;
    ticket.status = restoredStatus;
    ticket.previousStatus = undefined;
    ticket.blockedReason = undefined;
    updatePrd(prd, gitRepo);

    const label = subtaskId ? `Subtask ${subtaskId}` : `Ticket ${id}`;
    return `${label} unblocked. Status restored to ${restoredStatus}.`;
  },
});

// TODO: expose cancelTicket only when using a human-only tool wrapper
// export const cancelTicket = tool({
//   description:
//     "Cancels a ticket or subtask from any non-terminal status, moving it to Cancelled. Requires a reason.",
//   args: {
//     id: tool.schema.string().describe("Id of the ticket"),
//     gitRepo: tool.schema.string().describe("The Git repository name"),
//     subtaskId: tool.schema
//       .string()
//       .optional()
//       .describe("Id of the subtask to cancel"),
//     reason: tool.schema.string().describe("Reason for cancellation"),
//   },
//   async execute({ id, gitRepo, reason, subtaskId }) {
//     const prd = getPrd(id, gitRepo);
//     if (!prd) {
//       return `Ticket with ID ${id} not found.`;
//     }
//
//     const ticket = subtaskId
//       ? prd.subtasks?.find((subtask: any) => subtask.id === subtaskId)
//       : prd;
//     if (!ticket) {
//       return `Subtask with ID ${subtaskId} not found in ticket with ID ${id}.`;
//     }
//
//     const terminalStatuses = ["Done", "Cancelled"];
//     if (terminalStatuses.includes(ticket.status)) {
//       const label = subtaskId ? `Subtask ${subtaskId}` : `Ticket ${id}`;
//       return `${label} is already in a terminal state (${ticket.status}) and cannot be cancelled.`;
//     }
//
//     if (!reason || reason.trim() === "") {
//       return "Cancellation reason is required.";
//     }
//
//     ticket.status = "Cancelled";
//     updatePrd(prd, gitRepo);
//
//     const label = subtaskId ? `Subtask ${subtaskId}` : `Ticket ${id}`;
//     return `${label} cancelled. Reason: ${reason}`;
//   },
// });

export const addSuggestion = tool({
  description:
    "Adds an out-of-scope observation (suggestion) to a ticket. Call this when you find something worth fixing that is outside the ticket's acceptance criteria. Suggestions are surfaced in the PR description as 'Things to consider before merging'.",
  args: {
    id: tool.schema.string().describe("Id of the ticket"),
    gitRepo: tool.schema.string().describe("The Git repository name"),
    message: tool.schema
      .string()
      .min(10)
      .max(500)
      .describe("The suggestion message describing the out-of-scope observation"),
    source: tool.schema
      .string()
      .describe("Source of the suggestion: planning, implementation, review, qa, or security"),
    subtaskId: tool.schema
      .string()
      .optional()
      .describe("Id of the subtask if the suggestion originates from or should be added to a subtask"),
  },
  async execute({ id, gitRepo, message, source, subtaskId }) {
    const prd = getPrd(id, gitRepo);
    if (!prd) {
      return `Ticket with ID ${id} not found.`;
    }
    if (!["planning", "implementation", "review", "qa", "security"].includes(source)) {
      return `Invalid source: ${source}. Must be one of: planning, implementation, review, qa, security.`;
    }
    const target = subtaskId
      ? prd.subtasks?.find((st: any) => st.id === subtaskId)
      : prd;
    if (subtaskId && !target) {
      return `Subtask with ID ${subtaskId} not found in ticket with ID ${id}.`;
    }
    if (!target.suggestions) {
      target.suggestions = [];
    }
    const suggestion = {
      suggestionId: crypto.randomUUID(),
      message,
      source,
      createdAt: new Date().toISOString(),
    };
    target.suggestions.push(suggestion);
    updatePrd(prd, gitRepo);
    const label = subtaskId ? `Subtask ${subtaskId} of ticket ${id}` : `Ticket ${id}`;
    return `Suggestion added to ${label} with ID ${suggestion.suggestionId}.`;
  },
});

export const resolveSuggestion = tool({
  description:
    "Marks a suggestion as resolved (e.g., because it was fixed during implementation). Resolved suggestions appear under 'Items resolved during implementation' in the PR instead of 'Things to consider before merging'.",
  args: {
    id: tool.schema.string().describe("Id of the ticket"),
    gitRepo: tool.schema.string().describe("The Git repository name"),
    suggestionId: tool.schema
      .string()
      .describe("Id of the suggestion to mark as resolved"),
    subtaskId: tool.schema
      .string()
      .optional()
      .describe("Id of the subtask the suggestion belongs to"),
  },
  async execute({ id, gitRepo, suggestionId, subtaskId }) {
    const prd = getPrd(id, gitRepo);
    if (!prd) {
      return `Ticket with ID ${id} not found.`;
    }
    const ticket = subtaskId
      ? prd.subtasks?.find((st: any) => st.id === subtaskId)
      : prd;
    if (subtaskId && !ticket) {
      return `Subtask with ID ${subtaskId} not found in ticket with ID ${id}.`;
    }
    if (!ticket.suggestions) {
      const label = subtaskId ? `Subtask ${subtaskId} of ticket ${id}` : `Ticket ${id}`;
      return `No suggestions found for ${label}.`;
    }
    const suggestion = ticket.suggestions.find(
      (s: any) => s.suggestionId === suggestionId,
    );
    if (!suggestion) {
      return `Suggestion with ID ${suggestionId} not found.`;
    }
    if (suggestion.resolvedAt) {
      return `Suggestion with ID ${suggestionId} is already resolved.`;
    }
    suggestion.resolvedAt = new Date().toISOString();
    updatePrd(prd, gitRepo);
    const label = subtaskId ? `Subtask ${subtaskId} of ticket ${id}` : `Ticket ${id}`;
    return `Suggestion with ID ${suggestionId} marked as resolved on ${label}.`;
  },
});

export const addDeviation = tool({
  description:
    "Records a deviation from the implementation plan. Call this when you intentionally skip or replace a planned step. Deviations are evaluated during review and QA before being included in the PR.",
  args: {
    id: tool.schema.string().describe("Id of the ticket"),
    gitRepo: tool.schema.string().describe("The Git repository name"),
    planItem: tool.schema
      .string()
      .min(5)
      .max(250)
      .describe("The plan item that was intentionally not followed"),
    action: tool.schema
      .string()
      .describe("Whether the plan item was omitted or replaced"),
    reason: tool.schema
      .string()
      .min(10)
      .max(500)
      .describe("Why the deviation was necessary"),
    replacement: tool.schema
      .string()
      .optional()
      .describe("What was done instead (if action is 'replaced')"),
  },
  async execute({ id, gitRepo, planItem, action, reason, replacement }) {
    const prd = getPrd(id, gitRepo);
    if (!prd) {
      return `Ticket with ID ${id} not found.`;
    }
    if (!["omitted", "replaced"].includes(action)) {
      return `Invalid action: ${action}. Must be 'omitted' or 'replaced'.`;
    }
    if (!prd.deviations) {
      prd.deviations = [];
    }
    const deviation = {
      deviationId: crypto.randomUUID(),
      planItem,
      action,
      replacement,
      reason,
      createdAt: new Date().toISOString(),
    };
    prd.deviations.push(deviation);
    updatePrd(prd, gitRepo);
    return `Deviation recorded with ID ${deviation.deviationId}. This deviation must be reviewed during the Review stage.`;
  },
});

export const reviewDeviation = tool({
  description:
    "Reviews a recorded deviation during the Review stage. If rejected, the deviation must be addressed before the ticket can proceed.",
  args: {
    id: tool.schema.string().describe("Id of the ticket"),
    gitRepo: tool.schema.string().describe("The Git repository name"),
    deviationId: tool.schema
      .string()
      .describe("Id of the deviation to review"),
    accepted: tool.schema
      .boolean()
      .describe("Whether the deviation is acceptable"),
    comment: tool.schema
      .string()
      .optional()
      .describe("Optional comment explaining the review decision"),
  },
  async execute({ id, gitRepo, deviationId, accepted, comment }) {
    const prd = getPrd(id, gitRepo);
    if (!prd) {
      return `Ticket with ID ${id} not found.`;
    }
    if (!prd.deviations) {
      return `No deviations found for ticket with ID ${id}.`;
    }
    const deviation = prd.deviations.find(
      (d: any) => d.deviationId === deviationId,
    );
    if (!deviation) {
      return `Deviation with ID ${deviationId} not found.`;
    }
    if (deviation.reviewResult) {
      return `Deviation with ID ${deviationId} has already been reviewed.`;
    }
    deviation.reviewResult = { accepted, comment };
    updatePrd(prd, gitRepo);
    const outcome = accepted ? "accepted" : "rejected";
    return `Deviation with ID ${deviationId} reviewed and ${outcome}.`;
  },
});

export const qaDeviation = tool({
  description:
    "Validates a deviation during the QA stage. Confirms the deviation didn't break anything.",
  args: {
    id: tool.schema.string().describe("Id of the ticket"),
    gitRepo: tool.schema.string().describe("The Git repository name"),
    deviationId: tool.schema
      .string()
      .describe("Id of the deviation to QA"),
    validated: tool.schema
      .boolean()
      .describe("Whether QA validates the deviation is safe"),
    comment: tool.schema
      .string()
      .optional()
      .describe("Optional comment explaining the QA decision"),
  },
  async execute({ id, gitRepo, deviationId, validated, comment }) {
    const prd = getPrd(id, gitRepo);
    if (!prd) {
      return `Ticket with ID ${id} not found.`;
    }
    if (!prd.deviations) {
      return `No deviations found for ticket with ID ${id}.`;
    }
    const deviation = prd.deviations.find(
      (d: any) => d.deviationId === deviationId,
    );
    if (!deviation) {
      return `Deviation with ID ${deviationId} not found.`;
    }
    if (!deviation.reviewResult) {
      return `Deviation with ID ${deviationId} has not been reviewed yet. Cannot QA before review.`;
    }
    if (deviation.qaResult) {
      return `Deviation with ID ${deviationId} has already been QA'd.`;
    }
    deviation.qaResult = { validated, comment };
    updatePrd(prd, gitRepo);
    const outcome = validated ? "validated" : "flagged";
    return `Deviation with ID ${deviationId} QA'd and ${outcome}.`;
  },
});

export const addEvidence = tool({
  description:
    "Copies an existing file as evidence for a ticket. Takes a path to an existing file (screenshot, API response, log, etc.), copies it to the PRD evidence directory, and records the metadata in the ticket's evidence array.",
  args: {
    id: tool.schema.string().describe("Id of the ticket"),
    gitRepo: tool.schema.string().describe("The Git repository name"),
    description: tool.schema
      .string()
      .min(3)
      .max(500)
      .describe("Description of the evidence (e.g., 'POST /comments returns 201')"),
    type: tool.schema
      .string()
      .describe("Type of evidence: screenshot, api_response, build_output, test_output, migration_output, log_evidence, or security_scan"),
    source: tool.schema
      .string()
      .describe("Source of the evidence: implementation, review, qa, security, or pr_maintenance"),
    existingFilePath: tool.schema
      .string()
      .describe("Absolute path to the existing file to copy as evidence"),
    subtaskId: tool.schema
      .string()
      .optional()
      .describe("Id of the subtask this evidence belongs to"),
  },
  async execute({ id, gitRepo, description, type, source, existingFilePath, subtaskId }) {
    const validTypes = ["screenshot", "api_response", "build_output", "test_output", "migration_output", "log_evidence", "security_scan"];
    if (!validTypes.includes(type)) {
      return `Invalid type: ${type}. Must be one of: ${validTypes.join(", ")}.`;
    }
    const validSources = ["implementation", "review", "qa", "security", "pr_maintenance"];
    if (!validSources.includes(source)) {
      return `Invalid source: ${source}. Must be one of: ${validSources.join(", ")}.`;
    }
    const prd = getPrd(id, gitRepo);
    if (!prd) {
      return `Ticket with ID ${id} not found.`;
    }
    const ticket = subtaskId
      ? prd.subtasks?.find((st: any) => st.id === subtaskId)
      : prd;
    if (subtaskId && !ticket) {
      return `Subtask with ID ${subtaskId} not found in ticket with ID ${id}.`;
    }
    if (ticket.status === "Done" || ticket.status === "Cancelled") {
      return `Cannot add evidence: ticket is already ${ticket.status}.`;
    }
    if (!fs.existsSync(existingFilePath)) {
      return `File not found: ${existingFilePath}`;
    }
    const stat = fs.statSync(existingFilePath);
    if (!stat.isFile()) {
      return `Path is not a file: ${existingFilePath}`;
    }
    if (stat.size > 10 * 1024 * 1024) {
      return `File too large: ${(stat.size / 1024 / 1024).toFixed(1)}MB. Maximum is 10MB.`;
    }
    const evDir = path.join(getPrdsFolder(), "evidence", `${gitRepo}__${id}`);
    if (!fs.existsSync(evDir)) {
      fs.mkdirSync(evDir, { recursive: true });
    }
    assertPathWithinPrds(evDir);
    const ext = path.extname(existingFilePath) || extForContentType(type === "screenshot" ? "image/png" : "text/plain");
    const evidenceId = crypto.randomUUID();
    const slug = description
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 60) || "evidence";
    const destFile = `${slug}__${evidenceId}${ext}`;
    const destPath = path.join(evDir, destFile);
    assertPathWithinPrds(destPath);
    fs.copyFileSync(existingFilePath, destPath);
    const contentType = type === "screenshot" ? "image/png" :
      type === "api_response" ? "application/json" :
      type === "build_output" || type === "test_output" || type === "log_evidence" || type === "migration_output" ? "text/plain" :
      type === "security_scan" ? "application/json" : "application/octet-stream";
    const relativePath = path.join("evidence", `${gitRepo}__${id}`, destFile);
    const evidence = {
      evidenceId,
      description,
      type,
      source,
      filePath: relativePath,
      contentType,
      createdAt: new Date().toISOString(),
    };
    if (!ticket.evidence) {
      ticket.evidence = [];
    }
    ticket.evidence.push(evidence);
    updatePrd(prd, gitRepo);
    return `Evidence added with ID ${evidenceId} (${destPath}).`;
  },
});

export const removeEvidence = tool({
  description:
    "Removes an evidence entry from a ticket by its evidenceId. Deletes the file from disk and removes the metadata from the ticket JSON. Cannot be called on Done or Cancelled tickets.",
  args: {
    id: tool.schema.string().describe("Id of the ticket"),
    gitRepo: tool.schema.string().describe("The Git repository name"),
    evidenceId: tool.schema.string().describe("Id of the evidence entry to remove"),
    subtaskId: tool.schema
      .string()
      .optional()
      .describe("Id of the subtask this evidence belongs to"),
  },
  async execute({ id, gitRepo, evidenceId, subtaskId }) {
    const prd = getPrd(id, gitRepo);
    if (!prd) {
      return `Ticket with ID ${id} not found.`;
    }
    const ticket = subtaskId
      ? prd.subtasks?.find((st: any) => st.id === subtaskId)
      : prd;
    if (subtaskId && !ticket) {
      return `Subtask with ID ${subtaskId} not found in ticket with ID ${id}.`;
    }
    if (ticket.status === "Done" || ticket.status === "Cancelled") {
      return `Cannot remove evidence: ticket is already ${ticket.status}.`;
    }
    if (!ticket.evidence) {
      return `No evidence found for this ticket.`;
    }
    const idx = ticket.evidence.findIndex((e: any) => e.evidenceId === evidenceId);
    if (idx === -1) {
      return `Evidence with ID ${evidenceId} not found.`;
    }
    const record = ticket.evidence[idx];
    ticket.evidence.splice(idx, 1);
    const filePath = path.join(getPrdsFolder(), record.filePath);
    if (fs.existsSync(filePath)) {
      try {
        assertPathWithinPrds(filePath);
        fs.rmSync(filePath, { force: true });
      } catch {
        // non-fatal
      }
    }
    updatePrd(prd, gitRepo);
    return `Evidence with ID ${evidenceId} removed.`;
  },
});

export const getEvidence = tool({
  description:
    "Returns all evidence entries for a ticket (or specific subtask) as JSON. Optionally reads file content for a specific evidenceId. Use this to review collected evidence before PR creation or finalization.",
  args: {
    id: tool.schema.string().describe("Id of the ticket"),
    gitRepo: tool.schema.string().describe("The Git repository name"),
    subtaskId: tool.schema
      .string()
      .optional()
      .describe("Id of the subtask to get evidence for"),
    evidenceId: tool.schema
      .string()
      .optional()
      .describe("If provided, reads the file content for this specific evidence entry"),
    maxChars: tool.schema
      .number()
      .optional()
      .describe("Maximum characters to read from the evidence file (default: 10000)"),
  },
  async execute({ id, gitRepo, subtaskId, evidenceId, maxChars }) {
    const prd = getPrd(id, gitRepo);
    if (!prd) {
      return `Ticket with ID ${id} not found.`;
    }
    const ticket = subtaskId
      ? prd.subtasks?.find((st: any) => st.id === subtaskId)
      : prd;
    if (subtaskId && !ticket) {
      return `Subtask with ID ${subtaskId} not found in ticket with ID ${id}.`;
    }
    if (!ticket.evidence || ticket.evidence.length === 0) {
      return `No evidence found for this ticket.`;
    }
    if (evidenceId) {
      const record = ticket.evidence.find((e: any) => e.evidenceId === evidenceId);
      if (!record) {
        return `Evidence with ID ${evidenceId} not found.`;
      }
      const filePath = path.join(getPrdsFolder(), record.filePath);
      if (!fs.existsSync(filePath)) {
        return JSON.stringify({ metadata: record, error: "File not found on disk" }, null, 2);
      }
      if (record.contentType.startsWith("image/")) {
        return JSON.stringify({ metadata: record, content: "[Binary image — cannot display as text. Reference the filePath directly.]" }, null, 2);
      }
      const limit = maxChars || 10000;
      const content = fs.readFileSync(filePath, "utf-8");
      const truncated = content.length > limit;
      const body = truncated ? content.slice(0, limit) : content;
      let warning = "";
      if (truncated) {
        const actualBytes = Buffer.byteLength(content, "utf-8");
        const shownBytes = Buffer.byteLength(body, "utf-8");
        warning = `\n\n[Warning: Output truncated at ${shownBytes} bytes. Full size is ${actualBytes} bytes. Use getEvidence with a larger maxChars to read more.]`;
      }
      return JSON.stringify({ metadata: record, content: body }, null, 2) + warning;
    }
    return JSON.stringify(ticket.evidence, null, 2);
  },
});
