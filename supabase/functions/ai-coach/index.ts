import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");

const SYSTEM_PROMPT = `You are an expert AI fitness coach inside a gym workout tracking app called OVERLOAD. You help users with:
- Creating personalized workout routines
- Building multi-day training programs
- Answering questions about training, nutrition, recovery
- Providing form tips and exercise alternatives

When generating workouts, respond with structured JSON when the user asks you to "create", "generate", or "build" a workout or plan. Use this format:
{
  "type": "workout",
  "name": "Workout Name",
  "exercises": [
    { "name": "Exercise Name", "sets": 4, "reps": "8-10", "rest": "90s" }
  ]
}

For workout plans (multiple workouts), use:
{
  "type": "plan",
  "workouts": [
    { "name": "Day 1 - Push", "exercises": [...] }
  ]
}

For regular conversation, just respond naturally with helpful advice. Use markdown formatting for readability. Keep responses concise but informative.`;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
      },
    });
  }

  if (!ANTHROPIC_API_KEY) {
    return new Response(
      JSON.stringify({ error: "ANTHROPIC_API_KEY not configured" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }

  try {
    const { messages } = await req.json();

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        messages: messages.map((m: { role: string; content: string }) => ({
          role: m.role,
          content: m.content,
        })),
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      return new Response(
        JSON.stringify({ error: `Anthropic API error: ${response.status}`, details: errorText }),
        { status: 502, headers: { "Content-Type": "application/json" } }
      );
    }

    const data = await response.json();
    const text = data.content?.[0]?.text || "Sorry, I couldn't generate a response.";

    return new Response(
      JSON.stringify({ response: text }),
      {
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: "Internal error", details: String(err) }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
});
