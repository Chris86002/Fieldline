import * as Switch from "@radix-ui/react-switch";

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
