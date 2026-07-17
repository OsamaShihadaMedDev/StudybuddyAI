import { supabase } from "@/integrations/supabase/client";

const MEDICAL_NOTES_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/medical-notes`;

/**
 * Request body accepted by the `medical-notes` edge function. All fields are
 * optional except `notes`; the edge function branches on which are present
 * (`cardsOnly`, `explainMode`, `enhanceMode`, …). The index signature keeps
 * existing callers passing extra fields compiling under the permissive tsconfig.
 */
export interface MedicalNotesParams {
  notes: string;
  difficulty?: string;
  focus?: string;
  length?: string;
  examMode?: string;
  persona?: "student" | "clinician" | "expert";
  cardsOnly?: boolean;
  cardCount?: number;
  focusCard?: unknown;
  explainMode?: boolean;
  enhanceMode?: string;
  itemText?: string;
  sectionKey?: string;
  sectionItems?: unknown[];
  enhanceTopic?: string;
  // Entitlement fields still sent by the client in PR1 (server continues to
  // read them as-is until server-side entitlement lands). Do not remove here.
  userId?: string | null;
  isAnonymous?: boolean;
  isPro?: boolean;
  preferredModel?: string;
  [key: string]: unknown;
}

export interface CallMedicalNotesOptions {
  /** Forwarded to fetch — used by the enhance flow to cancel in-flight requests. */
  signal?: AbortSignal;
}

/**
 * Single entry point for the `medical-notes` edge function.
 *
 * Reads the current Supabase session and attaches the user's access token as the
 * `Authorization: Bearer` header (replacing the publishable key). The edge
 * function verifies this JWT and returns 401 for a missing/invalid token.
 *
 * Returns the raw streaming `Response` so callers keep their existing SSE-reading
 * logic (headers, `.ok`, `response.body.getReader()`) unchanged.
 */
export async function callMedicalNotes(
  params: MedicalNotesParams,
  options: CallMedicalNotesOptions = {}
): Promise<Response> {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  const accessToken = session?.access_token ?? "";

  return fetch(MEDICAL_NOTES_URL, {
    method: "POST",
    signal: options.signal,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(params),
  });
}
