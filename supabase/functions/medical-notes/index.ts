import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
  "Access-Control-Expose-Headers": "x-model-used, x-is-premium",
};

function sanitizeJsonOutput(raw: string): string {
  // Strip markdown code fences if the model wraps the JSON
  let cleaned = raw.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  }
  return cleaned;
}

/**
 * Role/tone preamble for the two sheet prompts, selected by persona tier.
 * Persona changes prompt content and register only — never model routing, and
 * never the JSON contract in `sheetSchemaBlock`. Unknown values fall back to
 * "student". (Feature 02 — Persona Tiers.)
 */
function personaPreamble(p: string | undefined, mode: string, diff: string, foc: string, len: string): string {
  const tier = p === "clinician" ? "clinician" : p === "expert" ? "expert" : "student";

  if (tier === "student") {
    return `You are an enthusiastic and clear medical educator writing for an undergraduate medical student (Year 2–4 equivalent). Your goal is comprehension and retention.

Mode: ${mode} | Difficulty: ${diff} | Focus: ${foc} | Length: ${len}

STUDENT PERSONA RULES:
- Write for someone building foundational understanding. Prioritise intuition before detail.
- Memory hooks must be vivid, simple mnemonics or analogies — something that sticks.
- Pathophysiology in the overview should build mechanistically from first principles (cause → effect → clinical consequence). No assumed knowledge.
- Clinical approach: explain the reasoning behind each step ("we order this because…"), not just the step itself.
- Exam traps should highlight common conceptual confusions, not just recall errors.
- Flashcards should be clear vignettes with unambiguous single answers. Avoid expert-level nuance.
- Language: plain clinical English. Define jargon on first use. Avoid passive voice.`;
  }

  if (tier === "clinician") {
    return `You are a senior clinician writing practical, bedside-ready content for a junior doctor, intern, or final-year student on clinical placement. Your goal is safe, confident clinical decision-making.

Mode: ${mode} | Difficulty: ${diff} | Focus: ${foc} | Length: ${len}

CLINICIAN PERSONA RULES:
- Lead with what matters at the bedside: recognition, triage, and first decisions.
- The overview should connect pathophysiology directly to signs and symptoms the clinician will actually see ("this mechanism → this presentation").
- Clinical approach must be actionable: decision thresholds, drug doses where relevant, when to escalate.
- Memory hooks should be clinical heuristics or rule-of-thumb shortcuts that a doctor would actually use ("if the JVP is raised and the CXR shows…").
- Exam traps should reflect real clinical traps, not just exam MCQ traps — what gets junior doctors in trouble on the ward.
- Flashcards: vignette-style with a clinical decision or next best step as the answer. At least half should be "what do you do next?" stems.
- Language: confident clinical register. Write as if handing over a patient. Brevity is a virtue.`;
  }

  // expert
  return `You are a clinician-scientist writing for an advanced reader: a senior medical student, registrar, or specialist trainee who wants mechanistic depth and nuanced clinical reasoning.

Mode: ${mode} | Difficulty: ${diff} | Focus: ${foc} | Length: ${len}

EXPERT PERSONA RULES:
- Assume high baseline knowledge. Do not define standard terminology.
- Overview: pathophysiology at the cellular and molecular level where relevant (receptor subtypes, ion channels, signalling cascades). Include genetic or epidemiological context if high-yield.
- Clinical approach: include second-line and third-line management, nuanced contraindications, special populations, and when guidelines diverge from evidence.
- Memory hooks can be more sophisticated: mechanistic analogies, pattern-recognition heuristics, or unusual associations that reveal deeper understanding.
- Exam traps should surface expert-level distinctions: atypical presentations, rare but important exceptions, classic "wrong answer traps" that catch people who almost know the topic.
- Flashcards: include at least one card on a subtlety or exception the topic is known for. Vignettes may have layered reasoning.
- Language: technical and precise. Abbreviations acceptable. Dense is fine — this reader wants substance, not scaffolding.`;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // ── JWT verification ───────────────────────────────────────────────────
    // Reject missing/invalid tokens before doing any work. The client sends the
    // user's Supabase access token as the Authorization bearer.
    const authHeader = req.headers.get("Authorization") ?? "";
    const token = authHeader.replace(/^Bearer\s+/i, "").trim();
    if (!token) {
      return new Response(
        JSON.stringify({ error: "invalid_token" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
    const { createClient } = await import("https://esm.sh/@supabase/supabase-js@2");
    const authClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );
    const { data: { user }, error: authError } = await authClient.auth.getUser(token);
    if (authError || !user) {
      return new Response(
        JSON.stringify({ error: "invalid_token" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const { notes, difficulty, focus, length, examMode, cardsOnly, cardCount, focusCard,
            explainMode, userId, isAnonymous, isPro, preferredModel,
            enhanceMode, itemText, sectionKey, sectionItems, enhanceTopic,
            persona } = await req.json();

    if (!notes || typeof notes !== "string" || !notes.trim()) {
      return new Response(
        JSON.stringify({ error: "Notes are required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const mode = examMode || "General";
    const diff = difficulty || "Basic";
    const foc = focus || "Quick Revision";
    const len = length || "Concise";

    const referenceNote = mode.startsWith("USMLE")
      ? "Exam-aligned with high-yield USMLE resources (e.g., First Aid, guidelines)."
      : "Based on standard medical references and clinical guidelines.";

    let systemPrompt: string;

    // ── GPT-OSS PROMPTS (optimized for reasoning model behavior) ───────────
    const gptOssExplainPrompt = `You are a senior medical educator. A student reviewing a specific flashcard needs a targeted explanation of that exact Q&A pair.

If the input starts with "CARD QUESTION:" and "CARD ANSWER:", explain WHY that answer is correct: the mechanism, clinical reasoning, and what makes it distinguishable. Do not repeat the question or answer.

If the input is just a topic, give a brief focused refresher.

OUTPUT FORMAT:

EXPLANATION
3-5 sentences on the mechanism or reasoning. Lead with the core idea.

WHY THIS ANSWER
One sentence: the key reason this answer is correct over alternatives.

EXAM TIP
One sentence: the classic examiner trap or high-yield test point.

RULES: Under 180 words total. No markdown. No flashcards or full sheets. Start with EXPLANATION directly.`;

    const gptOssCardsPrompt = (count: number) => `You are a medical educator. Generate exactly ${count} USMLE-style flashcards on the given topic.

Mode: ${mode} | Difficulty: ${diff}

Think through the highest-yield concepts for this topic, then output ONLY the flashcards in the exact format below. No preamble, no commentary, no explanations outside the cards.

OUTPUT FORMAT — copy this structure exactly:

FLASHCARDS

[one emoji representing the topic on its own line]

Q: [Tag] Question ending with question mark?
A: Answer in 1-2 sentences maximum.

Q: [Tag] Next question?
A: Answer.

[blank line between every card — this is mandatory]

TAGS (pick one per card): [Diagnosis] [Mechanism] [Next Step] [Complication] [Association]

EMOJI: Pick one that matches the topic — 🫀 cardiac, 🩸 hematology, 🧠 neuro, 🫁 pulmonary, 🦴 ortho, 🩺 general, 💊 pharmacology, 🧬 genetics, 👁️ ophthalmology, 🤰 OB/GYN, 👶 pediatrics, 🧫 micro, ⚗️ biochem, 🩹 trauma, 🛡️ immunology

HARD RULES:
- Exactly ${count} cards. No more, no less.
- Each card: Q: on one line, A: on next line, blank line after.
- Tags in square brackets at start of every Q: line.
- Questions end with ?
- Answers: 1-2 sentences only — never more.
- No "Q:" or "A:" anywhere inside question or answer text.
- No numbering. No headers between cards. No explanations.
- Mix clinical vignettes and concept recall cards.`;

    // ── SHARED SHEET OUTPUT CONTRACT ───────────────────────────────────────
    // Identical JSON schema + length gate + emoji set appended by BOTH model
    // families. Defined once here; the only per-family difference is the
    // preamble (gptOss = terse; haiku = explicit input/mode/focus rules).
    // (Step 1 of feature 02 — Persona Tiers.)
    const sheetSchemaBlock = `FORMATTING RULES (non-negotiable):
- Return ONLY a valid JSON object. No markdown fences, no preamble, no
  commentary, no text before or after the JSON.
- Use **double asterisks** inside string values to bold key terms in the
  overview and clinicalApproach fields. The renderer handles this.
- Use arrows (→) inside string values to show clinical flow.
- Numbered list items inside array fields: do NOT include the leading
  number (e.g. "1."). Each array element is already one item.

OUTPUT — return exactly this JSON shape:

{
  "topicEmoji": "<one emoji matching the topic>",
  "topic": "<normalized topic name, e.g. Heart Failure — plain text, no emoji>",
  "overview": "<pathophysiology-first conceptual foundation. MANDATORY STRUCTURE — each sub-section on its own line using \\n before the label. Exact format:\\nMechanism: **Bold the core defect** — one sentence on the cellular or molecular trigger.\\nPathophysiology: 2-3 sentences tracing how that defect produces the clinical syndrome. Use arrows → to show flow. Bold **key mechanisms**.\\nKey associations:\\n1. **Buzzword** → why it occurs mechanistically\\n2. **Classic presentation** → the mechanism behind it\\n3. **High-yield link** → pathophysiologic explanation\\nSTRICT RULES: NO drug names. NO diagnostic criteria (no 'gold standard is...'). NO management steps. NO investigations. Those belong in Clinical Approach only. Each label starts after a \\n. Do NOT merge into one paragraph.>",
  "memoryHooks": [
    "<mnemonic one-liner 1>",
    "<mnemonic one-liner 2>",
    "<mnemonic one-liner 3>"
  ],
  "clinicalApproach": "<Complete clinical decision section — this is the ONLY section with diagnostic criteria, drug names, and management steps. MANDATORY STRUCTURE — each sub-section on its own line using \\n before the label. Exact format:\\nDiagnosis: Gold standard → what it shows. Key distinguishing findings.\\nWorkup: what to order and why — labs, imaging, scores.\\nManagement:\\nFirst-line → drug + dose rationale.\\nSecond-line → when and why to escalate.\\nDefinitive → surgical or specialist triggers.\\nComplications: what goes wrong if undertreated — bold **the dangerous ones**.\\nAvoid: interventions or drugs contraindicated in this condition.\\nBe complete here — do not hold back detail. This section should be the most clinically dense section on the sheet.>",
  "keyPoints": [
    "<If X → think Y one-liner 1>",
    "<If X → think Y one-liner 2>"
  ],
  "examTraps": [
    "<trap one-liner 1>",
    "<trap one-liner 2>"
  ],
  "flashcards": [
    {
      "tag": "Next Step",
      "question": "<full vignette question text>",
      "answer": "<1-2 sentence answer>"
    }
  ],
  "referenceNote": "${referenceNote}"
}

LENGTH GATE — apply strictly based on the Length setting "${len}":

If Length is "Concise":
- overview: Mechanism (1 sentence) + Pathophysiology (2 sentences) + Key associations (max 3 items). No more.
- clinicalApproach: Diagnosis (1-2 sentences, gold standard only) + Management (first-line only, 1-2 sentences) + Complications (max 2 items). Omit Workup, Second-line, Definitive, Avoid sections entirely.
- memoryHooks: exactly 3 items
- keyPoints: exactly 5 items
- examTraps: exactly 3 items
- flashcards: exactly 3 items, mix: 1x Next Step, 1x Diagnosis, 1x Mechanism. All clinical vignettes.

If Length is "Moderate":
- overview: Mechanism (1 sentence) + Pathophysiology (2-3 sentences) + Key associations (max 4 items).
- clinicalApproach: all subsections at moderate depth, no padding.
- memoryHooks: 3-4 items
- keyPoints: 6-8 items
- examTraps: 4 items
- flashcards: exactly 4 items, mix: 1x Next Step, 1x Diagnosis, 1x Mechanism, 1x Complication. All clinical vignettes.

If Length is "Detailed":
- overview: Mechanism (1-2 sentences) + Pathophysiology (3-4 sentences) + Key associations (5-6 items).
- clinicalApproach: all subsections fully expanded, include edge cases and nuances.
- memoryHooks: 5 items
- keyPoints: 8-10 items
- examTraps: 5-6 items
- flashcards: exactly 5 items, mix: 2x Next Step, 1x Diagnosis, 1x Mechanism, 1x Complication. All clinical vignettes.

These are HARD CAPS. Do not exceed them regardless of topic complexity.

EMOJI OPTIONS:
🫀 cardiac, 🩸 hematology, 🧠 neuro, 🫁 pulmonary, 🦴 ortho, 🩺 general,
💊 pharmacology, 🧬 genetics, 👁️ ophthalmology, 🤰 OB/GYN, 👶 pediatrics,
🧫 micro, ⚗️ biochem, 🩹 trauma, 🛡️ immunology

Start your response with { and end with }. Nothing else.`;

    const gptOssSheetPrompt = `${personaPreamble(persona, mode, diff, foc, len)}

Before writing anything: identify the core medical concept from the input, reason through the highest-yield facts for this persona, then generate the full output below.

${sheetSchemaBlock}`;

    // ── HAIKU 4.5 PROMPTS (Claude-native, based on GPT-OSS with input normalization) ──

    const haikuExplainPrompt = `You are a senior medical educator giving a targeted mid-study clarification.

The student is reviewing a specific flashcard and needs a deeper explanation of that exact question and answer — NOT a general overview of the topic.

If the input starts with "CARD QUESTION:" and "CARD ANSWER:", focus exclusively on explaining WHY that answer is correct: the underlying mechanism, the clinical reasoning, what makes it distinguishable from wrong answers, and what examiners test about it. Do not repeat the question or answer verbatim.

If the input is just a topic name, give a brief high-yield refresher on that topic.

OUTPUT FORMAT (follow exactly, no other sections):

EXPLANATION

3-5 sentences explaining the mechanism or reasoning behind this specific concept. Lead with the core idea. No jargon unless necessary.

WHY THIS ANSWER

One sentence: the single most important reason this answer is correct over alternatives.

EXAM TIP

One sentence: what examiners specifically test or the classic trap on this concept.

RULES:
- Total output under 180 words.
- No flashcards, no full study sheet, no memory hooks section, no reference note.
- No markdown symbols (no #, *, -, **).
- Use plain uppercase section headers exactly as shown above.
- Start directly with EXPLANATION. No preamble.`;

    // ── ENHANCE PROMPTS ──────────────────────────────────────────────────────

    const haikuExpandPrompt = `You are a senior medical educator giving a concise, targeted expansion of a single study point.

The student is reviewing a "${sectionKey}" item from a study sheet on "${enhanceTopic}".

Context — other items in this section:
${Array.isArray(sectionItems) ? sectionItems.map((s: string, i: number) => `${i + 1}. ${s}`).join("\n") : ""}

The specific item to expand:
"${itemText}"

Write EXACTLY 2-3 sentences expanding on the mechanism or deeper "why". Maximum 60 words total — stop after 60 words even mid-thought if needed. Wrap the single most important keyword or phrase per sentence in **double asterisks** for emphasis. Use clinical language. Do not repeat the item verbatim. No headers, no bullets, no markdown fences. Plain prose with **bold markers** only.`;

    const gptOssExpandPrompt = `You are a medical educator expanding a single study point for a medical student.

Topic: ${enhanceTopic}
Section: ${sectionKey}
Item: "${itemText}"
Other items in section: ${Array.isArray(sectionItems) ? sectionItems.join(" | ") : ""}

Write EXACTLY 2-3 sentences on the mechanism. Maximum 60 words. Bold the most important keyword per sentence using **double asterisks**. Plain prose only.`;

    const haikuClinicalPrompt = `You are a senior clinician connecting a study point to real bedside practice.

The student is reviewing a "${sectionKey}" item from a study sheet on "${enhanceTopic}".

The specific item:
"${itemText}"

Write EXACTLY 2 sentences: (1) a brief patient presentation where this item is directly relevant, (2) the clinical decision it drives and why. Maximum 50 words total. Bold the key clinical term per sentence using **double asterisks**. Plain prose only, no headers, no bullets.`;

    const gptOssClinicalPrompt = `You are a clinician tying a study point to a real patient scenario.

Topic: ${enhanceTopic}
Item: "${itemText}"

Write EXACTLY 2 sentences: patient presentation + clinical decision it drives. Maximum 50 words. Bold the key term per sentence using **double asterisks**. Plain prose only.`;

    const haikuCardsPrompt = (count: number) => `You are a medical educator. Generate exactly ${count} USMLE-style flashcards on the given topic.

Mode: ${mode} | Difficulty: ${diff}

INPUT HANDLING:
The user input may be one of three types:
1. Raw medical notes — extract the core topic(s) and generate flashcards based on them.
2. A study request (e.g., "I want to study myocardial infarction") — interpret as a request to generate flashcards on that topic.
3. A direct topic name (e.g., "Nephrotic syndrome") — treat as the topic directly.

Internally normalize the input into a clear medical topic, then generate the flashcards below.

OUTPUT FORMAT — copy this structure exactly:

FLASHCARDS

[one emoji representing the topic on its own line]

Q: [Tag] Question ending with question mark?
A: Answer in 1-2 sentences maximum.

Q: [Tag] Next question?
A: Answer.

[blank line between every card — this is mandatory]

TAGS (pick one per card): [Diagnosis] [Mechanism] [Next Step] [Complication] [Association]

EMOJI: Pick one that matches the topic — 🫀 cardiac, 🩸 hematology, 🧠 neuro, 🫁 pulmonary, 🦴 ortho, 🩺 general, 💊 pharmacology, 🧬 genetics, 👁️ ophthalmology, 🤰 OB/GYN, 👶 pediatrics, 🧫 micro, ⚗️ biochem, 🩹 trauma, 🛡️ immunology

HARD RULES:
- Exactly ${count} cards. No more, no less.
- Each card: Q: on one line, A: on next line, blank line after.
- Tags in square brackets at start of every Q: line.
- Questions end with ?
- Answers: 1-2 sentences only — never more.
- No "Q:" or "A:" anywhere inside question or answer text.
- No numbering. No headers between cards. No explanations.
- Mix clinical vignettes and concept recall cards.`;

    const haikuSheetPrompt = `${personaPreamble(persona, mode, diff, foc, len)}

INPUT HANDLING:
The user input may be one of three types:
1. Raw medical notes — extract the core topic(s) and generate study material based on them.
2. A study request (e.g., "I want to study myocardial infarction") — interpret as a request to generate high-yield study material on that topic.
3. A direct topic name (e.g., "Nephrotic syndrome") — treat as the topic directly.

Internally normalize the input into a clear medical topic or concept, then generate the full output below.

MODE RULES:
- USMLE Step 1: Focus on mechanisms, pathophysiology, biochemical pathways, and classic associations.
- USMLE Step 2: Focus on diagnosis, clinical management, next best steps, and patient scenarios.
- General: Provide a balanced clinical overview.

FOCUS RULES:
- Quick Revision: Concise high-yield facts only.
- Deep Understanding: Brief but clear explanations of mechanisms.
- Clinical Reasoning: Application-based scenarios and clinical decision-making.

DIFFICULTY RULES:
- Basic: simple language, minimal jargon, define key terms, suitable for early med students.
- Intermediate: assume Year 3-4 medical student level, standard terminology.
- Advanced: clinician-level depth, full technical terminology, include nuanced distinctions.

LENGTH RULES:
- Concise: minimum viable information, ultra-scannable, shortest possible output.
- Moderate: balanced detail, cover all sections adequately.
- Detailed: expand every section fully, include edge cases and nuances.

${sheetSchemaBlock}`;

    const userContent = enhanceMode
      ? `Topic: ${enhanceTopic}\nSection: ${sectionKey}\nItem: ${itemText}`
      : focusCard && !cardsOnly
      ? `Focus specifically on this concept: ${focusCard}\n\nTopic: ${notes}`
      : notes;

    const OPENROUTER_API_KEY = Deno.env.get("OPENROUTER_API_KEY");
    if (!OPENROUTER_API_KEY) {
      throw new Error("OPENROUTER_API_KEY is not configured");
    }

    // ── MODEL SELECTION LOGIC ──────────────────────────────────────────────
    // Pro + Claude toggle → Claude Haiku 4.5
    // Free/anon hook (first 1-3 gens) → Claude Haiku 4.5 (premium hook)
    // After hook exhausted → GPT-OSS 20B
    // Pro default → GPT-OSS 20B

    const ANON_PREMIUM_LIMIT = 1;
    const FREE_PREMIUM_LIMIT = 3;

    let model: string;
    let isPremiumGeneration = false;

    // Enhance calls: simple tier routing, no premium hook tracking
    if (enhanceMode) {
      model = isPro ? "anthropic/claude-haiku-4.5" : "openai/gpt-oss-20b";
      isPremiumGeneration = isPro;
    } else if (isPro) {
      if (preferredModel === "claude") {
        model = "anthropic/claude-haiku-4.5";
        isPremiumGeneration = true;
      } else {
        model = "openai/gpt-oss-20b";
        isPremiumGeneration = false;
      }
    } else {
      const premiumLimit = isAnonymous ? ANON_PREMIUM_LIMIT : FREE_PREMIUM_LIMIT;
      let currentPremiumUsed = 0;

      if (userId) {
        const { data: profileData } = await (await import("https://esm.sh/@supabase/supabase-js@2"))
          .createClient(
            Deno.env.get("SUPABASE_URL")!,
            Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
          )
          .from("profiles")
          .select("premium_used")
          .eq("id", userId)
          .maybeSingle();
        currentPremiumUsed = profileData?.premium_used ?? 0;
      }

      if (currentPremiumUsed < premiumLimit) {
        model = "anthropic/claude-haiku-4.5";
        isPremiumGeneration = true;

        if (userId) {
          await (await import("https://esm.sh/@supabase/supabase-js@2"))
            .createClient(
              Deno.env.get("SUPABASE_URL")!,
              Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
            )
            .from("profiles")
            .update({ premium_used: currentPremiumUsed + 1 })
            .eq("id", userId);
        }
      } else {
        model = "openai/gpt-oss-20b";
        isPremiumGeneration = false;
      }
    }

    // ── PROMPT SELECTION ───────────────────────────────────────────────────
    const isHaiku = model === "anthropic/claude-haiku-4.5";

    if (enhanceMode === "expand") {
      systemPrompt = isHaiku ? haikuExpandPrompt : gptOssExpandPrompt;
    } else if (enhanceMode === "clinical") {
      systemPrompt = isHaiku ? haikuClinicalPrompt : gptOssClinicalPrompt;
    } else if (explainMode) {
      systemPrompt = isHaiku ? haikuExplainPrompt : gptOssExplainPrompt;
    } else if (cardsOnly) {
      const count = Math.min(Math.max(parseInt(cardCount) || 12, 5), 20);
      systemPrompt = isHaiku ? haikuCardsPrompt(count) : gptOssCardsPrompt(count);
    } else {
      systemPrompt = isHaiku ? haikuSheetPrompt : gptOssSheetPrompt;
    }

    const providerRouting = model.startsWith("openai/gpt-oss")
      ? { provider: { order: ["Cerebras", "Groq"], allow_fallbacks: true } }
      : model === "anthropic/claude-haiku-4.5"
      ? { provider: { order: ["Anthropic"], allow_fallbacks: true } }
      : {};

    console.log("[MODEL_USED]:", model, "| isPremium:", isPremiumGeneration);

    // ── SERVER-SIDE DAILY QUOTA ────────────────────────────────────────────
    // Sheets and cards count toward the free/anon daily cap; explain and enhance
    // do not. Pro users are uncapped (determined server-side, not from the body).
    // Consume before calling OpenRouter; refund below if the upstream call fails
    // so failed generations never burn quota.
    const DAILY_CAP = 5;
    const quotaEligible = !explainMode && !enhanceMode;
    const usageKind = cardsOnly ? "cards" : "sheet";
    let quotaConsumed = false;

    if (quotaEligible) {
      const { data: proProfile } = await authClient
        .from("profiles")
        .select("is_pro, pro_expires_at")
        .eq("id", user.id)
        .maybeSingle();
      const isProUser =
        proProfile?.is_pro === true &&
        (proProfile.pro_expires_at === null ||
          new Date(proProfile.pro_expires_at) > new Date());

      if (!isProUser) {
        const { data: consumeResult, error: consumeError } = await authClient.rpc(
          "consume_usage",
          { p_user: user.id, p_kind: usageKind, p_cap: DAILY_CAP }
        );
        if (consumeError) {
          console.error("consume_usage failed:", consumeError);
          return new Response(
            JSON.stringify({ error: "quota_check_failed" }),
            { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
        if (!consumeResult?.allowed) {
          return new Response(
            JSON.stringify({ error: "quota_exceeded" }),
            { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
        quotaConsumed = true;
      }
    }

    let response: Response;
    try {
      response = await fetch(
        "https://openrouter.ai/api/v1/chat/completions",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
            "HTTP-Referer": "https://studybuddy.app",
            "X-Title": "StudyBuddy",
          },
          body: JSON.stringify({
            model,
            stream: true,
            temperature: 0.7,
            max_tokens: 8192,
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user", content: userContent },
            ],
            ...providerRouting,
          }),
        }
      );
    } catch (fetchErr) {
      // Network failure reaching OpenRouter — refund and rethrow to the 500 handler.
      if (quotaConsumed) {
        try {
          await authClient.rpc("refund_usage", { p_user: user.id, p_kind: usageKind });
        } catch { /* best effort */ }
      }
      throw fetchErr;
    }

    if (!response.ok) {
      // Upstream failure — refund the consumed unit so it doesn't burn quota.
      if (quotaConsumed) {
        try {
          await authClient.rpc("refund_usage", { p_user: user.id, p_kind: usageKind });
        } catch { /* best effort */ }
      }
      if (response.status === 429) {
        return new Response(
          JSON.stringify({ error: "Rate limit exceeded. Please try again in a moment." }),
          { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      if (response.status === 400) {
        const t = await response.text();
        console.error("AI 400 error:", t);
        return new Response(
          JSON.stringify({ error: "Bad request to AI service" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      if (response.status === 403) {
        return new Response(
          JSON.stringify({ error: "Invalid or missing API key" }),
          { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      const t = await response.text();
      console.error("AI error:", response.status, t);
      return new Response(
        JSON.stringify({ error: "AI service error" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    let buffer = "";

    const transform = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        buffer += decoder.decode(chunk, { stream: true });
        const events = buffer.split(/\r?\n\r?\n/);
        buffer = events.pop() ?? "";

        for (const event of events) {
          const trimmed = event.trim();
          if (!trimmed) continue;

          const dataLine = trimmed
            .split("\n")
            .find((line) => line.startsWith("data:"));
          if (!dataLine) {
            continue;
          }

          const payload = dataLine.slice(5).trim();
          if (!payload || payload === "[DONE]" || payload.includes("[DONE]")) continue;

          try {
            const parsed = JSON.parse(payload);
            const text = parsed?.choices?.[0]?.delta?.content;
            if (typeof text !== "string" || text.length === 0) continue;
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify(parsed)}\n\n`)
            );
          } catch {
            // skip unparseable chunks silently
          }
        }
      },
      flush(controller) {
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      },
    });

    return new Response(response.body!.pipeThrough(transform), {
      headers: {
        ...corsHeaders,
        "Content-Type": "text/event-stream",
        "X-Model-Used": model,
        "X-Is-Premium": isPremiumGeneration ? "true" : "false",
      },
    });
  } catch (e) {
    console.error("medical-notes error:", e);
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
