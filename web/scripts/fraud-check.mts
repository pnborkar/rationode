// Print check_fraud_patterns for customers: npx tsx --env-file=../.env scripts/fraud-check.mts <email> [...]
import { checkFraudPatterns } from "../src/lib/fraud";
import { driver } from "../src/lib/neo4j";
const emails = process.argv.slice(2);
for (const email of emails) {
  const t = Date.now();
  const r = await checkFraudPatterns(email);
  console.log(`\n${email} (${Date.now() - t} ms)`);
  console.log(JSON.stringify(r ? { charge: r.charge, cluster: { ...r.cluster, examples: r.cluster.examples.slice(0, 3) }, facts: r.facts } : null, null, 1));
}
await driver().close();
