// Output schema of the actions every steampowered.com tool reports for the page it ran on.
const STEAM_ACTIONS = {
  type: "array",
  items: {
    type: "object", additionalProperties: false,
    required: ["tool", "registered", "input", "note"],
    properties: {
      tool: { type: "string" },
      registered: { type: ["boolean", "null"], description: "Whether the tool is registered on this page; null when the page's tool registry could not be read." },
      input: { type: ["object", "null"], description: "A valid input for this exact state; null when it needs a value the page does not suggest (see note)." },
      note: { type: "string" }
    }
  }
};
