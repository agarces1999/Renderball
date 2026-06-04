import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Standard Tailwind class concatenator: clsx for conditional logic +
 * tailwind-merge to resolve conflicting utilities ("px-2 px-4" → "px-4").
 */
export const cn = (...inputs: ClassValue[]) => twMerge(clsx(inputs));
