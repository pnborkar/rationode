// Prepared live customers: real customers from the history with a recent charge and no complaint yet.
// Their contexts have precomputed embeddings (pipeline: `rationode.analytics export-live`).
export type LiveCase = {
  key: string;
  name: string;
  email: string;
  ticket_id: string;
  blurb: string;       // one line for the presenter: what this case shows
  message: string;
  setNumber?: number;  // loaded from the Events tab (removable)
};

export const LIVE_CASES: LiveCase[] = [
  {
    key: "sam", name: "Sam Okafor", email: "sam.okafor26002@example.com", ticket_id: "500001",
    blurb: "Loyal (28 months, annual $180), didn't use it. The graph changes the decision: off → deny; on → refund, never deny.",
    message: "Hi, I was charged $180 for my annual renewal but I haven't used Streamly at all this year. Can I get a refund?",
  },
  {
    key: "jordan", name: "Jordan Rossi", email: "jordan.rossi650@example.com", ticket_id: "500002",
    blurb: "New (5 months, monthly $25), didn't use it. The graph backs the guidance: denying rarely backfires for new customers, so the agent denies consistently.",
    message: "Hey, I signed up a few months ago but I didn't watch anything this month. Can I get my $25 back?",
  },
  {
    key: "amara", name: "Amara Rossi", email: "amara.rossi165@example.com", ticket_id: "500003",
    blurb: "Loyal (41 months, monthly $49), finds it too expensive. Pause either way, but with the graph the agent can prove it: 4% disputes vs 16% for deny.",
    message: "Streamly has become too expensive for me at $49 a month. Is there anything you can do?",
  },
  {
    key: "jamie", name: "Jamie Kowalski", email: "jamie.kowalski100@example.com", ticket_id: "500004",
    blurb: "13 months, annual $300, charged twice. A billing error: guidance and graph agree on a full refund.",
    message: "I was charged $300 twice for my annual plan this month. Please fix this.",
  },
];
