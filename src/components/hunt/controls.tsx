import * as Switch from "@radix-ui/react-switch";
import { useRef, type KeyboardEvent } from "react";
import { radioKeyTarget, radioTabStop } from "./radio-keys.ts";

/**
 * A row of radio buttons with the radio-group keyboard pattern: one tab stop
 * (roving tabindex), arrow keys move and select, Home/End. 44-pixel targets.
 */
export function RadioRow<T extends string>({
  options,
  value,
  onChange,
  label,
  describedBy,
  className = "",
}: {
  options: { value: T; label: string }[];
  value: T | null;
  onChange: (value: T) => void;
  label: string;
  describedBy?: string;
  className?: string;
}) {
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const selected = options.findIndex((option) => option.value === value);
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const next = radioKeyTarget(event.key, index, options.length);
    if (next === null) return;
    event.preventDefault();
    onChange(options[next].value);
    buttons.current[next]?.focus();
  };
  return (
    <div
      className={`grid gap-1 rounded-lg bg-bg p-2 ${className}`}
      style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}
      role="radiogroup"
      aria-label={label}
      aria-describedby={describedBy}
    >
      {options.map((option, index) => (
        <button
          key={option.value}
          ref={(element) => {
            buttons.current[index] = element;
          }}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          tabIndex={radioTabStop(selected, index)}
          data-on={option.value === value}
          onClick={() => onChange(option.value)}
          onKeyDown={(event) => onKeyDown(event, index)}
          className="h-11 rounded-md text-sm text-muted data-[on=true]:bg-surface-2 data-[on=true]:text-fg"
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  hint,
  badge,
  disabled = false,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
  hint?: string;
  badge?: string | null;
  disabled?: boolean;
}) {
  return (
    <label className="flex min-h-11 items-center justify-between gap-4 py-1.5">
      <span>
        <span className="block">
          {label}
          {badge ? <Badge text={badge} /> : null}
        </span>
        {hint ? <span className="block text-sm text-muted">{hint}</span> : null}
      </span>
      <Switch.Root
        checked={checked}
        disabled={disabled}
        onCheckedChange={onChange}
        aria-label={label}
        className="relative h-7 w-12 shrink-0 rounded-full bg-surface-2 data-[state=checked]:bg-field disabled:opacity-40"
      >
        <Switch.Thumb className="block size-5 translate-x-1 rounded-full bg-fg transition-transform duration-150 data-[state=checked]:translate-x-6" />
      </Switch.Root>
    </label>
  );
}

export function Badge({ text }: { text: string }) {
  return <span className="ml-2 rounded-sm bg-surface-2 px-1.5 py-0.5 align-middle text-[10px] tracking-wide text-muted uppercase">{text}</span>;
}

/** A labeled one-of-many choice. Renders as a segmented control for short lists. */
export function Choice<T extends string>({
  value,
  choices,
  onChange,
  label,
}: {
  value: T;
  choices: { value: T; label: string }[];
  onChange: (value: T) => void;
  label: string;
}) {
  if (choices.length > 4) {
    return (
      <select className="field mt-1 h-11" value={value} aria-label={label} onChange={(event) => onChange(event.target.value as T)}>
        {choices.map((choice) => (
          <option key={choice.value} value={choice.value}>
            {choice.label}
          </option>
        ))}
      </select>
    );
  }
  return (
    <div className="mt-1 grid gap-1 rounded-lg bg-bg p-1" style={{ gridTemplateColumns: `repeat(${choices.length}, minmax(0, 1fr))` }} role="radiogroup" aria-label={label}>
      {choices.map((choice) => (
        <button
          key={choice.value}
          type="button"
          role="radio"
          aria-checked={value === choice.value}
          data-on={value === choice.value}
          onClick={() => onChange(choice.value)}
          className="min-h-10 rounded-md px-1 text-sm text-muted data-[on=true]:bg-surface-2 data-[on=true]:text-fg"
        >
          {choice.label}
        </button>
      ))}
    </div>
  );
}
