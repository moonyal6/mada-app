"use client";

import { Input } from "@/components/ui/Input";
import { useSession } from "@/lib/session-store";
import type { SelectedExercise } from "@/lib/types";
import { QrCode } from "./QrCode";

export function BasketItem({
  id,
  exercise,
}: {
  id: string;
  exercise: SelectedExercise;
}) {
  const { dispatch } = useSession();

  return (
    <div className="flex items-start gap-[14px] rounded-field border-[1.5px] border-brand-soft bg-surface px-[15px] py-[13px]">
      <QrCode
        url={exercise.url}
        cellSize={3}
        margin={1}
        className="h-[70px] w-[70px] shrink-0 rounded-lg border border-line bg-surface p-1 [&_svg]:h-full [&_svg]:w-full"
      />
      <div className="flex-1">
        <div className="flex items-center">
          <span className="font-semibold">{exercise.ar}</span>
          {exercise.source === "added" ? (
            <span className="ms-2 rounded-full bg-gold-soft px-2 py-0.5 text-[10.5px] font-semibold text-gold-ink">
              مضاف
            </span>
          ) : null}
          <div className="flex-1" />
          <button
            type="button"
            onClick={() => dispatch({ type: "removeExercise", id })}
            className="shrink-0 border-none bg-transparent px-1.5 py-0.5 text-[12.5px] font-semibold text-danger"
          >
            إزالة
          </button>
        </div>
        <div className="text-start text-xs text-muted [direction:ltr]">
          {exercise.en}
        </div>
        <div className="mt-0.5 text-[12.5px] text-muted">{exercise.desc}</div>
        <div className="mt-2">
          <label className="text-[11.5px] font-medium text-muted">
            رابط الفيديو (QR)
          </label>
          <Input
            type="text"
            value={exercise.url}
            onChange={(e) =>
              dispatch({ type: "exerciseUrl", id, url: e.target.value })
            }
            className="mt-[3px] px-2.5 py-[7px] text-start text-xs leading-[normal] [direction:ltr]"
          />
        </div>
      </div>
    </div>
  );
}
