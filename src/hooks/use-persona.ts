import { useState } from "react";

export type Persona = "student" | "clinician" | "expert";

const KEY = "sb_persona_v1";
const DEFAULT: Persona = "student";

function read(): Persona {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "student" || v === "clinician" || v === "expert") return v;
  } catch { /* ignore */ }
  return DEFAULT;
}

export function usePersona() {
  const [persona, setPersonaState] = useState<Persona>(read);

  const setPersona = (p: Persona) => {
    try { localStorage.setItem(KEY, p); } catch { /* ignore */ }
    setPersonaState(p);
  };

  return { persona, setPersona };
}
