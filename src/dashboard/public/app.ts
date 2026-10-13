// PRD Dashboard Application
// Vanilla ES Modules - no framework
// TypeScript with end-to-end type safety from shared backend types

import { marked } from "marked";
import type {
  Ticket,
  TicketStatus,
  Evidence,
  Suggestion,
  Deviation,
  ValidationRun,
  ValidationRunWithDuration,
  Repo,
  TicketEvent,
  WebSocketMessage,
  ExtendedWebSocketMessage,
  BaseTicket,
} from "./types.js";
import type { ValidationConfig, ValidationCheck } from "./types.js";

const API_BASE = "/api/v1";
const WS_URL = `ws://${window.location.host}/ws`;

let ws: WebSocket | null = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 10;
const RECONNECT_BASE_DELAY = 1000;

interface DashboardState {
  repos: Repo[];
  tickets: Ticket[];
  currentView: "overview" | "kanban" | "flagged";
  currentRepo: string;
  selectedTicket: Ticket | null;
  wsConnected: boolean;
}

const state: DashboardState = {
  repos: [],
  tickets: [],
  currentView: "overview",
  currentRepo: "",
  selectedTicket: null,
  wsConnected: false,
};

// DOM Elements - typed
const repoSelect = document.getElementById("repo-select") as HTMLSelectElement;
const connectionStatus = document.getElementById(
  "connection-status",
) as HTMLSpanElement;
const tabs = document.querySelectorAll<HTMLButtonElement>(".tab");
const views = document.querySelectorAll<HTMLElement>(".view");
const repoGrid = document.getElementById("repo-grid") as HTMLDivElement;
const kanbanBoard = document.getElementById("kanban-board") as HTMLDivElement;
const flaggedList = document.getElementById("flagged-list") as HTMLDivElement;
const detailModal = document.getElementById("detail-modal") as HTMLDialogElement;
const detailClose = document.getElementById(
  "detail-close",
) as HTMLButtonElement;
const detailTabs = document.querySelectorAll<HTMLButtonElement>(".detail-tab");
const detailTitle = document.getElementById(
  "detail-title",
) as HTMLHeadingElement;
const detailContent = document.getElementById(
  "detail-content",
) as HTMLDivElement;
const unblockModal = document.getElementById(
  "unblock-modal",
) as HTMLDialogElement;
const unblockMessage = document.getElementById(
  "unblock-message",
) as HTMLParagraphElement;
const evidenceModal = document.getElementById(
  "evidence-modal",
) as HTMLDialogElement;
const evidenceModalTitle = document.getElementById(
  "evidence-modal-title",
) as HTMLHeadingElement;
const evidenceModalContent = document.getElementById(
  "evidence-modal-content",
) as HTMLDivElement;

// Validation Config Modal
const validationConfigModal = document.getElementById(
  "validation-config-modal",
) as HTMLDialogElement;
const validationConfigClose = document.getElementById(
  "validation-config-close",
) as HTMLButtonElement;
const validationConfigModalTitle = document.getElementById(
  "validation-config-modal-title",
) as HTMLHeadingElement;
const validationConfigJson = document.getElementById(
  "validation-config-json",
) as HTMLTextAreaElement;
const validationConfigError = document.getElementById(
  "validation-config-error",
) as HTMLDivElement;
const validationConfigSave = document.getElementById(
  "validation-config-save",
) as HTMLButtonElement;
const validationConfigExampleJson = document.getElementById(
  "validation-config-example-json",
) as HTMLPreElement;

let currentRepoForConfig: string | null = null;

// Initialize
document.addEventListener("DOMContentLoaded", async () => {
  setupEventListeners();
  await loadRalphInstances();
  await loadActiveLocks();
  connectWebSocket();
  loadRepos();
  loadOverview();
});

function setupEventListeners(): void {
  // Tab switching
  tabs.forEach((tab) => {
    tab.addEventListener("click", () =>
      switchView(tab.dataset.view as "overview" | "kanban" | "flagged"),
    );
  });

  // Repo select
  repoSelect.addEventListener("change", (e) => {
    state.currentRepo = (e.target as HTMLSelectElement).value;
    if (state.currentView === "overview") {
      loadOverview();
    } else if (state.currentView === "kanban") {
      loadKanban();
    }
  });

  // Detail modal close
  detailClose.addEventListener("click", () => closeDetailPanel());

  // Detail tabs
  detailTabs.forEach((tab) => {
    tab.addEventListener("click", () =>
      switchDetailTab(tab.dataset.tab as DetailTab),
    );
  });

  // Unblock modal
  unblockModal.addEventListener("close", () => {
    // Modal closed
  });

  // Click outside detail modal to close (backdrop click)
  detailModal.addEventListener("click", (e) => {
    if (e.target === detailModal) closeDetailPanel();
  });

  // Subtask click delegation (in detail panel)
  detailContent.addEventListener("click", (e) => {
    const subtaskEl = (e.target as HTMLElement).closest(".subtask-clickable");
    if (subtaskEl) {
      const subtaskId = subtaskEl.getAttribute("data-subtask-id");
      if (subtaskId && state.selectedTicket) {
        const subtask = state.selectedTicket.subtasks?.find((s) => s.id === subtaskId);
        if (subtask) openDetailPanel(subtask);
      }
    }
  });

  // Validation Config Modal
  validationConfigClose.addEventListener("click", () =>
    validationConfigModal.close(),
  );
  validationConfigSave.addEventListener("click", () => {
    validationConfigModal.close("save");
  });
  validationConfigModal.addEventListener("close", () => {
    const direction = validationConfigModal.returnValue;
    if (direction === "save") {
      saveValidationConfig();
    }
  });

  // Click outside validation config modal to close (backdrop click)
  validationConfigModal.addEventListener("click", (e) => {
    if (e.target === validationConfigModal) validationConfigModal.close();
  });

  // Real-time JSON validation
  validationConfigJson.addEventListener("input", () => {
    validateValidationConfigJson();
  });
}

