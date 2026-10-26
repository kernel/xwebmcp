import { pastDates } from "./intents.mjs";
import { isScored, rowKey } from "./rows.mjs";

// Upper bound on the remaining jobs' duration, for sizing the VM hold. Retries are not included.
export function holdNeededSec(stages, slots) {
  let total = 0;
  for (const jobs of stages) {
    if (!jobs.length) continue;
    const secs = jobs.map(job => job.sec);
    const perProfile = Map.groupBy(jobs.filter(job => job.profile), job => job.profile);
    const serial = [...perProfile.values()].map(group => group.reduce((a, job) => a + job.sec, 0));
    total += Math.max(secs.reduce((a, b) => a + b, 0) / slots + Math.max(...secs) * (1 - 1 / slots), ...serial);
  }
  return total;
}

// Trials on one profile share its account, so they run one at a time.
export function nextJob(queue, busyProfiles) {
  return queue.findIndex(job => !job.profile || !busyProfiles.has(job.profile));
}

// Once admit() refuses a job no more start; the running ones finish.
export async function runQueue(jobs, slots, { stopped = () => false, beforeJob = () => {}, admit = () => true } = {}) {
  const queue = [...jobs];
  const busyProfiles = new Set();
  let refused = false;
  let jobDone = Promise.withResolvers();
  await Promise.all(Array.from({ length: slots }, async () => {
    while (queue.length && !stopped() && !refused) {
      beforeJob();
      const next = nextJob(queue, busyProfiles);
      if (next < 0) {
        await jobDone.promise;
        continue;
      }
      if (!admit(queue[next])) {
        refused = true;
        break;
      }
      const [job] = queue.splice(next, 1);
      if (job.profile) busyProfiles.add(job.profile);
      try {
        await job.run();
      } finally {
        busyProfiles.delete(job.profile);
        jobDone.resolve();
        jobDone = Promise.withResolvers();
      }
    }
  }));
  return { refused };
}

// A domain stops when none of its treatment-only trials invoked a tool, including when all aborted.
export function adoptionVerdicts(domains, rows) {
  return domains.map(domain => {
    const trials = rows.filter(row => row.domain === domain);
    const aborted = trials.filter(row => row.outcome === "aborted").length;
    const adopted = trials.filter(row => row.outcome !== "aborted" && row.webmcp?.adopted).length;
    return { domain, trials: trials.length, aborted, adopted, stop: trials.length > 0 && adopted === 0 };
  });
}

// Half control first (AB), half treatment first (BA), shuffled.
export function balancedOrders(pairs, randomInt) {
  const orders = Array.from({ length: pairs }, (_, i) => (i % 2 ? "BA" : "AB"));
  if (pairs % 2 && randomInt(2)) orders[pairs - 1] = "BA";
  for (let i = pairs - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [orders[i], orders[j]] = [orders[j], orders[i]];
  }
  return orders;
}

// A pair's trials in run order. An intent on a domain with no tools runs control alone.
// With --treatment-only a pair is just its treatment trial.
export const pairArms = (intentPlan, order) => intentPlan.uncovered ? ["control"] : intentPlan.treatment_only ? ["treatment"] : order === "AB" ? ["control", "treatment"] : ["treatment", "control"];

// Treatment-only trials interleave across domains, so one broken domain cannot hit the abort
// limit before its adoption verdict stops it. Pairs interleave across intents to spread site drift.
export function planJobs(intentPlans, adoption, latest, today) {
  const scored = (intentPlan, key, arm) => isScored(latest.get(rowKey({ intent: intentPlan.intent.id, ...key, arm })));
  let adoptionJobs = [];
  const domains = [...new Set(intentPlans.map(p => p.intent.domain))];
  const candidates = new Map(domains.map(domain => [domain, intentPlans.filter(p => p.intent.domain === domain && p.intent.stage !== "gap" && !p.uncovered)]));
  for (let n = 1; n <= adoption; n++) {
    for (const domain of domains) {
      const plans = candidates.get(domain);
      if (!plans.length) continue;
      const intentPlan = plans[(n - 1) % plans.length];
      if (!scored(intentPlan, { adoption: n }, "treatment")) adoptionJobs.push({ intentPlan, adoption: n });
    }
  }
  let pairJobs = [];
  const maxPairs = Math.max(0, ...intentPlans.map(p => p.orders.length));
  for (let pair = 1; pair <= maxPairs; pair++) {
    for (const intentPlan of intentPlans) {
      const order = intentPlan.orders[pair - 1];
      if (!order || pairArms(intentPlan, order).every(arm => scored(intentPlan, { pair }, arm))) continue;
      pairJobs.push({ intentPlan, pair, order });
    }
  }
  const stale = [];
  for (const intentPlan of intentPlans) {
    const dates = pastDates(intentPlan.intent.fixture, today);
    const pending = (job) => job.intentPlan === intentPlan;
    if (!dates.length || !(adoptionJobs.some(pending) || pairJobs.some(pending))) continue;
    stale.push({ intentPlan, dates });
    adoptionJobs = adoptionJobs.filter(job => !pending(job));
    pairJobs = pairJobs.filter(job => !pending(job));
  }
  return { adoptionJobs, pairJobs, stale };
}

// If either trial aborts the whole pair runs again, so a complete pair comes from one attempt.
export async function runPairAttempts(arms, attempts, runArm, onRetry = () => {}) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let outcome;
    for (const arm of arms) {
      outcome = await runArm(arm, attempt);
      if (outcome === null) return;
      if (outcome === "aborted") break;
    }
    if (outcome !== "aborted") return;
    if (attempt < attempts) onRetry();
  }
}
