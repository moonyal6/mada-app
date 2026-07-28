import { twMerge, type ClassNameValue } from "tailwind-merge";

/**
 * Joins class names and resolves Tailwind conflicts by last-wins, so a caller
 * can override a component's defaults (`px-2.5` over `px-[13px]`) without
 * depending on the order utilities happen to land in the stylesheet.
 */
export function cn(...parts: ClassNameValue[]): string {
  return twMerge(parts);
}