function switchView(view: "overview" | "kanban" | "flagged"): void {
  state.currentView = view;

  tabs.forEach((t) => t.classList.toggle("active", t.dataset.view === view));
  views.forEach((v) => v.classList.toggle("active", v.id === `view-${view}`));

  if (view === "overview") loadOverview();
  else if (view === "kanban") loadKanban();
  else if (view === "flagged") loadFlagged();
}

type DetailTab =
  | "overview"
  | "plan"
  | "evidence"
  | "suggestions"
  | "deviations"
  | "subtasks"
  | "validation";

function switchDetailTab(tab: DetailTab): void {
  detailTabs.forEach((t) =>
    t.classList.toggle("active", t.dataset.tab === tab),
  );
  const sections = document.querySelectorAll<HTMLElement>(".detail-section");
  sections.forEach((s) =>
    s.classList.toggle("active", s.id === `detail-${tab}`),
  );

  if (state.selectedTicket) {
    renderDetailTab(tab, state.selectedTicket);
  }
}

// WebSocket
function connectWebSocket(): void {
  ws = new WebSocket(WS_URL);

  ws.onopen = () => {
    console.log("WebSocket connected");
    state.wsConnected = true;
    updateConnectionStatus("connected");
    reconnectAttempts = 0;

    // Subscribe to repo if selected
    if (state.currentRepo) {
      ws!.send(JSON.stringify({ type: "subscribe", repo: state.currentRepo }));
    }
  };

  ws.onmessage = (event: MessageEvent) => {
    try {
      const message = JSON.parse(event.data) as WebSocketMessage;
      handleWebSocketMessage(message);
    } catch (err) {
      console.error("Failed to parse WS message:", err);
    }
  };

  ws.onclose = () => {
    console.log("WebSocket disconnected");
    state.wsConnected = false;
    updateConnectionStatus("disconnected");
    scheduleReconnect();
  };

  ws.onerror = (err) => {
    console.error("WebSocket error:", err);
  };
}

// State for active locks
interface ActiveLock {
  ticketId: string;
  instanceId: string;
  instanceName: string;
  lockType: "validation" | "processing";
  expiresAt: number;
}

const activeLocks = new Map<string, ActiveLock>(); // ticketId -> lock
const ralphInstances = new Map<
  string,
  { id: string; name: string; repo: string; status: string }
>(); // instanceId -> instance

function scheduleReconnect(): void {
  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    console.log("Max reconnect attempts reached");
    return;
  }

  const delay =
    RECONNECT_BASE_DELAY * Math.pow(2, reconnectAttempts) +
    Math.random() * 1000;
  reconnectAttempts++;

  setTimeout(() => {
    console.log(`Reconnecting... (attempt ${reconnectAttempts})`);
    updateConnectionStatus("connecting");
    connectWebSocket();
  }, delay);
}

function updateConnectionStatus(
  status: "connected" | "disconnected" | "connecting",
): void {
  connectionStatus.className = `status ${status}`;
  connectionStatus.textContent =
    status.charAt(0).toUpperCase() + status.slice(1);
}

function handleWebSocketMessage(message: WebSocketMessage): void {
  const { event, data, timestamp } = message;

  console.log("WS Event:", event, data);

  switch (event) {
    case "ticket:created":
    case "ticket:status_changed":
    case "ticket:flagged":
    case "subtask:created":
    case "evidence:added":
    case "suggestion:added":
    case "deviation:added":
    case "validation:started":
    case "validation:completed":
      // Refresh current view
      if (state.currentView === "overview") loadOverview();
      else if (state.currentView === "kanban") loadKanban();
      else if (state.currentView === "flagged") loadFlagged();

      // Update detail panel if open
      const ticketId =
        (data as { ticketId?: string; id?: string }).ticketId ??
        (data as { id?: string }).id;
      if (state.selectedTicket && ticketId === state.selectedTicket.id) {
        loadTicketDetail(state.selectedTicket.id);
      }
      break;

    case "ticket:lock_acquired": {
      const { ticketId, instanceId, lockType } = data as {
        ticketId: string;
        instanceId: string;
        lockType: string;
      };
      const instance = ralphInstances.get(instanceId);
      activeLocks.set(ticketId, {
        ticketId,
        instanceId,
        instanceName: instance?.name || instanceId.slice(0, 8),
        lockType: lockType as "validation" | "processing",
        expiresAt: timestamp + 1860000,
      });
      refreshViews();
      break;
    }

    case "ticket:lock_released": {
      const { ticketId } = data as { ticketId: string };
      activeLocks.delete(ticketId);
      refreshViews();
      break;
    }

    case "ticket:lock_expired": {
      const { ticketId } = data as { ticketId: string };
      activeLocks.delete(ticketId);
      refreshViews();
      break;
    }

    case "ralph:registered": {
      const { instanceId, name, repo, status } = data as {
        instanceId: string;
        name: string;
        repo: string;
        status: string;
      };
      ralphInstances.set(instanceId, { id: instanceId, name, repo, status });
      refreshViews();
      break;
    }

    case "ralph:offline": {
      const { instanceId } = data as { instanceId: string };
      ralphInstances.delete(instanceId);
      // Clean up locks for this instance
      for (const [ticketId, lock] of activeLocks.entries()) {
        if (lock.instanceId === instanceId) {
          activeLocks.delete(ticketId);
        }
      }
      refreshViews();
      break;
    }

    case "shutdown":
      updateConnectionStatus("disconnected");
      alert("Server is shutting down. Please refresh later.");
      break;
  }
}

function refreshViews(): void {
  if (state.currentView === "overview") loadOverview();
  else if (state.currentView === "kanban") loadKanban();
  else if (state.currentView === "flagged") loadFlagged();

  // Update detail panel if open
  if (state.selectedTicket) {
    const lock = activeLocks.get(state.selectedTicket.id);
    updateDetailLockInfo(lock);
  }
}

function updateDetailLockInfo(lock: ActiveLock | undefined): void {
  const lockInfo = document.getElementById("detail-lock-info");
  if (!lockInfo) return;

  if (lock) {
    lockInfo.innerHTML = `
      <div class="lock-indicator ${lock.lockType}">
        <span class="lock-icon">🔒</span>
        <span>Locked by <strong>${escapeHtml(lock.instanceName)}</strong> for <strong>${lock.lockType}</strong></span>
        <span class="lock-expires">Expires: ${formatDate(lock.expiresAt)}</span>
      </div>
    `;
    lockInfo.classList.remove("hidden");
  } else {
    lockInfo.classList.add("hidden");
    lockInfo.innerHTML = "";
  }
}

