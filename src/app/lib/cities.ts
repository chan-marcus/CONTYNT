// The cities a business can pick from, and the one place that turns a stored
// value back into something readable.
//
// City is stored as a slug ("new-york"), which is what the creator side has
// always written and what feature matching compares on. Left alone it also
// reaches the screen that way -- the business portal header was showing
// "new-york" -- so every display goes through cityLabel().
export const CITY_OPTIONS = [
  { value: "san-francisco", label: "San Francisco" },
  { value: "los-angeles", label: "Los Angeles" },
  { value: "new-york", label: "New York City" },
] as const;

export const cityLabel = (value?: string | null): string => {
  const v = (value || "").trim();
  if (!v) return "";
  const known = CITY_OPTIONS.find(c => c.value === v.toLowerCase());
  if (known) return known.label;
  // An "Other" city is stored as the owner typed it, so it only needs the
  // slug-shaped ones tidied.
  return /^[a-z0-9-]+$/.test(v)
    ? v.split("-").filter(Boolean).map(w => w[0].toUpperCase() + w.slice(1)).join(" ")
    : v;
};
