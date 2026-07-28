"use client";

import { useEffect, useRef } from "react";
import { ActionBar } from "@/components/layout/ActionBar";
import { MobileSteps } from "@/components/layout/MobileSteps";
import { Stepper } from "@/components/layout/Stepper";
import { StorageNotice } from "@/components/layout/StorageNotice";
import { TopBar } from "@/components/layout/TopBar";
import { DoctorOpinionStage } from "@/components/stages/DoctorOpinionStage";
import { ExercisesStage } from "@/components/stages/ExercisesStage";
import { HandoutStage } from "@/components/stages/HandoutStage";
import { PatientStage } from "@/components/stages/PatientStage";
import { ReportStage } from "@/components/stages/ReportStage";
import { SessionStage } from "@/components/stages/SessionStage";
import { usePersistence } from "@/lib/persistence";
import { useSession } from "@/lib/session-store";

const STAGES = [
  PatientStage,
  SessionStage,
  DoctorOpinionStage,
  ExercisesStage,
  ReportStage,
  HandoutStage,
];

export default function SessionFlow() {
  const { ready } = usePersistence();

  // Until localStorage has been read (client-only) the server and client both
  // render the bare shell, so restored state never causes a hydration
  // mismatch. See node_modules/next/dist/docs — "Preventing Flash".
  if (!ready) return <TopBar />;

  return <SessionView />;
}

function SessionView() {
  const { state, dispatch } = useSession();
  const mounted = useRef(false);
  const Stage = STAGES[state.step];

  // Today's date, set after mount so the server and client markup agree.
  useEffect(() => {
    if (!state.doctor.date) {
      dispatch({
        type: "doctorField",
        field: "date",
        value: new Date().toISOString().slice(0, 10),
      });
    }
    // Runs once, on mount — mirrors the MVP's init().
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // goto() scrolled to the top on every stage change, but not on first paint.
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, [state.step]);

  return (
    <>
      <TopBar />
      <MobileSteps />
      <div className="wrap mx-auto grid min-h-[calc(100vh-63px)] max-w-[1240px] grid-cols-[288px_1fr] max-[900px]:grid-cols-[1fr]">
        <Stepper />
        <main className="main px-[34px] pt-[30px] pb-[120px] max-[900px]:px-[18px] max-[900px]:pt-[22px] max-[900px]:pb-[130px]">
          <StorageNotice />
          {/* Only the active stage is mounted; `rise` still plays on entry
              because the subtree is new every time the step changes. */}
          <section key={state.step} className="animate-rise">
            <Stage />
          </section>
        </main>
      </div>
      <ActionBar />
    </>
  );
}