// API Helpers
async function apiGet<T>(path: string): Promise<T> {
  const url = `${API_BASE}${path}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  return res.json();
}

async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  return res.json();
}

async function apiPatch<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  return res.json();
}

// Validation Config helpers
function getValidationConfigExample(): ValidationConfig {
  return {
    worktreeBase: ".",
    checks: [
      {
        name: "lint",
        cmd: "npm run lint",
        timeoutMs: 60000,
      },
      {
        name: "typecheck",
        cmd: "npm run typecheck",
        timeoutMs: 120000,
      },
      {
        name: "test",
        cmd: "npm test",
        timeoutMs: 1860000,
      },
    ],
    maxConcurrent: 1,
  };
}

function validateValidationConfigJson(): boolean {
  const jsonText = validationConfigJson.value.trim();
  if (!jsonText) {
    showValidationConfigError("Config cannot be empty");
    return false;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    showValidationConfigError(`Invalid JSON: ${(err as Error).message}`);
    return false;
  }

  // Validate against schema
  const validation = validateValidationConfig(parsed);
  if (!validation.valid) {
    showValidationConfigError(validation.error!);
    return false;
  }

  hideValidationConfigError();
  return true;
}

function validateValidationConfig(data: unknown): { valid: boolean; error?: string } {
  if (!data || typeof data !== "object") {
    return { valid: false, error: "Config must be an object" };
  }

  const obj = data as Record<string, unknown>;

  // Check worktreeBase
  if (obj.worktreeBase !== undefined && typeof obj.worktreeBase !== "string") {
    return { valid: false, error: "worktreeBase must be a string" };
  }

  // Check checks array
  if (!obj.checks || !Array.isArray(obj.checks)) {
    return { valid: false, error: "checks must be an array" };
  }

  if (obj.checks.length === 0) {
    return { valid: false, error: "checks array must have at least one check" };
  }

  for (let i = 0; i < obj.checks.length; i++) {
    const check = obj.checks[i];
    if (!check || typeof check !== "object") {
      return { valid: false, error: `checks[${i}] must be an object` };
    }

    const checkObj = check as Record<string, unknown>;

    if (!checkObj.name || typeof checkObj.name !== "string" || checkObj.name.trim() === "") {
      return { valid: false, error: `checks[${i}].name is required and must be a non-empty string` };
    }

    if (!checkObj.cmd || typeof checkObj.cmd !== "string" || checkObj.cmd.trim() === "") {
      return { valid: false, error: `checks[${i}].cmd is required and must be a non-empty string` };
    }

    if (checkObj.timeoutMs !== undefined) {
      if (typeof checkObj.timeoutMs !== "number" || !Number.isInteger(checkObj.timeoutMs) || checkObj.timeoutMs <= 0) {
        return { valid: false, error: `checks[${i}].timeoutMs must be a positive integer` };
      }
    }

    if (checkObj.env !== undefined) {
      if (typeof checkObj.env !== "object" || checkObj.env === null || Array.isArray(checkObj.env)) {
        return { valid: false, error: `checks[${i}].env must be an object` };
      }
      for (const [key, value] of Object.entries(checkObj.env)) {
        if (typeof value !== "string") {
          return { valid: false, error: `checks[${i}].env.${key} must be a string` };
        }
      }
    }
  }

  // Check maxConcurrent
  if (obj.maxConcurrent !== undefined) {
    if (typeof obj.maxConcurrent !== "number" || !Number.isInteger(obj.maxConcurrent) || obj.maxConcurrent <= 0) {
      return { valid: false, error: "maxConcurrent must be a positive integer" };
    }
  }

  return { valid: true };
}

function showValidationConfigError(message: string): void {
  validationConfigError.textContent = message;
  validationConfigError.classList.remove("hidden");
  validationConfigSave.disabled = true;
}

function hideValidationConfigError(): void {
  validationConfigError.classList.add("hidden");
  validationConfigSave.disabled = false;
}

function openValidationConfigModal(repoName: string): void {
  currentRepoForConfig = repoName;
  validationConfigModalTitle.textContent = `Configure Validation: ${repoName}`;
  
  // Set example config
  const example = getValidationConfigExample();
  validationConfigExampleJson.textContent = JSON.stringify(example, null, 2);

  // Fetch existing config
  fetchValidationConfig(repoName);

  validationConfigModal.showModal();
  validationConfigJson.focus();
}

async function fetchValidationConfig(repoName: string): Promise<void> {
  try {
    const repo = await apiGet<Repo>(`/repos/${encodeURIComponent(repoName)}`);
    if (repo.validationConfig) {
      try {
        const parsed = JSON.parse(repo.validationConfig) as ValidationConfig;
        validationConfigJson.value = JSON.stringify(parsed, null, 2);
      } catch {
        validationConfigJson.value = JSON.stringify(getValidationConfigExample(), null, 2);
      }
    } else {
      validationConfigJson.value = JSON.stringify(getValidationConfigExample(), null, 2);
    }
    validateValidationConfigJson();
  } catch (err) {
    console.error("Failed to fetch validation config:", err);
    validationConfigJson.value = JSON.stringify(getValidationConfigExample(), null, 2);
    validateValidationConfigJson();
  }
}

async function saveValidationConfig(): Promise<void> {
  if (!currentRepoForConfig) return;

  if (!validateValidationConfigJson()) {
    return;
  }

  const config = JSON.parse(validationConfigJson.value) as ValidationConfig;

  try {
    await apiPatch<Repo>(`/repos/${encodeURIComponent(currentRepoForConfig)}`, {
      validationConfig: config,
    });
    validationConfigModal.close();
    // Refresh overview to show updated badge
    if (state.currentView === "overview") {
      loadOverview();
    }
  } catch (err) {
    console.error("Failed to save validation config:", err);
    showValidationConfigError(`Failed to save: ${(err as Error).message}`);
  }
}

// Loaders
async function loadRalphInstances(): Promise<void> {
  try {
    const instances =
      await apiGet<
        { id: string; name: string; repo: string; status: string }[]
      >("/ralph/instances");
    for (const inst of instances) {
      ralphInstances.set(inst.id, inst);
    }
  } catch (err) {
    console.error("Failed to load ralph instances:", err);
  }
}

async function loadActiveLocks(): Promise<void> {
  try {
    const locks = await apiGet<
      Array<{
        ticketId: string;
        instanceId: string;
        lockType: "validation" | "processing";
        expiresAt: number;
        instanceName: string;
      }>
    >("/ralph/locks");
    const now = Date.now();
    for (const lock of locks) {
      if (lock.expiresAt > now) {
        activeLocks.set(lock.ticketId, {
          ticketId: lock.ticketId,
          instanceId: lock.instanceId,
          instanceName: lock.instanceName,
          lockType: lock.lockType,
          expiresAt: lock.expiresAt,
        });
      }
    }
  } catch (err) {
    console.error("Failed to load active locks:", err);
  }
}

async function loadRepos(): Promise<void> {
  try {
    const repos = await apiGet<Repo[]>("/repos");
    state.repos = repos;
    updateRepoSelect(repos);
  } catch (err) {
    console.error("Failed to load repos:", err);
  }
}

function updateRepoSelect(repos: Repo[]): void {
  const currentValue = repoSelect.value;
  repoSelect.innerHTML = '<option value="">All Repos</option>';

  for (const repo of repos) {
    const option = document.createElement("option");
    option.value = repo.name;
    option.textContent = repo.name;
    repoSelect.appendChild(option);
  }

  repoSelect.value = currentValue;
}

async function loadOverview(): Promise<void> {
  try {
    const params = new URLSearchParams();
    if (state.currentRepo) params.set("repo", state.currentRepo);

    const tickets = await apiGet<Ticket[]>(`/tickets?${params}&limit=1000`);
    state.tickets = tickets;

    renderOverview(tickets);
  } catch (err) {
    console.error("Failed to load overview:", err);
    repoGrid.innerHTML =
      '<div class="empty-state">Failed to load repositories</div>';
  }
}

function renderOverview(tickets: Ticket[]): void {
  // Group by repo
  const reposMap = new Map<
    string,
    {
      tickets: Ticket[];
      flagged: number;
      statusCounts: Record<string, number>;
      locked: number;
    }
  >();

  for (const ticket of tickets) {
    if (!reposMap.has(ticket.repo)) {
      reposMap.set(ticket.repo, {
        tickets: [],
        flagged: 0,
        statusCounts: {},
        locked: 0,
      });
    }
    const repo = reposMap.get(ticket.repo)!;
    repo.tickets.push(ticket);
    repo.statusCounts[ticket.status] =
      (repo.statusCounts[ticket.status] || 0) + 1;
    if (
      [
        "NEEDS_HUMAN_INTERVENTION",
        "NEEDS_HUMAN_CLARIFICATION",
        "NEEDS_HUMAN_PLAN_REVIEW",
      ].includes(ticket.status)
    ) {
      repo.flagged++;
    }
    if (activeLocks.has(ticket.id)) {
      repo.locked++;
    }
  }

  repoGrid.innerHTML = "";

  if (reposMap.size === 0) {
    repoGrid.innerHTML =
      '<div class="empty-state"><div class="empty-state-icon">📦</div><p>No repositories found</p></div>';
    return;
  }

  for (const [repoName, data] of reposMap) {
    const card = document.createElement("div");
    card.className = "repo-card";
    card.onclick = (e: MouseEvent) => {
      // Don't navigate if clicking on the configure button
      if ((e.target as HTMLElement).closest(".repo-card-actions")) return;
      state.currentRepo = repoName;
      repoSelect.value = repoName;
      switchView("kanban");
    };

    // Find repo config from state.repos
    const repoConfig = state.repos.find((r) => r.name === repoName);
    let hasValidationChecks = false;
    if (repoConfig?.validationConfig) {
      try {
        const config = JSON.parse(repoConfig.validationConfig) as ValidationConfig;
        hasValidationChecks = config.checks && config.checks.length > 0;
      } catch {
        hasValidationChecks = false;
      }
    }

    const statusBadges = Object.entries(data.statusCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(
        ([status, count]) =>
          `<span class="badge badge-${status.toLowerCase()}">${status.replace(/_/g, " ")}: ${count}</span>`,
      )
      .join("");

    card.innerHTML = `
      <div class="repo-card-header">
        <h3>${repoName}</h3>
        ${data.flagged > 0 ? `<span class="flagged-count">⚠ ${data.flagged} flagged</span>` : ""}
        ${data.locked > 0 ? `<span class="in-progress-count">${data.locked} in progress</span>` : ""}
      </div>
      <div class="repo-card-stats">${statusBadges}</div>
      <div class="repo-card-stats">Total tickets: ${data.tickets.length}</div>
      ${!hasValidationChecks ? `<div class="repo-card-stats"><span class="no-validation-badge">No validation checks</span></div>` : ""}
      <div class="repo-card-actions">
        <button class="btn btn-secondary">Configure</button>
      </div>
    `;

    repoGrid.appendChild(card);
  }

  // Event delegation for Configure buttons
  repoGrid.removeEventListener("click", handleRepoGridClick);
  repoGrid.addEventListener("click", handleRepoGridClick);
}

function handleRepoGridClick(e: MouseEvent): void {
  const configureBtn = (e.target as HTMLElement).closest(".repo-card-actions button");
  if (configureBtn) {
    e.stopPropagation();
    const repoCard = configureBtn.closest(".repo-card");
    const repoName = repoCard?.querySelector("h3")?.textContent;
    if (repoName) {
      openValidationConfigModal(repoName);
    }
    return;
  }
}

async function loadKanban(): Promise<void> {
  try {
    const params = new URLSearchParams();
    if (state.currentRepo) params.set("repo", state.currentRepo);
    params.set("limit", "1000");
    params.set("sort", "createdAt:asc");

    const tickets = await apiGet<Ticket[]>(`/tickets?${params}`);
    renderKanban(tickets);
  } catch (err) {
    console.error("Failed to load kanban:", err);
    kanbanBoard.innerHTML =
      '<div class="empty-state">Failed to load Kanban board</div>';
  }
}

const KANBAN_COLUMNS: {
  id: string;
  label: string;
  statuses: TicketStatus[];
}[] = [
  {
    id: "planning",
    label: "Planning",
    statuses: [
      "NEEDS_REFINEMENT",
      "NEEDS_PLAN",
      "READY_PLAN_REVIEW",
      "NEEDS_PLAN_UPDATING",
      "NEEDS_HUMAN_PLAN_REVIEW",
    ],
  },
  {
    id: "implementation",
    label: "Implementation",
    statuses: [
      "NEEDS_IMPLEMENTING",
      "NEEDS_SUBTICKETS_PROCESSED",
      "NEEDS_IMPLEMENTATION_UPDATE",
      "NEEDS_HUMAN_CLARIFICATION",
    ],
  },
  {
    id: "validation",
    label: "Validation & Review",
    statuses: [
      "NEEDS_VALIDATION",
      "NEEDS_REVIEW",
      "NEEDS_SECURITY_REVIEW",
      "NEEDS_QA",
      "NEEDS_HUMAN_INTERVENTION",
    ],
  },
  {
    id: "delivery",
    label: "Delivery",
    statuses: ["NEEDS_PR", "NEEDS_GIT_MERGE", "NEEDS_PR_MAINTENANCE"],
  },
  {
    id: "completion",
    label: "Completion",
    statuses: ["NEEDS_FINALIZING", "NEEDS_CLEANUP", "DONE"],
  },
];

function getColumnForStatus(
  status: TicketStatus,
): { id: string; label: string; statuses: TicketStatus[] } | null {
  return KANBAN_COLUMNS.find((col) => col.statuses.includes(status)) || null;
}

function getStepInColumn(status: TicketStatus): {
  current: number;
  total: number;
} {
  const column = getColumnForStatus(status);
  if (!column) return { current: 0, total: 0 };
  const idx = column.statuses.indexOf(status);
  return { current: idx + 1, total: column.statuses.length };
}

function renderKanban(tickets: Ticket[]): void {
  // Group by column
  const byColumn = new Map<string, Ticket[]>();
  for (const col of KANBAN_COLUMNS) {
    byColumn.set(col.id, []);
  }

  for (const ticket of tickets) {
    const col = getColumnForStatus(ticket.status as TicketStatus);
    if (col) {
      const arr = byColumn.get(col.id) || [];
      arr.push(ticket);
      byColumn.set(col.id, arr);
    }
  }

  kanbanBoard.innerHTML = "";

  for (const col of KANBAN_COLUMNS) {
    const columnTickets = byColumn.get(col.id) || [];

    const column = document.createElement("div");
    column.className = "kanban-column";
    column.dataset.columnId = col.id;

    column.innerHTML = `
      <div class="kanban-column-header">
        <h4>${col.label}</h4>
        <span class="kanban-column-count">${columnTickets.length}</span>
      </div>
      <div class="kanban-cards" data-column="${col.id}"></div>
    `;

    const cardsContainer = column.querySelector(
      ".kanban-cards",
    ) as HTMLDivElement;

    for (const ticket of columnTickets) {
      const step = getStepInColumn(ticket.status as TicketStatus);
      const isFlagged = [
        "NEEDS_HUMAN_INTERVENTION",
        "NEEDS_HUMAN_CLARIFICATION",
        "NEEDS_HUMAN_PLAN_REVIEW",
      ].includes(ticket.status as string);
      const card = createTicketCard(
        ticket,
        isFlagged,
        step.current,
        step.total,
      );
      cardsContainer.appendChild(card);
    }

    kanbanBoard.appendChild(column);
  }
}

function createTicketCard(
  ticket: Ticket,
  isFlagged: boolean,
  stepCurrent: number,
  stepTotal: number,
): HTMLDivElement {
  const card = document.createElement("div");
  card.className = `ticket-card${isFlagged ? " flagged" : ""}`;
  card.onclick = (e: MouseEvent) => {
    e.stopPropagation();
    openDetailPanel(ticket);
  };

  const subtasks = ticket.subtasks ?? [];
  const hasSubtasks = subtasks.length > 0;

  const lock = activeLocks.get(ticket.id);
  const lockHtml = lock
    ? `
    <div class="ticket-card-lock ${lock.lockType}">
      <span>${escapeHtml(lock.instanceName)}</span>
    </div>
  `
    : "";

  const progressPct =
    stepTotal > 0 ? Math.round((stepCurrent / stepTotal) * 100) : 0;
  const progressBar =
    stepTotal > 0
      ? `
    <div class="ticket-card-progress" title="${stepCurrent}/${stepTotal}">
      <div class="ticket-card-progress-fill" style="width: ${progressPct}%"></div>
    </div>
  `
      : "";

  card.innerHTML = `
    ${lockHtml ? `<div class="ticket-card-lock-row">${lockHtml}</div>` : ""}
    <div class="ticket-card-header">
      <span class="ticket-card-title">${escapeHtml(ticket.name)}</span>
      ${hasSubtasks ? `<span class="ticket-card-subtasks">⌘ ${subtasks.length} subtasks</span>` : ""}
    </div>
    <div class="ticket-card-meta">
      <span>🐙 ${escapeHtml(ticket.repo)}</span>
    </div>
    ${ticket.featureBranch ? `<div class="ticket-card-branch">🌿 ${escapeHtml(ticket.featureBranch)}</div>` : ""}
    <div class="ticket-card-status">
        ${escapeHtml(ticket.status.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()))}
      </div>
      ${progressBar}
  `;

  return card;
}

async function loadFlagged(): Promise<void> {
  try {
    const tickets = await apiGet<Ticket[]>(
      "/tickets?flagged=true&limit=1000&sort=createdAt:asc",
    );
    renderFlagged(tickets);
  } catch (err) {
    console.error("Failed to load flagged:", err);
    flaggedList.innerHTML =
      '<div class="empty-state">Failed to load flagged tickets</div>';
  }
}

function renderFlagged(tickets: Ticket[]): void {
  flaggedList.innerHTML = "";

  if (tickets.length === 0) {
    flaggedList.innerHTML =
      '<div class="empty-state"><div class="empty-state-icon">✅</div><p>No flagged tickets</p></div>';
    return;
  }

  for (const ticket of tickets) {
    const item = document.createElement("div");
    item.className = "flagged-item";

    const timeStuck = formatTimeStuck(ticket.updatedAt);
    const reason = getFlaggedReason(ticket.status as TicketStatus);

    item.innerHTML = `
      <div class="flagged-item-info">
        <div class="flagged-item-header">
          <span class="flagged-item-repo">${escapeHtml(ticket.repo)}</span>
          <span class="flagged-item-name">${escapeHtml(ticket.name)}</span>
        </div>
        <div class="flagged-item-reason">${escapeHtml(reason)}</div>
        <div class="flagged-item-time">Stuck for ${timeStuck}</div>
      </div>
      <button class="btn btn-primary" onclick="event.stopPropagation(); openUnblockModal('${ticket.id}', '${escapeHtml(ticket.name)}', '${ticket.status}')">Unblock</button>
    `;

    flaggedList.appendChild(item);
  }
}

function getFlaggedReason(status: TicketStatus): string {
  switch (status) {
    case "NEEDS_HUMAN_INTERVENTION":
      return "Validation failed 3 times";
    case "NEEDS_HUMAN_CLARIFICATION":
      return "Implementation retry exceeded 3 attempts";
    case "NEEDS_HUMAN_PLAN_REVIEW":
      return "Plan iteration threshold exceeded";
    default:
      return "Unknown";
  }
}

function formatTimeStuck(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const hours = Math.floor(diff / 3600000);
  const minutes = Math.floor((diff % 3600000) / 60000);

  if (hours > 24) return `${Math.floor(hours / 24)}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

