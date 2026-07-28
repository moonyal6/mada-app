import { NoVideoTile } from "@/components/exercises/NoVideoTile";
import { QrCode } from "@/components/exercises/QrCode";
import { toAr } from "@/lib/arabic";
import type { SelectedExercise } from "@/lib/types";

export function HandoutExerciseRow({
  index,
  exercise,
}: {
  index: number;
  exercise: SelectedExercise;
}) {
  return (
    <div className="flex items-center gap-4 border-b border-line-2 py-[15px] last:border-b-0">
      <div className="grid h-[30px] w-[30px] shrink-0 place-items-center rounded-full bg-brand-soft text-[13px] font-semibold text-brand-dark">
        {toAr(index + 1)}
      </div>
      <div className="flex-1">
        <div className="text-[15px] font-semibold">{exercise.ar}</div>
        <div className="text-start text-xs text-muted [direction:ltr]">
          {exercise.en}
        </div>
        <div className="mt-0.5 text-[12.5px] text-muted">{exercise.desc}</div>
      </div>
      {exercise.url ? (
        <QrCode
          url={exercise.url}
          cellSize={3}
          margin={0}
          className="h-[66px] w-[66px] shrink-0 rounded-[7px] border border-line p-[3px] [&_svg]:h-full [&_svg]:w-full"
        />
      ) : (
        <NoVideoTile className="h-[66px] w-[66px]" />
      )}
    </div>
  );
}
