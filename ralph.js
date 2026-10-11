const { spawn } = require("child_process"); // keep this as CommonJS for compatibility

const PRD_SERVER_URL = process.env.PRD_SERVER_URL || "http://localhost:42069";
const REPO_NAME = process.argv[2];

if (!REPO_NAME) {
  console.error("Usage: node ralph.js <repo-name>");
  process.exit(1);
}

const POLL_INTERVAL_MS = 5000;
const HEARTBEAT_INTERVAL_MS = 15000;
const COOLDOWN_BASE_MS = 1000;
const MAX_COOLDOWN_MS = 60000;
const LOCK_TTL_MS = 300000;
const MAX_OUTPUT_SIZE = 10 * 1024 * 1024;

let currentChild = null;
let shuttingDown = false;
let ralphInstance = null;
let heartbeatInterval = null;

const ticketCooldowns = new Map();

function formatEnvVar(name) {
  return process.platform === "win32" ? `%${name}%` : `$${name}`;
}

function killProcessTree(child) {
  const pid = child.pid;
  if (!pid) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/T", "/F", "/PID", String(pid)], { stdio: "ignore" });
  } else {
    try {
      process.kill(-pid, "SIGTERM");
    } catch (e) {}
  }
}

function runAndCapture(cmd, envVars = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalSize = 0;
    let truncated = false;
    const child = spawn(cmd, [], {
      stdio: ["inherit", "pipe", "pipe"],
      shell: true,
      env: { ...process.env, ...envVars },
    });
    currentChild = child;

    const dataHandler = (d) => {
      totalSize += d.length;
      if (totalSize > MAX_OUTPUT_SIZE) {
        if (!truncated) {
          chunks.push(
            Buffer.from(
              `\n--- OUTPUT TRUNCATED at ${MAX_OUTPUT_SIZE} bytes ---\n`,
            ),
          );
          truncated = true;
          killProcessTree(child);
        }
        return;
      }
      chunks.push(d);
    };
    child.stdout.on("data", dataHandler);
    child.stderr.on("data", dataHandler);

    const timeout = setTimeout(() => {
      killProcessTree(child);
      resolve({ code: null, output: "TIMED OUT after 300s" });
    }, 300000);

    child.on("close", (code) => {
      clearTimeout(timeout);
      if (currentChild === child) currentChild = null;
      const output = Buffer.concat(chunks).toString("utf-8");
      resolve({ code, output });
    });
    child.on("error", (err) => {
      clearTimeout(timeout);
      if (currentChild === child) currentChild = null;
      reject(err);
    });
  });
}

async function fetchWithRetry(url, options = {}, retries = 3, backoff = 1000) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, options);
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`HTTP ${res.status}: ${text}`);
      }
      return res.json();
    } catch (err) {
      if (i === retries - 1) throw err;
      await new Promise((r) => setTimeout(r, backoff * (i + 1)));
    }
  }
}

