"use client";

import { Basket } from "@/components/exercises/Basket";
import { ExerciseCard } from "@/components/exercises/ExerciseCard";
import { ExerciseList } from "@/components/exercises/ExerciseList";
import { ExerciseSearch } from "@/components/exercises/ExerciseSearch";
import { Card } from "@/components/ui/Card";
import { StageHead } from "@/components/ui/StageHead";
import { CASES } from "@/lib/data/cases";
import { EX } from "@/lib/data/exercises";
import { STAGE_ORDINALS } from "@/lib/data/steps";
import { useSession } from "@/lib/session-store";

export function ExercisesStage() {
  const { state, dispatch } = useSession();
  const caseKey = state.patient.caseKey;
  const info = CASES[caseKey];

  return (
    <>
      <StageHead
        eyebrow={STAGE_ORDINALS[3]}
        title="التمارين المختارة"
        description="ابدأ بتمارين الحالة، ثم أضف تمارين لأي مشكلة مرتبطة عبر البحث بالاسم أو الهدف العلاجي — لست مقيّداً بالتشخيص وحده."
      />

      <Card>
        <div className="mb-[18px] flex items-center gap-2.5 rounded-field bg-brand-soft px-[15px] py-[11px] text-sm text-brand-dark">
          <b className="font-semibold">{info.label}</b>
          {` · المنطقة: ${info.region}`}
        </div>
        <h3 className="mb-1 text-base font-semibold text-brand-dark">
          تمارين الحالة
        </h3>
        <p className="mb-4 text-[13px] text-muted">
          انقر لاختيار التمرين وإضافته للسلّة.
        </p>
        <ExerciseList>
          {EX[caseKey].map((exercise, idx) => {
            const id = `case-${caseKey}-${idx}`;
            return (
              <ExerciseCard
                key={id}
                exercise={exercise}
                selected={Boolean(state.selected[id])}
                onSelect={() =>
                  dispatch({
                    type: "toggleCaseExercise",
                    id,
                    exercise: {
                      ar: exercise.ar,
                      en: exercise.en,
                      desc: exercise.desc,
                      // The library's video URL seeds the basket; the doctor
                      // can still override it per exercise.
                      url: exercise.video ?? "",
                      source: "case",
                    },
                  })
                }
              />
            );
          })}
        </ExerciseList>
      </Card>

      <ExerciseSearch />
      <Basket />
    </>
  );
}
