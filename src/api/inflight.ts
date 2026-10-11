let inFlightCount = 0;
let resolveInFlight: (() => void) | null = null;

const inFlightPromise = new Promise<void>((resolve) => {
  resolveInFlight = resolve;
});

export function trackInFlight(): () => void {
  inFlightCount++;
  if (inFlightCount === 1) {
    // Reset promise when first request comes in
    resolveInFlight = null;
  }
  return () => {
    inFlightCount--;
    if (inFlightCount === 0 && resolveInFlight) {
      resolveInFlight();
    }
  };
}

export async function waitForInFlight(timeoutMs = 30000): Promise<void> {
  if (inFlightCount === 0) return;
  
  const timeoutPromise = new Promise<void>((_, reject) => {
    setTimeout(() => reject(new Error('Timeout waiting for in-flight requests')), timeoutMs);
  });
  
  try {
    await Promise.race([inFlightPromise, timeoutPromise]);
  } catch (_err) {
    console.warn('In-flight wait timed out, proceeding with shutdown', { inFlightCount });
  }
}

export function getInFlightCount(): number {
  return inFlightCount;
}