async function registerRalph() {
  const res = await fetchWithRetry(`${PRD_SERVER_URL}/api/v1/ralph/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ repo: REPO_NAME }),
  });
  ralphInstance = res;
  console.log(
    `[${REPO_NAME}] Registered as ${ralphInstance.name} (${ralphInstance.id})`,
  );
  return ralphInstance;
}

async function sendHeartbeat() {
  if (!ralphInstance) return;
  try {
    await fetchWithRetry(
      `${PRD_SERVER_URL}/api/v1/ralph/heartbeat`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instanceId: ralphInstance.id }),
      },
      1,
    );
  } catch (err) {
    console.error(`[${ralphInstance?.name}] Heartbeat failed:`, err.message);
  }
}

async function acquireLock(ticketId, lockType) {
  if (!ralphInstance) throw new Error("Not registered");
  const res = await fetchWithRetry(
    `${PRD_SERVER_URL}/api/v1/ralph/lock/acquire`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        instanceId: ralphInstance.id,
        ticketId,
        lockType,
        ttlMs: LOCK_TTL_MS,
      }),
    },
  );
  return res.acquired;
}

async function releaseLock(ticketId) {
  if (!ralphInstance) return;
  try {
    await fetchWithRetry(
      `${PRD_SERVER_URL}/api/v1/ralph/lock/release`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          instanceId: ralphInstance.id,
          ticketId,
        }),
      },
      1,
    );
  } catch (err) {
    console.error(
      `[${ralphInstance.name}] Failed to release lock for ${ticketId}:`,
      err.message,
    );
  }
}

async function findTicketsNeedingValidation() {
  const url = `${PRD_SERVER_URL}/api/v1/tickets?repo=${encodeURIComponent(REPO_NAME)}&status=NEEDS_VALIDATION&parentOnly=true`;
  return fetchWithRetry(url);
}

async function findSubtasksNeedingValidation(parentTicketId) {
  const url = `${PRD_SERVER_URL}/api/v1/tickets?repo=${encodeURIComponent(REPO_NAME)}&status=NEEDS_VALIDATION&parentId=${parentTicketId}`;
  return fetchWithRetry(url);
}

async function findTicketsNeedingProcessing() {
  const statuses = [
    "CREATE",
    "NEEDS_REFINEMENT",
    "NEEDS_PLAN",
    "READY_PLAN_REVIEW",
    "NEEDS_PLAN_UPDATING",
    "NEEDS_IMPLEMENTING",
    "NEEDS_SUBTICKETS_PROCESSED",
    "NEEDS_IMPLEMENTATION_UPDATE",
    "NEEDS_REVIEW",
    "NEEDS_SECURITY_REVIEW",
    "NEEDS_QA",
    "NEEDS_PR",
    "NEEDS_GIT_MERGE",
    "NEEDS_PR_MAINTENANCE",
    "NEEDS_FINALIZING",
    "NEEDS_CLEANUP",
  ].join(",");
  const url = `${PRD_SERVER_URL}/api/v1/tickets?repo=${encodeURIComponent(REPO_NAME)}&status=${statuses}&parentOnly=true`;
  return fetchWithRetry(url);
}

async function getValidationConfig(ticket) {
  const url = `${PRD_SERVER_URL}/api/v1/repos/${encodeURIComponent(REPO_NAME)}/validate`;
  return fetchWithRetry(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ticketId: ticket.id }),
  });
}

async function uploadEvidence(ticketId, evidence) {
  const url = `${PRD_SERVER_URL}/api/v1/tickets/${ticketId}/evidence`;
  return fetchWithRetry(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(evidence),
  });
}

async function submitValidationResults(ticketId, runId, results) {
  const url = `${PRD_SERVER_URL}/api/v1/tickets/${ticketId}/validation-results`;
  return fetchWithRetry(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ runId, results }),
  });
}

async function runValidationLocally(ticket, config) {
  const results = [];

  for (const check of config.checks) {
    const startTime = Date.now();
    const cmd = check.cmd.replace("{worktree}", ticket.worktreeDir);

    try {
      const { stdout, stderr, exitCode } = await runAndCapture(cmd, {
        WORKTREE_DIR: ticket.worktreeDir,
        ...check.env,
      });

      const evidence = await uploadEvidence(ticket.id, {
        contentType: "text/plain",
        source: "validation",
        type: "build_output",
        content: stdout + stderr,
      });

      results.push({
        checkName: check.name,
        passed: exitCode === 0,
        evidenceId: evidence.id,
        stdout,
        stderr,
        exitCode,
        durationMs: Date.now() - startTime,
      });
    } catch (err) {
      const evidence = await uploadEvidence(ticket.id, {
        contentType: "text/plain",
        source: "validation",
        type: "build_output",
        content: `Error: ${err.message}`,
      });

      results.push({
        checkName: check.name,
        passed: false,
        evidenceId: evidence.id,
        stdout: "",
        stderr: err.message,
        exitCode: -1,
        durationMs: Date.now() - startTime,
      });
    }
  }

  return results;
}

function getCooldown(ticketId) {
  return ticketCooldowns.get(ticketId) || 0;
}

function setCooldown(ticketId, ms) {
  ticketCooldowns.set(ticketId, Date.now() + ms);
}

function shouldProcess(ticketId) {
  return Date.now() >= getCooldown(ticketId);
}

async function processTicket(ticket) {
  if (!shouldProcess(ticket.id)) return false;

  console.log(
    `[${ralphInstance.name}] Validating ticket ${ticket.id} (${ticket.name})`,
  );

  const acquired = await acquireLock(ticket.id, "validation");
  if (!acquired) {
    console.log(
      `[${ralphInstance.name}] Could not acquire validation lock for ${ticket.id}`,
    );
    return false;
  }

  try {
    const { runId, config } = await getValidationConfig(ticket);
    const results = await runValidationLocally(ticket, config);
    await submitValidationResults(ticket.id, runId, results);

    console.log(
      `[${ralphInstance.name}] Validation submitted for ${ticket.id}`,
    );
    setCooldown(ticket.id, COOLDOWN_BASE_MS);
    return true;
  } catch (err) {
    console.error(
      `[${ralphInstance.name}] Validation failed for ${ticket.id}:`,
      err.message,
    );
    const current = getCooldown(ticket.id) - Date.now();
    setCooldown(
      ticket.id,
      Math.min(current * 2 || COOLDOWN_BASE_MS, MAX_COOLDOWN_MS),
    );
    return false;
  } finally {
    await releaseLock(ticket.id);
  }
}

async function processTicketWithAgent(ticket) {
  if (!shouldProcess(ticket.id)) return false;

  const acquired = await acquireLock(ticket.id, "processing");
  if (!acquired) {
    console.log(
      `[${ralphInstance.name}] Could not acquire processing lock for ${ticket.id}`,
    );
    return false;
  }

  try {
    const prdIdRef = formatEnvVar("RALPH_PRD_ID");
    const repoNameRef = formatEnvVar("RALPH_REPO_NAME");
    const cmd = `opencode --agent "Scrum Master" run "process ticket -- id - ${prdIdRef} repo - ${repoNameRef}" --pure true`;
    const startTime = Date.now();
    console.log(
      `\n--- Processing: ${ticket.id} - ${ticket.name} (${ticket.status}) ---`,
    );
    console.log(`Running: ${cmd}\n`);

    await runAsync(cmd, {
      RALPH_PRD_ID: ticket.id,
      RALPH_REPO_NAME: REPO_NAME,
    });

    console.log(
      `[ralph] Processed ${ticket.id} in ${((Date.now() - startTime) / 1000).toFixed(1)}s (${ticket.status})`,
    );
    setCooldown(ticket.id, COOLDOWN_BASE_MS);
    return true;
  } catch (err) {
    console.error(`Command failed for ${ticket.id}: ${err.message}`);
    const current = getCooldown(ticket.id) - Date.now();
    setCooldown(
      ticket.id,
      Math.min(current * 2 || COOLDOWN_BASE_MS, MAX_COOLDOWN_MS),
    );
    return false;
  } finally {
    await releaseLock(ticket.id);
  }
}

function runAsync(cmd, envVars = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, [], {
      stdio: "inherit",
      shell: true,
      env: { ...process.env, ...envVars },
    });
    currentChild = child;

    const timeout = setTimeout(() => {
      killProcessTree(child);
      reject(new Error("TIMED OUT after 300s"));
    }, 300000);

    child.on("close", (code) => {
      clearTimeout(timeout);
      if (currentChild === child) currentChild = null;
      if (code === 0) resolve();
      else reject(new Error(`Exited with code ${code}`));
    });
    child.on("error", (err) => {
      clearTimeout(timeout);
      if (currentChild === child) currentChild = null;
      reject(err);
    });
  });
}

async function cleanup() {
  if (heartbeatInterval) clearInterval(heartbeatInterval);
  if (currentChild) killProcessTree(currentChild);
  if (ralphInstance) {
    try {
      await fetch(
        `${PRD_SERVER_URL}/api/v1/ralph/instances/${ralphInstance.id}`,
        { method: "DELETE" },
      );
    } catch (e) {}
  }
}

function setupShutdownHandlers() {
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[ralph] Received ${signal} — shutting down gracefully...`);
    cleanup().then(() => process.exit(process.exitCode || 0));
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("unhandledRejection", (err) => {
    console.error(`[ralph] Unhandled rejection: ${err.message}`);
    process.exitCode = 1;
    shutdown("unhandledRejection");
  });
}

