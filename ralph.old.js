const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const crypto = require("crypto");

const PRDS_DIR = path.join(__dirname, "prds");
const VALIDATION_CONFIG_PATH = path.join(__dirname, "validation-commands.json");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const MAX_OUTPUT_SIZE = 10 * 1024 * 1024; // 10 MB

let currentChild = null;
let shuttingDown = false;

/**
 * Returns a platform-appropriate environment variable reference.
 * On Windows (cmd.exe): %VARNAME%
 * On Unix (sh/bash/zsh): $VARNAME
 */
function formatEnvVar(name) {
  return process.platform === "win32" ? `%${name}%` : `$${name}`;
}

/**
 * Kills a child process and its entire process tree.
 * On Windows: uses taskkill /T /F to force-kill the full tree.
 * On Unix: kills the process group by sending SIGTERM to -pid.
 */
function killProcessTree(child) {
  const pid = child.pid;
  if (!pid) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/T", "/F", "/PID", String(pid)], { stdio: "ignore" });
  } else {
    try {
      // Negative PID kills the process group on Unix
      process.kill(-pid, "SIGTERM");
    } catch (e) {
      // Process may already be dead — ignore
    }
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

const ticketStatusTracker = new Map();

function loadValidationConfig() {
  try {
    const data = fs.readFileSync(VALIDATION_CONFIG_PATH, "utf-8");
    return JSON.parse(data);
  } catch {
    return {};
  }
}

function loadTicket(id, gitRepo) {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error(`Invalid ticket id: "${id}"`);
  if (!/^[a-zA-Z0-9_-]+$/.test(gitRepo)) throw new Error(`Invalid git repo: "${gitRepo}". Must contain only alphanumeric characters, hyphens, and underscores.`);
  const prdPath = path.join(PRDS_DIR, `${gitRepo}__${id}.json`);
  if (!fs.existsSync(prdPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(prdPath, "utf-8"));
  } catch (err) {
    throw new Error(
      `Failed to parse ticket "${gitRepo}__${id}.json": ${err.message}`,
    );
  }
}

function saveTicket(ticket, gitRepo) {
  if (!/^[a-zA-Z0-9_-]+$/.test(ticket.id)) throw new Error(`Invalid ticket id: "${ticket.id}"`);
  if (!/^[a-zA-Z0-9_-]+$/.test(gitRepo)) throw new Error(`Invalid git repo: "${gitRepo}". Must contain only alphanumeric characters, hyphens, and underscores.`);
  const prdPath = path.join(PRDS_DIR, `${gitRepo}__${ticket.id}.json`);
  fs.writeFileSync(prdPath, JSON.stringify(ticket, null, 2), "utf-8");
}

/**
 * Verifies that a resolved path is within the PRDS_DIR/evidence/ directory.
 * Throws on path traversal attempts.
 */
function assertPathWithinEvidence(resolved) {
  const evidenceRoot = path.resolve(path.join(PRDS_DIR, "evidence"));
  const target = path.resolve(resolved);
  if (!target.startsWith(evidenceRoot + path.sep) && target !== evidenceRoot) {
    throw new Error(
      `Path traversal denied: ${target} is outside ${evidenceRoot}`,
    );
  }
}

async function validateTicket(ticket, parentTicket) {
  const _vtStart = Date.now();
  const config = loadValidationConfig();
  const gitRepo = ticket.gitRepo;
  const repoConfig = config[gitRepo];

  if (!repoConfig || !repoConfig.checks || repoConfig.checks.length === 0) {
    console.log(
      `[ralph] No validation checks for "${gitRepo}" — adding suggestion and advancing`,
    );
    if (!ticket.suggestions) ticket.suggestions = [];
    ticket.suggestions.push({
      suggestionId: crypto.randomUUID(),
      message: `No validation commands configured for repo "${gitRepo}". Mechanical checks (lint, type-check, tests) were not run before review.`,
      source: "implementation",
      createdAt: new Date().toISOString(),
    });
    ticket.status = "Needs Review";
    if (!parentTicket) saveTicket(ticket, gitRepo);
    return;
  }

  const worktreeBase = repoConfig.worktreeBase || process.cwd();
  const worktreeAbs = path.resolve(worktreeBase, ticket.worktreeDir || ".");
  console.log(
    `[ralph] Validating ${ticket.id} — ${repoConfig.checks.length} check(s) in ${worktreeAbs}`,
  );

  const results = [];
  for (const check of repoConfig.checks) {
    // Pass worktree path as environment variable instead of shell escaping
    const cmd = check.cmd.replace(/\{worktree\}/g, formatEnvVar("WORKTREE_DIR"));
    console.log(`[ralph]   ${check.name}: ${cmd}`);
    const { code, output } = await runAndCapture(cmd, {
      WORKTREE_DIR: worktreeAbs,
    });
    results.push({ ...check, code, output, passed: code === 0 });
  }

  if (!ticket.evidence) ticket.evidence = [];
  const evDir = path.join(PRDS_DIR, "evidence", `${gitRepo}__${ticket.id}`);

  // Path containment check for evidence directory
  try {
    assertPathWithinEvidence(evDir);
  } catch (err) {
    console.error(
      `[ralph] ${err.message} — skipping evidence write for ${ticket.id}`,
    );
    ticket.status = "Needs Human Intervention";
    if (!parentTicket) saveTicket(ticket, gitRepo);
    return;
  }

  if (!fs.existsSync(evDir)) fs.mkdirSync(evDir, { recursive: true });

  const allPassed = results.every((r) => r.passed);

  for (const result of results) {
    const evidenceId = crypto.randomUUID();
    const slug =
      result.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 60) || "validation";
    const destFile = `${slug}__${evidenceId}.txt`;
    const destPath = path.join(evDir, destFile);
    const header = `Command: ${result.cmd}\nExit Code: ${result.code}\n\n`;
    fs.writeFileSync(destPath, header + result.output, "utf-8");

    const evidenceType = result.name.toLowerCase().includes("test")
      ? "test_output"
      : "build_output";
    ticket.evidence.push({
      evidenceId,
      description: `${result.name}: exit code ${result.code}`,
      type: evidenceType,
      source: "implementation",
      filePath: path.join("evidence", `${gitRepo}__${ticket.id}`, destFile),
      contentType: "text/plain",
      createdAt: new Date().toISOString(),
    });
  }

  if (allPassed) {
    ticket.status = "Needs Review";
    // Reset validation attempts counter on success
    ticket.validationAttempts = 0;
    console.log(
      `[ralph] All ${results.length} check(s) passed — set to Needs Review`,
    );
  } else {
    // Circuit breaker — escalate after 3 consecutive validation failures
    ticket.validationAttempts = (ticket.validationAttempts || 0) + 1;
    if (ticket.validationAttempts >= 3) {
      ticket.status = "Needs Human Intervention";
      delete ticket.validationAttempts;
      if (!ticket.suggestions) ticket.suggestions = [];
      ticket.suggestions.push({
        suggestionId: crypto.randomUUID(),
        message: `Validation failed 3 consecutive times — automated checks keep failing. Manual review required.`,
        source: "implementation",
        createdAt: new Date().toISOString(),
      });
      console.log(
        `[ralph] Validation failed 3 consecutive times — escalating to human`,
      );
    } else {
      const failed = results.filter((r) => !r.passed);
      ticket.reviewComments = failed.map(
        (r) =>
          `[Validation] ${r.name} failed (exit code ${r.code}). See evidence for details.`,
      );
      ticket.status = "Needs Implementation Update";
      console.log(
        `[ralph] ${failed.length}/${results.length} failed — set to Needs Implementation Update with review comments`,
      );
    }
  }

  if (!parentTicket) saveTicket(ticket, gitRepo);
  console.log(`[ralph] Validated ${ticket.id} in ${((Date.now() - _vtStart) / 1000).toFixed(1)}s`);
}