// Detail Modal
function openDetailPanel(ticket: Ticket): void {
  state.selectedTicket = ticket;
  detailTitle.textContent = ticket.name;
  detailModal.showModal();

  // Load all detail data
  loadTicketDetail(ticket.id);

  // Switch to overview tab
  switchDetailTab("overview");
}

function closeDetailPanel(): void {
  detailModal.close();
  state.selectedTicket = null;
}

async function loadTicketDetail(ticketId: string): Promise<void> {
  try {
    const ticket = await apiGet<Ticket>(
      `/tickets/${ticketId}?include=subtasks`,
    );
    state.selectedTicket = ticket;
    renderAllDetailTabs(ticket);
  } catch (err) {
    console.error("Failed to load ticket detail:", err);
  }
}

function renderAllDetailTabs(ticket: Ticket): void {
  renderDetailTab("overview", ticket);
  renderDetailTab("plan", ticket);
  renderDetailTab("evidence", ticket);
  renderDetailTab("suggestions", ticket);
  renderDetailTab("deviations", ticket);
  renderDetailTab("subtasks", ticket);
  renderDetailTab("validation", ticket);
}

function renderDetailTab(tab: DetailTab, ticket: Ticket): void {
  const section = document.getElementById(`detail-${tab}`);
  if (!section) return;

  switch (tab) {
    case "overview":
      section.innerHTML = renderOverviewTab(ticket);
      break;
    case "plan":
      section.innerHTML = renderPlanTab(ticket);
      break;
    case "evidence":
      section.innerHTML = renderEvidenceTab(ticket);
      break;
    case "suggestions":
      section.innerHTML = renderSuggestionsTab(ticket);
      break;
    case "deviations":
      section.innerHTML = renderDeviationsTab(ticket);
      break;
    case "subtasks":
      section.innerHTML = renderSubtasksTab(ticket);
      break;
    case "validation":
      section.innerHTML = renderValidationTab(ticket);
      break;
  }
}

