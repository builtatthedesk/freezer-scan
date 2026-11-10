// Photo -> suggested freezer labels. One place to swap the model: today Claude,
// later a local vision model (add another entry to PROVIDERS, pick it with LABEL_AI).
//   ANTHROPIC_API_KEY   needed for the default "claude" provider
//   LABEL_AI            provider name (default "claude")
//   LABEL_AI_MODEL      model override (default claude-opus-5-5)
import Anthropic from "@anthropic-ai/sdk";

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["items"],
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "count", "date"],
        properties: {
          name: { type: "string", description: "Short label text a person would write, e.g. 'Chicken thighs' or 'Beef stew'" },
          count: { type: "integer", description: "How many separate packs of this food are visible" },
          date: { type: ["string", "null"], description: "YYYY-MM-DD if a pack, freeze or made-on date is written on it, else null" },
        },
      },
    },
  },
};

const PROMPT = `This photo shows food going into (or found in) a home freezer, most of it not yet labelled.
List each distinct food so a label can be printed for it.
- name: what a person would write on the label, 1-4 words, plain and specific ("Ground beef", "Chicken soup", "Blueberries"). Use the brand or product name only if that's how people would know it. Never a sentence.
- count: how many separate packs/bags/containers of that same food you can see (at least 1).
- date: only if a date is actually written or printed on the pack as a packed, frozen or made-on date (handwriting counts), as YYYY-MM-DD; a best-by/use-by date or no date at all -> null. Assume the current year is ${new Date().getFullYear()} if a handwritten date has no year.
Skip things that are not food. If you can't tell what something is, give your best plain guess ("Leftovers", "Frozen meat") rather than leaving it out.`;

async function claude(jpegBase64){
  const client = new Anthropic();   // ANTHROPIC_API_KEY from the environment
  const res = await client.beta.messages.create({
    model: process.env.LABEL_AI_MODEL || "claude-opus-5-5",
    max_tokens: 4000,
    // Re-run on another model if this one declines; routes by refusal type.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA } },
    messages: [{ role: "user", content: [
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: jpegBase64 } },
      { type: "text", text: PROMPT },
    ] }],
  });
  if (res.stop_reason === "refusal") throw new Error("The photo couldn't be read. Try another one.");
  const text = res.content.filter(b => b.type === "text").map(b => b.text).join("");
  return JSON.parse(text);
}

const PROVIDERS = { claude };

export function labelAiReady(){
  const p = process.env.LABEL_AI || "claude";
  return p === "claude" ? !!process.env.ANTHROPIC_API_KEY : !!PROVIDERS[p];
}

// -> [{ name, count, date|null }], cleaned so the page can trust it.
export async function suggestLabels(jpegBase64){
  const run = PROVIDERS[process.env.LABEL_AI || "claude"];
  if (!run) throw new Error("Unknown LABEL_AI provider.");
  const out = await run(jpegBase64);
  const items = Array.isArray(out && out.items) ? out.items : [];
  return items.slice(0, 20).map(i => ({
    name: String(i.name || "").replace(/\s+/g, " ").trim().slice(0, 60),
    count: Math.min(50, Math.max(1, parseInt(i.count, 10) || 1)),
    date: /^\d{4}-\d{2}-\d{2}$/.test(i.date || "") ? i.date : null,
  })).filter(i => i.name && !/^(LOC|CMD|BIN):/i.test(i.name));
}