async function validateSubtask(parentTicket, subtask) {
  const subtaskTicket = {
    ...subtask,
    gitRepo: parentTicket.gitRepo,
  };

  await validateTicket(subtaskTicket, parentTicket);

  const parent = loadTicket(parentTicket.id, parentTicket.gitRepo);
  const idx = parent.subtasks.findIndex((s) => s.id === subtask.id);
  if (idx === -1) {
    console.error(
      `[ralph] Subtask ${subtask.id} not found in parent ${parentTicket.id} — skipping`,
    );
    return;
  }

  parent.subtasks[idx].status = subtaskTicket.status;
  parent.subtasks[idx].reviewComments = subtaskTicket.reviewComments;
  parent.subtasks[idx].evidence = subtaskTicket.evidence;
  if (subtaskTicket.suggestions) {
    parent.subtasks[idx].suggestions = subtaskTicket.suggestions;
  }
  saveTicket(parent, parentTicket.gitRepo);

  if (subtaskTicket.status === "Needs Human Intervention") {
    console.error(`[ralph] ⚠️ Subtask ${subtask.id} (${subtask.name}) requires human intervention — parent ticket ${parentTicket.id} will be blocked until resolved.`);
  }
}

async function findAndProcess(repoName) {
  let files;
  try {
    files = fs.readdirSync(PRDS_DIR).filter((f) => f.endsWith(".json"));
  } catch {
    console.error(`Cannot read PRDs directory: ${PRDS_DIR}`);
    process.exit(1);
  }

  const candidates = [];
  for (const file of files) {
    // Try-catch around JSON.parse to handle corrupt files
    try {
      const content = JSON.parse(
        fs.readFileSync(path.join(PRDS_DIR, file), "utf-8"),
      );
      if (content.gitRepo === repoName) {
        candidates.push(content);
      }
    } catch (err) {
      console.error(
        `[ralph] Skipping corrupt ticket file: ${file} — ${err.message}`,
      );
      continue;
    }
  }

  if (candidates.length === 0) {
    return null;
  }

  const prds = candidates.filter(
    (prd) => !prd.status.toLowerCase().includes("human"),
  );

  if (prds.length === 0) {
    return null;
  }

  for (let i = prds.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [prds[i], prds[j]] = [prds[j], prds[i]];
  }

  for (const prd of prds) {
    const lastStatus = ticketStatusTracker.get(prd.id)?.status;
    if (lastStatus !== prd.status) {
      ticketStatusTracker.set(prd.id, {
        status: prd.status,
        retryCount: 0,
      });
      return prd;
    }
  }

  const weights = prds.map((prd) => {
    const tracker = ticketStatusTracker.get(prd.id);
    const weight = 1 / ((tracker?.retryCount ?? 0) + 1);
    return { prd, weight, tracker };
  });
  const totalWeight = weights.reduce((sum, w) => sum + w.weight, 0);
  let r = Math.random() * totalWeight;
  for (const { prd, weight, tracker } of weights) {
    r -= weight;
    if (r > 0) continue;

    if (!tracker) {
      ticketStatusTracker.set(prd.id, { status: prd.status, retryCount: 0 });
      return prd;
    }

    const seconds = Math.min(Math.pow(4, tracker.retryCount), 600);
    console.log(
      `[ralph] ${prd.id} cooling down — skipping for ${seconds}s (retry #${tracker.retryCount})`,
    );
    await sleep(seconds * 1000);
    tracker.retryCount += 1;
    ticketStatusTracker.set(prd.id, tracker);
    return prd;
  }

  return null;
}

