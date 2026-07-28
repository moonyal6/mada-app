"use client";

import { useRef, useState } from "react";
import { Card } from "@/components/ui/Card";
import { Field } from "@/components/ui/Field";
import { StageHead } from "@/components/ui/StageHead";
import { TextArea } from "@/components/ui/TextArea";
import { VoiceRecorder } from "@/components/voice/VoiceRecorder";
import { STAGE_ORDINALS } from "@/lib/data/steps";
import { useSession } from "@/lib/session-store";

export function SessionStage() {
  const { state, dispatch } = useSession();
  const dialogueRef = useRef<HTMLTextAreaElement>(null);
  // The phrase recognition is still working on. Shown live at the end of the
  // textarea but only committed to the dialogue once it finalizes — so
  // interim rewrites never touch saved state.
  const [interim, setInterim] = useState("");

  const scrollToEnd = () =>
    requestAnimationFrame(() => {
      const el = dialogueRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    });

  const shown = interim
    ? (state.dialogue ? state.dialogue + "\n" : "") + interim
    : state.dialogue;

  return (
    <>
      <StageHead
        eyebrow={STAGE_ORDINALS[1]}
        title="توثيق الجلسة"
        description="سجّل حوار الجلسة. المساعد الصوتي يحوّل الكلام إلى نص عربي — وفي التجربة الحالية يمكن كتابة الحوار أو لصقه يدوياً."
      />
      <Card title="المساعد الصوتي" sub="يحوّل حوار الجلسة إلى نص مباشرةً.">
        <VoiceRecorder
          onFinal={(line) => {
            setInterim("");
            dispatch({ type: "appendDialogue", line });
            scrollToEnd();
          }}
          onInterim={(text) => {
            setInterim(text);
            scrollToEnd();
          }}
        />
        <Field label="نص حوار الجلسة" last>
          <TextArea
            tall
            ref={dialogueRef}
            placeholder={"الطبيب: …\nالمريض: …"}
            value={shown}
            onChange={(e) => {
              // Typing while an interim phrase is on screen adopts the shown
              // text as-is; the phrase stops being provisional.
              if (interim) setInterim("");
              dispatch({ type: "dialogue", value: e.target.value });
            }}
          />
        </Field>
      </Card>
    </>
  );
}