function renderOverviewTab(ticket: Ticket): string {
  const lock = activeLocks.get(ticket.id);
  const lockHtml = lock
    ? `
    <div id="detail-lock-info" class="lock-indicator ${lock.lockType}">
      <span>Locked by <strong>${escapeHtml(lock.instanceName)}</strong> for <strong>${lock.lockType}</strong></span>
      <span class="lock-expires">Expires: ${formatDate(lock.expiresAt)}</span>
    </div>
  `
    : `<div id="detail-lock-info" class="lock-indicator hidden"></div>`;

  return `
    ${lockHtml}
    <div class="detail-field">
      <div class="detail-field-label">Description</div>
      <div class="detail-field-value">${escapeHtml(ticket.description || "—")}</div>
    </div>
    <div class="detail-field">
      <div class="detail-field-label">Status</div>
      <div class="detail-field-value"><span class="badge badge-${ticket.status.toLowerCase()}">${ticket.status.replace(/_/g, " ")}</span></div>
    </div>
    <div class="detail-field">
      <div class="detail-field-label">ID</div>
      <div class="detail-field-value">${ticket.id}</div>
    </div>
    <div class="detail-field">
      <div class="detail-field-label">Repository</div>
      <div class="detail-field-value">${escapeHtml(ticket.repo)}</div>
    </div>
    <div class="detail-field">
      <div class="detail-field-label">Target Branch</div>
      <div class="detail-field-value">${escapeHtml(ticket.targetBranch || "—")}</div>
    </div>
    <div class="detail-field">
      <div class="detail-field-label">Feature Branch</div>
      <div class="detail-field-value">${escapeHtml(ticket.featureBranch || "—")}</div>
    </div>
    <div class="detail-field">
      <div class="detail-field-label">Worktree</div>
      <div class="detail-field-value">${escapeHtml(ticket.worktreeDir || "—")}</div>
    </div>
    <div class="detail-field">
      <div class="detail-field-label">Counters</div>
      <div class="detail-field-value">
        Validation Attempts: ${ticket.validationAttempts}<br>
        Impl Retries: ${ticket.implementationRetryCount}<br>
        Plan Iterations: ${ticket.planIteration}
      </div>
    </div>
    <div class="detail-field">
      <div class="detail-field-label">Created</div>
      <div class="detail-field-value">${formatDate(ticket.createdAt)}</div>
    </div>
    <div class="detail-field">
      <div class="detail-field-label">Updated</div>
      <div class="detail-field-value">${formatDate(ticket.updatedAt)}</div>
    </div>
  `;
}

