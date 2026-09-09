import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const OPENAI_API_URL = "https://api.openai.com/v1/responses";
const MODEL = Deno.env.get("OPENAI_MODEL") || "gpt-5.6-luna";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const schema = {
  type: "object",
  additionalProperties: false,
  properties: {
    summary: { type: "string" },
    report_title: { type: "string" },
    patient_display_name: { type: ["string", "null"] },
    doctor_display_name: { type: ["string", "null"] },
    sections: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          title: { type: "string" },
          rows: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                parameter: { type: "string" },
                result: { type: "string" },
                unit: { type: "string" },
                reference: { type: "string" },
                flag: { type: "string" },
              },
              required: ["parameter", "result", "unit", "reference", "flag"],
            },
          },
        },
        required: ["title", "rows"],
      },
    },
    missing_fields: { type: "array", items: { type: "string" } },
    warnings: { type: "array", items: { type: "string" } },
    requested_metadata_changes: {
      type: "object",
      additionalProperties: false,
      properties: {
        patient_display_name: { type: ["string", "null"] },
        doctor_display_name: { type: ["string", "null"] },
      },
      required: ["patient_display_name", "doctor_display_name"],
    },
  },
  required: [
    "summary",
    "report_title",
    "patient_display_name",
    "doctor_display_name",
    "sections",
    "missing_fields",
    "warnings",
    "requested_metadata_changes",
  ],
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const key = Deno.env.get("OPENAI_API_KEY");
  if (!key) return json({ error: "AI service is not configured on the server." }, 503);

  const auth = req.headers.get("Authorization") || "";
  if (!auth.startsWith("Bearer ")) return json({ error: "Authentication required." }, 401);

  let body: { text?: string; command?: string; booking?: Record<string, unknown> };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body." }, 400);
  }

  const text = String(body.text || "").trim();
  const command = String(body.command || "").trim();
  const booking = body.booking || {};
  if (!text) return json({ error: "Report source text is required." }, 400);
  if (text.length > 120000) return json({ error: "Report source is too large for the AI review endpoint." }, 413);

  const instructions = [
    "You are LifeSure Diagnostics Report Copilot.",
    "Work only with information explicitly supplied in the source text and booking context.",
    "Never invent, repair, estimate, normalize, reinterpret, or clinically infer a result.",
    "Never change a numeric/qualitative clinical result, unit, reference range, or clinical interpretation unless the user command explicitly requests a non-clinical formatting change; even then preserve the source value and flag the requested change for human review.",
    "Administrative display edits such as patient display name or doctor display name are allowed, but must be returned separately as requested_metadata_changes and must not alter the database patient record.",
    "Extract tables and sections faithfully. When a row is ambiguous, place it in warnings instead of guessing.",
    "This is an assistance tool. A qualified authorized staff member must review before verification and publication.",
  ].join(" ");

  const userInput = JSON.stringify({
    command,
    booking,
    source_text: text,
  });

  const response = await fetch(OPENAI_API_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      input: [
        { role: "system", content: [{ type: "input_text", text: instructions }] },
        { role: "user", content: [{ type: "input_text", text: userInput }] },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "lifesure_report_analysis",
          strict: true,
          schema,
        },
      },
    }),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    console.error("OPENAI_RESPONSES_ERROR", payload);
    return json({ error: "AI service request failed.", provider_status: response.status }, 502);
  }

  const outputText = payload?.output_text;
  if (!outputText) return json({ error: "AI service returned no structured output." }, 502);

  try {
    const result = JSON.parse(outputText);
    return json({ success: true, model: MODEL, result });
  } catch (error) {
    console.error("AI_JSON_PARSE_ERROR", error);
    return json({ error: "AI service returned invalid structured output." }, 502);
  }
});
