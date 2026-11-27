import { english } from "./model.ts";
import type { Family } from "./model.ts";
import { normalizeRate, validPrice } from "./pricing.ts";

type PreparedFamily = { family: Family } | { error: string; variantId?: string };

export function prepareFamily(family: Family, original: Family | undefined, at: string): PreparedFamily {
  const name = family.name.trim();
  if (!name || !english(name)) return { error: "Enter a product name in English." };

  const sizes = new Set<string>();
  for (const item of family.variants) {
    const size = item.variant.trim().toLowerCase();
    const error = item.purchase && !validPrice(item.purchase)
      ? "Enter a positive purchase price with up to two decimal places."
      : item.rate && !validPrice(item.rate)
        ? "Enter a positive rate with up to two decimal places."
        : !english(item.variant)
          ? "Enter the size in English."
          : !size && family.variants.length > 1
            ? "Give each size a name."
            : sizes.has(size)
              ? "Each size needs a distinct name."
              : item.ready && !item.overridePhoto && !family.photo
                ? "Add a photo for the verified size."
                : "";
    if (error) return { error, variantId: item.id };
    sizes.add(size);
  }

  return {
    family: {
      ...family,
      name,
      variants: family.variants.map((item) => {
        const previous = original?.variants.find(({ id }) => id === item.id)?.rate ?? "";
        const rate = normalizeRate(item.rate, previous);
        return {
          ...item,
          variant: item.variant.trim(),
          purchase: item.purchase ? Number(item.purchase).toFixed(2) : "",
          rate,
          history: rate === previous ? item.history : [...item.history, { at, rate }],
        };
      }),
    },
  };
}
