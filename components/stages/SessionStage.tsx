"use client";

import { useRef } from "react";
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

  return (
    <>
      <StageHead
        eyebrow={STAGE_ORDINALS[1]}
        title="توثيق الجلسة"
        description="سجّل حوار الجلسة. المساعد الصوتي يحوّل الكلام إلى نص عربي — وفي التجربة الحالية يمكن كتابة الحوار أو لصقه يدوياً."
      />
      <Card
        title="المساعد الصوتي"
        sub="يحوّل حوار الجلسة إلى نص مباشرةً. (يتطلّب ربطاً خلفياً للتفريغ الصوتي عند الرفع الفعلي.)"
      >
        <VoiceRecorder
          onTranscript={(line) => {
            dispatch({ type: "appendDialogue", line });
            const el = dialogueRef.current;
            if (el) el.scrollTop = el.scrollHeight;
          }}
        />
        <Field label="نص حوار الجلسة" last>
          <TextArea
            tall
            ref={dialogueRef}
            placeholder={"الطبيب: …\nالمريض: …"}
            value={state.dialogue}
            onChange={(e) =>
              dispatch({ type: "dialogue", value: e.target.value })
            }
          />
        </Field>
      </Card>
    </>
  );
}
