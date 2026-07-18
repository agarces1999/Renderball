/**
 * Ambient types for `linebreak` (MIT, v1.1.0) — Devon Govett's UAX#14 line
 * breaking implementation, and Satori's own break-opportunity dependency.
 *
 * The package ships no types. Its surface is exactly one class, so a hand
 * declaration is cheaper (and more honest) than pulling a @types shim.
 */
declare module "linebreak" {
  export interface LineBreakOpportunity {
    /** Index into the source string where a line MAY end (exclusive). */
    position: number;
    /** True for a MANDATORY break (\n, \r, U+2028/2029, …). */
    required: boolean;
  }
  export default class LineBreaker {
    constructor(text: string);
    /** Next break opportunity, or null once the string is exhausted. */
    nextBreak(): LineBreakOpportunity | null;
  }
}
