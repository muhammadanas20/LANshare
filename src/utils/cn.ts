export type ClassValue = string | number | null | false | undefined | ClassValue[];

/** Tiny classname joiner (no dependency needed for what we use). */
export function cn(...values: ClassValue[]): string {
  const out: string[] = [];
  const walk = (value: ClassValue) => {
    if (!value) return;
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    out.push(String(value));
  };
  values.forEach(walk);
  return out.join(' ');
}