// PID lock file management

function checkLockFile() {
  const lockPath = path.join(__dirname, "ralph.lock");
  try {
    // Check for stale lock file
    try {
      const existing = fs.readFileSync(lockPath, "utf-8").trim();
      const pid = parseInt(existing, 10);
      if (!isNaN(pid)) {
        try {
          process.kill(pid, 0);
          console.error(`[ralph] Another instance is running (PID ${pid}). Exiting.`);
          process.exit(1);
        } catch {
          console.log(`[ralph] Removing stale lock file (PID ${pid} not running).`);
        }
      }
    } catch {
      // File doesn't exist or can't be read — that's fine
    }
    
    // Atomic acquire
    const fd = fs.openSync(lockPath, "wx");
    fs.writeSync(fd, String(process.pid));
    fs.closeSync(fd);
  } catch (err) {
    if (err.code === "EEXIST") {
      console.error("[ralph] Lock file already exists. Another instance may be running. Exiting.");
      process.exit(1);
    }
    console.error(`[ralph] Failed to acquire lock: ${err.message}`);
    process.exit(1);
  }
}

function removeLockFile() {
  const lockPath = path.join(__dirname, "ralph.lock");
  try {
    if (fs.existsSync(lockPath)) {
      fs.unlinkSync(lockPath);
    }
  } catch (err) {
    // Best-effort cleanup
  }
}

