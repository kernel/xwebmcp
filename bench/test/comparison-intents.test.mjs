import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { gradeAnswer } from "../grade.mjs";
import { loadIntents, loadSchema } from "../lib/intents.mjs";
import { pairStats } from "../report.mjs";

const benchDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const intents = loadIntents(benchDir);

function checkAgreement(id, control, treatment, differed) {
  const intent = intents.find(i => i.id === id);
  const schema = loadSchema(benchDir, intent);
  const rows = [control, treatment].map((answer, i) => {
    const grade = gradeAnswer(intent, schema, JSON.stringify(answer));
    assert.equal(grade.outcome, "correct", grade.problems.join("; "));
    return { intent: id, pair: 1, arm: i ? "treatment" : "control", outcome: grade.outcome, duration_ms: 1000, grade };
  });
  assert.deepEqual(pairStats(rows, intent.agreement).agreement, { checked: 1, differed });
}

test("Shopify comparison agreement includes all listing fields and result order", () => {
  const apps = ["First Subscriptions", "Second Subscriptions", "Third Subscriptions"].map(app => ({
    app, rating: 4.8, review_count: 123, cheapest_paid_monthly_price: 29
  }));
  const check = (other, differed) => checkAgreement("shopify-app-store-compare", { apps }, { apps: other }, differed);
  check(structuredClone(apps), 0);
  for (const change of [{ rating: 1 }, { review_count: 0 }, { cheapest_paid_monthly_price: 0 }]) {
    check([{ ...apps[0], ...change }, ...apps.slice(1)], 1);
  }
  check(apps.toReversed(), 1);
});

test("Steam comparison agreement keeps prices and review summaries attached to their games in order", () => {
  const games = ["Civilization V", "Civilization VI", "Civilization VII"].map((game, i) => ({
    game, price: (i + 1) * 10, review_summary: "Very Positive"
  }));
  const check = (other, differed) => checkAgreement("steam-compare-series", { games }, { games: other }, differed);
  check(structuredClone(games), 0);
  check(games.map((g, i) => ({ ...g, price: games[(i + 1) % games.length].price })), 1);
  check([{ ...games[0], review_summary: "Mixed" }, ...games.slice(1)], 1);
  check(games.toReversed(), 1);
});
