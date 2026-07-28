"use client";

import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { toAr } from "@/lib/arabic";
import { useSession } from "@/lib/session-store";
import { BasketItem } from "./BasketItem";
import { ExerciseList } from "./ExerciseList";

export function Basket() {
  const { state } = useSession();
  const items = Object.entries(state.selected);

  return (
    <Card
      title={`سلّة التمارين المختارة (${toAr(items.length)})`}
      sub="هذه التمارين تدخل في التقرير ونشرة المريض. عدّل رابط الفيديو ليظهر QR الصحيح."
    >
      <ExerciseList>
        {items.length === 0 ? (
          <EmptyState className="p-6">لم تُختر تمارين بعد.</EmptyState>
        ) : (
          items.map(([id, exercise]) => (
            <BasketItem key={id} id={id} exercise={exercise} />
          ))
        )}
      </ExerciseList>
    </Card>
  );
}