// Graceful shutdown handlers

function setupShutdownHandlers() {
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[ralph] Received ${signal} — shutting down gracefully...`);
    if (currentChild) {
      killProcessTree(currentChild);
    }
    removeLockFile();
    process.exit(process.exitCode || 0);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("unhandledRejection", (err) => {
    console.error(`[ralph] Unhandled rejection: ${err.message}`);
    process.exitCode = 1;
    shutdown("unhandledRejection");
  });
}

async function main() {
  // Check PID lock file before starting
  checkLockFile();

  // Register graceful shutdown handlers
  setupShutdownHandlers();

  const sessionId = crypto.randomUUID().slice(0, 8);
  const repoName = process.argv[2];
  if (!repoName) {
    console.error("Usage: node ralph.js <repo-name>");
    removeLockFile();
    process.exit(1);
  }

  let heartbeatCount = 0;
  while (true) {
    if (shuttingDown) {
      console.log("[ralph] Shutdown requested — exiting loop.");
      break;
    }

    const prd = await findAndProcess(repoName);

    if (!prd) {
      const seconds = 5;
      heartbeatCount++;
      if (heartbeatCount % 6 === 0) {
        console.log(`[ralph] Alive — waiting for tickets...`);
      }
      await sleep(seconds * 1000);
      continue;
    }

    const pendingSubtask = prd.subtasks?.find(
      (s) => s.status === "Needs Validation",
    );
    if (pendingSubtask) {
      try {
        await validateSubtask(prd, pendingSubtask);
      } catch (err) {
        console.log(
          `[ralph] Validation failed for ${prd.id}: ${err.message}`,
        );
        pendingSubtask.reviewComments = [
          `Error during validation: ${err.message}`,
        ];
        pendingSubtask.status = "Needs Implementation Update";
        saveTicket(prd, repoName);
      }
      continue;
    }

    if (prd.status === "Needs Validation") {
      try {
        await validateTicket(prd);
      } catch (err) {
        console.log(
          `[ralph] Validation failed for ${prd.id}: ${err.message}`,
        );
        prd.reviewComments = [`Error during validation: ${err.message}`];
        prd.status = "Needs Implementation Update";
        saveTicket(prd, repoName);
      }
      continue;
    }

    // Pass prd.id and repoName as environment variables to avoid shell injection
    const prdIdRef = formatEnvVar("RALPH_PRD_ID");
    const repoNameRef = formatEnvVar("RALPH_REPO_NAME");
    const cmd = `opencode --agent "Scrum Master" run "process ticket -- id - ${prdIdRef} repo - ${repoNameRef}" --pure true`;
    const startTime = Date.now();
    console.log(
      `\n--- Processing: ${prd.id} - ${prd.name} (${prd.status}) ---`,
    );
    console.log(`Running: ${cmd}\n`);

    try {
      await runAsync(cmd, {
        RALPH_PRD_ID: prd.id,
        RALPH_REPO_NAME: repoName,
      });
    } catch (err) {
      console.error(`Command failed for ${prd.id}: ${err.message}`);
    }
    console.log(`[ralph] Processed ${prd.id} in ${((Date.now() - startTime) / 1000).toFixed(1)}s (${prd.status})`);
  }

  removeLockFile();
}

main();
