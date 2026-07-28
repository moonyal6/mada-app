"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { useToast } from "@/components/ui/ToastProvider";
import { useSession } from "@/lib/session-store";

/** `.manual-add` — the always-available escape hatch when search is unusable. */
export function ManualAddExercise({ open }: { open: boolean }) {
  const { dispatch } = useSession();
  const toast = useToast();
  const [ar, setAr] = useState("");
  const [en, setEn] = useState("");
  const [desc, setDesc] = useState("");
  const [url, setUrl] = useState("");

  if (!open) return null;

  const add = () => {
    const name = ar.trim();
    if (!name) {
      toast("اكتب اسم التمرين");
      return;
    }
    dispatch({
      type: "addExercise",
      exercise: { ar: name, en: en.trim(), desc: desc.trim() },
      url: url.trim(),
    });
    setAr("");
    setEn("");
    setDesc("");
    setUrl("");
    toast("أُضيف التمرين للسلّة");
  };

  return (
    <div className="mt-[14px] border-t border-dashed border-line pt-[14px]">
      <div className="grid grid-cols-3 gap-4 max-[900px]:grid-cols-1">
        <Field last>
          <Input
            type="text"
            placeholder="اسم التمرين (عربي)"
            value={ar}
            onChange={(e) => setAr(e.target.value)}
          />
        </Field>
        <Field last>
          <Input
            type="text"
            placeholder="Name (English)"
            value={en}
            onChange={(e) => setEn(e.target.value)}
          />
        </Field>
        <Field last>
          <Input
            type="text"
            placeholder="وصف موجز"
            value={desc}
            onChange={(e) => setDesc(e.target.value)}
          />
        </Field>
      </div>
      <div className="mt-2.5 flex gap-2.5 max-[600px]:flex-col">
        <Input
          type="text"
          placeholder="رابط فيديو التنفيذ (اختياري)"
          className="flex-1"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
        <Button variant="soft" onClick={add}>
          أضف للسلّة
        </Button>
      </div>
    </div>
  );
}
