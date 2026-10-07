import { useId } from "react";
import { clamp } from "./format";
import type { Brush } from "./canvas/scatter";

interface BrushFieldsProps {
  brush: Brush | null;
  /** Changes when the brush moved from the canvas, so the uncontrolled inputs show the new numbers. */
  rev: number;
  maxAgeDays: number;
  onChange: (brush: Brush | null) => void;
}

const FIELDS = ["a0", "a1", "s0", "s1"] as const;
const NAMES = { a0: "Age from, days", a1: "Age to, days", s0: "Strength from", s1: "Strength to" };

const show = (brush: Brush | null, key: (typeof FIELDS)[number]): string => {
  if (!brush) return "";
  return key[0] === "a" ? String(Math.round(brush[key])) : brush[key].toFixed(2);
};

function read(form: HTMLFormElement, maxAgeDays: number): Brush | null {
  const raw = FIELDS.map((key) => form.elements.namedItem(key)).map((el) => (el instanceof HTMLInputElement ? el.value.trim() : ""));
  if (raw.every((v) => v === "")) return null;
  const num = (v: string, blank: number): number => (v === "" || Number.isNaN(Number(v)) ? blank : Number(v));
  const ages = [clamp(num(raw[0], 0), 0, maxAgeDays), clamp(num(raw[1], maxAgeDays), 0, maxAgeDays)];
  const strengths = [clamp(num(raw[2], 0), 0, 1), clamp(num(raw[3], 1), 0, 1)];
  return { a0: Math.min(...ages), a1: Math.max(...ages), s0: Math.min(...strengths), s1: Math.max(...strengths) };
}

/** Four number inputs for the age and strength brush: the keyboard route to a filter the scatter drag also sets. */
export function BrushFields({ brush, rev, maxAgeDays, onChange }: BrushFieldsProps) {
  const id = useId();
  return (
    <form
      className="brush-fields"
      key={rev}
      onSubmit={(e) => e.preventDefault()}
      onChange={(e) => onChange(read(e.currentTarget, maxAgeDays))}
    >
      {FIELDS.map((key) => (
        <label key={key} htmlFor={`${id}-${key}`}>
          {NAMES[key]}
          <input
            id={`${id}-${key}`}
            name={key}
            className="ctl"
            type="number"
            inputMode="decimal"
            min={0}
            max={key[0] === "a" ? maxAgeDays : 1}
            step={key[0] === "a" ? 1 : 0.05}
            defaultValue={show(brush, key)}
          />
        </label>
      ))}
    </form>
  );
}
