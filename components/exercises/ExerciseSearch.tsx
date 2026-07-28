"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { Spinner } from "@/components/ui/Spinner";
import { useToast } from "@/components/ui/ToastProvider";
import { useSession } from "@/lib/session-store";
import type { Exercise } from "@/lib/types";
import { ExerciseCard } from "./ExerciseCard";
import { ExerciseList } from "./ExerciseList";
import { ManualAddExercise } from "./ManualAddExercise";

const FAILURE_NOTE =
  "الاقتراح المباشر يعمل داخل بيئة كلود. على الاستضافة الخارجية يلزم ربط خلفي بمفتاح API — استخدم الآن الإضافة اليدوية أدناه.";

export function ExerciseSearch() {
  const { dispatch } = useSession();
  const toast = useToast();
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [suggestions, setSuggestions] = useState<Exercise[]>([]);
  const [added, setAdded] = useState<Record<number, boolean>>({});
  const [manualOpen, setManualOpen] = useState(false);

  const search = async () => {
    const q = query.trim();
    if (!q) {
      toast("اكتب اسم التمرين أو الهدف");
      return;
    }
    setBusy(true);
    setFailed(false);
    setSuggestions([]);
    setAdded({});
    try {
      const res = await fetch("/api/exercises", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: q }),
      });
      if (!res.ok) throw new Error("api");
      const data: { exercises?: Exercise[] } = await res.json();
      const list = data.exercises;
      if (!Array.isArray(list) || !list.length) throw new Error("empty");
      setBusy(false);
      setSuggestions(list);
    } catch {
      // Same fallback as the MVP: explain, then reveal the manual panel.
      setBusy(false);
      setFailed(true);
      setManualOpen(true);
    }
  };

  return (
    <Card
      title="إضافة تمارين لمشكلات مرتبطة"
      sub="اكتب اسم تمرين أو هدفاً علاجياً (مثل: تقوية عضلات لوح الكتف · تحسين التوازن · إطالة أوتار الفخذ) وتقترح المنصّة تمارين إضافية."
    >
      <div className="mb-1.5 flex gap-2.5 max-[600px]:flex-col">
        <Input
          type="text"
          placeholder="اسم التمرين أو الهدف العلاجي…"
          className="flex-1"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") search();
          }}
        />
        <Button variant="primary" disabled={busy} onClick={search}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="11" cy="11" r="7" />
            <path d="M21 21l-4.3-4.3" />
          </svg>{" "}
          اقترح تمارين
        </Button>
      </div>

      {busy || failed ? (
        <div className="my-4 flex items-center gap-2 text-[13px] text-muted">
          {busy ? (
            <>
              <Spinner /> جارٍ اقتراح تمارين…
            </>
          ) : (
            FAILURE_NOTE
          )}
        </div>
      ) : null}

      <ExerciseList className="mt-1.5">
        {suggestions.map((exercise, i) => (
          <ExerciseCard
            key={`${exercise.ar}-${i}`}
            exercise={exercise}
            faded={added[i]}
            action={
              <Button
                variant="soft"
                size="sm"
                onClick={() => {
                  dispatch({ type: "addExercise", exercise });
                  setAdded((prev) => ({ ...prev, [i]: true }));
                  toast("أُضيف للسلّة");
                }}
              >
                {added[i] ? "أُضيف" : "أضف"}
              </Button>
            }
          />
        ))}
      </ExerciseList>

      <Button
        variant="ghost"
        size="sm"
        className="mt-3"
        onClick={() => setManualOpen((open) => !open)}
      >
        أو أضف تمريناً يدوياً
      </Button>
      <ManualAddExercise open={manualOpen} />
    </Card>
  );
}