async function mainLoop() {
  await registerRalph();

  heartbeatInterval = setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS);

  console.log(
    `[${ralphInstance.name}] Ralph daemon started, polling ${PRD_SERVER_URL}`,
  );

  while (!shuttingDown) {
    try {
      // First: handle validation for tickets/subtasks in NEEDS_VALIDATION
      const parents = await findTicketsNeedingValidation();
      for (const parent of parents) {
        if (parent.subtasks && parent.subtasks.length > 0) {
          const subtasks = await findSubtasksNeedingValidation(parent.id);
          for (const subtask of subtasks) {
            if (await processTicket(subtask)) break;
          }
        } else {
          await processTicket(parent);
        }
      }

      // Second: process tickets through their lifecycle via opencode agent
      const processingTickets = await findTicketsNeedingProcessing();
      processingTickets.sort(() => Math.random() - 0.5);
      for (const ticket of processingTickets) {
        // Skip if ticket has subtasks that aren't done yet
        if (
          ticket.subtasks &&
          ticket.subtasks.some((s) => s.status !== "DONE")
        ) {
          continue;
        }
        if (await processTicketWithAgent(ticket)) break; // One at a time
      }
    } catch (err) {
      console.error(`[${ralphInstance?.name}] Poll error:`, err.message);
    } finally {
      console.log(`[${ralphInstance?.name}] Poll cycle complete.`);
    }

    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }

  console.log(`[${ralphInstance?.name}] Shutting down...`);
  await cleanup();
}

setupShutdownHandlers();
mainLoop().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