function renderPlanTab(ticket: Ticket): string {
  const planHtml = ticket.plan ? marked.parse(ticket.plan) : '<em class="empty-text">No plan yet</em>';
  const planIssuesHtml = ticket.planIssues ? marked.parse(ticket.planIssues) : '<em class="empty-text">None</em>';
  const blockingIssuesHtml = ticket.blockingIssues ? marked.parse(ticket.blockingIssues) : '<em class="empty-text">None</em>';
  const reviewCommentsHtml = ticket.reviewComments ? marked.parse(ticket.reviewComments) : '<em class="empty-text">None</em>';
  const securityNotesHtml = ticket.securityNotes ? marked.parse(ticket.securityNotes) : '<em class="empty-text">None</em>';
  const qaNotesHtml = ticket.qaNotes ? marked.parse(ticket.qaNotes) : '<em class="empty-text">None</em>';

  return `
    <div class="detail-field markdown-field">
      <div class="detail-field-label">Plan</div>
      <div class="detail-field-value markdown-content">${planHtml}</div>
    </div>
    <div class="detail-field markdown-field">
      <div class="detail-field-label">Plan Issues</div>
      <div class="detail-field-value markdown-content">${planIssuesHtml}</div>
    </div>
    <div class="detail-field markdown-field">
      <div class="detail-field-label">Blocking Issues</div>
      <div class="detail-field-value markdown-content">${blockingIssuesHtml}</div>
    </div>
    <div class="detail-field markdown-field">
      <div class="detail-field-label">Review Comments</div>
      <div class="detail-field-value markdown-content">${reviewCommentsHtml}</div>
    </div>
    <div class="detail-field markdown-field">
      <div class="detail-field-label">Security Notes</div>
      <div class="detail-field-value markdown-content">${securityNotesHtml}</div>
    </div>
    <div class="detail-field markdown-field">
      <div class="detail-field-label">QA Notes</div>
      <div class="detail-field-value markdown-content">${qaNotesHtml}</div>
    </div>
  `;
}

