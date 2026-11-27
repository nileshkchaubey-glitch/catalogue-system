export { markedUp, validPrice } from "../shared/quote-pricing.mjs";

export function normalizeRate(value: string, previous: string) {
  if (!value) return "";
  return previous && Number(value) === Number(previous)
    ? previous
    : Number(value).toFixed(2);
}
