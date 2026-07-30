export const READ_ONLY_ZONE = "raw" as const;

export const WRITABLE_ZONES = [
  "canonical",
  "analyses",
  "embeddings",
  "indexes",
  "logs",
] as const;

export type WritableZone = (typeof WRITABLE_ZONES)[number];
export type DataZone = WritableZone | typeof READ_ONLY_ZONE;

export const DATA_ZONES: readonly DataZone[] = [
  READ_ONLY_ZONE,
  ...WRITABLE_ZONES,
];

export function isWritableZone(value: string): value is WritableZone {
  return (WRITABLE_ZONES as readonly string[]).includes(value);
}

export function isDataZone(value: string): value is DataZone {
  return (DATA_ZONES as readonly string[]).includes(value);
}

/** Project folder under LOCAL_DATA_ROOT, e.g. P01 */
export const PROJECT_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