function renderEvidenceTab(ticket: Ticket): string {
  const evidence = ticket.evidence || [];

  if (evidence.length === 0) {
    return '<div class="empty-state"><p>No evidence</p></div>';
  }

  const sources = [...new Set(evidence.map(e => e.source))];
  const hasValidation = sources.includes('validation');

  return `
    <div class="evidence-filters">
      <label>Source:
        <select id="evidence-source-filter">
          <option value="">All</option>
          ${sources.map(s => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join('')}
        </select>
      </label>
      ${hasValidation ? `
        <label>Validation:
        <select id="evidence-passed-filter">
          <option value="">All</option>
          <option value="true">Passed</option>
          <option value="false">Failed</option>
        </select>
      </label>` : ''}
    </div>
    <div class="detail-list" id="evidence-list">
      ${evidence
        .map(
          (e: Evidence) => `
        <div class="detail-list-item" data-source="${escapeHtml(e.source)}" data-passed="${e.passed !== undefined ? String(e.passed) : ''}">
          <div class="detail-list-item-header">
            <span class="detail-list-item-title">${escapeHtml(e.filePath || 'inline')}</span>
            <span class="detail-list-item-source">${escapeHtml(e.source)} / ${escapeHtml(e.type)}</span>
            ${e.passed !== undefined ? `
              <span class="badge badge-${e.passed ? 'pass' : 'fail'}">${e.passed ? 'PASS' : 'FAIL'}</span>
            ` : ''}
          </div>
          <div class="detail-list-item-desc">${escapeHtml(e.contentType)}</div>
        </div>
      `,
        )
        .join("")}
    </div>
    <script>
      (function() {
        const sourceFilter = document.getElementById('evidence-source-filter');
        const passedFilter = document.getElementById('evidence-passed-filter');
        const list = document.getElementById('evidence-list');
        if (!list) return;
        const items = list.querySelectorAll('.detail-list-item');
        function filter() {
          const src = sourceFilter?.value || '';
          const p = passedFilter?.value || '';
          items.forEach(item => {
            const matchSrc = !src || item.dataset.source === src;
            const matchPassed = !p || item.dataset.passed === p;
            item.style.display = (matchSrc && matchPassed) ? '' : 'none';
          });
        }
        sourceFilter?.addEventListener('change', filter);
        passedFilter?.addEventListener('change', filter);
      })();
    </script>
  `;
}

function renderSuggestionsTab(ticket: Ticket): string {
  const suggestions = ticket.suggestions || [];

  if (suggestions.length === 0) {
    return '<div class="empty-state"><p>No suggestions</p></div>';
  }

  return `
    <div class="detail-list">
      ${suggestions
        .map(
          (s: Suggestion) => `
        <div class="detail-list-item">
          <div class="detail-list-item-header">
            <span class="detail-list-item-title">${escapeHtml(s.description)}</span>
            <span class="detail-list-item-source">${escapeHtml(s.source)}${s.resolved ? " ✓" : ""}</span>
          </div>
        </div>
      `,
        )
        .join("")}
    </div>
  `;
}

function renderDeviationsTab(ticket: Ticket): string {
  const deviations = ticket.deviations || [];

  if (deviations.length === 0) {
    return '<div class="empty-state"><p>No deviations</p></div>';
  }

  return `
    <div class="detail-list">
      ${deviations
        .map(
          (d: Deviation) => `
        <div class="detail-list-item">
          <div class="detail-list-item-header">
            <span class="detail-list-item-title">${escapeHtml(d.action)}: ${escapeHtml(d.description)}</span>
            <span class="detail-list-item-source">Review: ${d.reviewApproved ? "✓" : "✗"} | QA: ${d.qaApproved ? "✗" : "✗"}</span>
          </div>
        </div>
      `,
        )
        .join("")}
    </div>
  `;
}

function renderSubtasksTab(ticket: Ticket): string {
  const subtasks = ticket.subtasks || [];

  if (subtasks.length === 0) {
    return '<div class="empty-state"><p>No subtasks</p></div>';
  }

  return `
    <div class="detail-list">
      ${subtasks
        .map(
          (st: Ticket) => `
        <div class="detail-list-item subtask-clickable" data-subtask-id="${st.id}" style="cursor: pointer;">
          <div class="detail-list-item-header">
            <span class="detail-list-item-title">${escapeHtml(st.name)}</span>
            <span class="badge badge-${st.status.toLowerCase()}">${st.status.replace(/_/g, " ")}</span>
          </div>
        </div>
      `,
        )
        .join("")}
    </div>
  `;
}

function renderValidationTab(ticket: Ticket): string {
  const runs = (ticket.validationRuns || []) as ValidationRunWithDuration[];
  const evidence = ticket.evidence || [];

  if (runs.length === 0) {
    return '<div class="empty-state"><p>No validation runs</p></div>';
  }

  // Map evidenceId to evidence for quick lookup
  const evidenceById = new Map(evidence.map(e => [e.id, e]));

  return `
    <div class="validation-filters">
      <label>Show:
        <select id="validation-result-filter">
          <option value="">All</option>
          <option value="true">Passed</option>
          <option value="false">Failed</option>
        </select>
      </label>
    </div>
    <table class="validation-table">
      <thead>
        <tr>
          <th>Check</th>
          <th>Result</th>
          <th>Exit Code</th>
          <th>Duration</th>
          <th>Time</th>
          <th>Evidence</th>
        </tr>
      </thead>
      <tbody id="validation-rows">
        ${runs
          .map(
            (r: ValidationRunWithDuration) => {
              const ev = r.evidenceId ? evidenceById.get(r.evidenceId) : null;
              return `
          <tr data-passed="${r.passed ? 'true' : 'false'}">
            <td>${escapeHtml(r.checkName)}</td>
            <td class="${r.passed ? "pass" : "fail"}">${r.passed ? "PASS" : "FAIL"}</td>
            <td>${r.exitCode}</td>
            <td>${r.durationMs ? r.durationMs + "ms" : "—"}</td>
            <td>${formatDate(r.createdAt)}</td>
            <td>
              ${ev ? `
                <button class="btn btn-sm" onclick="showEvidenceModal('${escapeHtml(ev.id)}')">View</button>
                ${ev.passed !== undefined ? `<span class="badge badge-${ev.passed ? 'pass' : 'fail'}">${ev.passed ? 'PASS' : 'FAIL'}</span>` : ''}
              ` : '—'}
            </td>
          </tr>
        `;
            })
          .join("")}
      </tbody>
    </table>
    <script>
      (function() {
        const filter = document.getElementById('validation-result-filter');
        const rows = document.querySelectorAll('#validation-rows tr');
        filter?.addEventListener('change', () => {
          const val = filter.value;
          rows.forEach(row => {
            row.style.display = (!val || row.dataset.passed === val) ? '' : 'none';
          });
        });
      })();
    </script>
  `;
}

// Unblock Modal
function openUnblockModal(
  ticketId: string,
  ticketName: string,
  status: TicketStatus,
): void {
  const reason = getFlaggedReason(status);
  unblockMessage.textContent = `Ticket "${ticketName}" is flagged: ${reason}. Choose direction:`;
  unblockModal.dataset.ticketId = ticketId;
  unblockModal.dataset.status = status;
  unblockModal.showModal();
}

unblockModal.addEventListener("close", async () => {
  const direction = unblockModal.returnValue;
  if (direction === "back" || direction === "forward") {
    const ticketId = unblockModal.dataset.ticketId;
    try {
      await apiPost(`/tickets/${ticketId}/unblock`, { direction });
      closeDetailPanel();
      if (state.currentView === "flagged") loadFlagged();
      else if (state.currentView === "kanban") loadKanban();
    } catch (err) {
      console.error("Unblock failed:", err);
      alert("Failed to unblock ticket: " + (err as Error).message);
    }
  }
});

// Evidence Modal
async function showEvidenceModal(evidenceId: string): Promise<void> {
  evidenceModalTitle.textContent = "Loading...";
  evidenceModalContent.innerHTML = '<div class="loading">Loading evidence...</div>';
  evidenceModal.showModal();

  try {
    const evidence = await apiGet<Evidence>(`/evidence/${evidenceId}`);
    evidenceModalTitle.textContent = evidence.filePath || 'Inline Evidence';
    
    const passedBadge = evidence.passed !== undefined 
      ? `<span class="badge badge-${evidence.passed ? 'pass' : 'fail'}">${evidence.passed ? 'PASS' : 'FAIL'}</span>`
      : '';
    
    const contentDisplay = evidence.contentType?.startsWith('image/')
      ? `<img src="/api/v1/evidence/${evidence.id}" alt="Evidence" style="max-width: 100%; max-height: 500px;">`
      : `<pre style="white-space: pre-wrap; max-height: 500px; overflow: auto;">${escapeHtml(evidence.content || '')}</pre>`;
    
    evidenceModalContent.innerHTML = `
      <div class="evidence-modal-field">
        <label>Source</label>
        <div>${escapeHtml(evidence.source)}</div>
      </div>
      <div class="evidence-modal-field">
        <label>Type</label>
        <div>${escapeHtml(evidence.type)} ${passedBadge}</div>
      </div>
      <div class="evidence-modal-field">
        <label>Content Type</label>
        <div>${escapeHtml(evidence.contentType)}</div>
      </div>
      <div class="evidence-modal-field">
        <label>Created</label>
        <div>${formatDate(evidence.createdAt)}</div>
      </div>
      <div class="evidence-modal-field">
        <label>Content</label>
        <div>${contentDisplay}</div>
      </div>
    `;
  } catch (err) {
    evidenceModalContent.innerHTML = `<div class="error">Failed to load evidence: ${(err as Error).message}</div>`;
  }
}

evidenceModal.addEventListener("close", () => {
  evidenceModalContent.innerHTML = "";
});

// Utilities
function escapeHtml(text: string | null | undefined): string {
  if (!text) return "";
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

function formatDate(timestamp: number | null | undefined): string {
  if (!timestamp) return "—";
  return new Date(timestamp).toLocaleString();
}

