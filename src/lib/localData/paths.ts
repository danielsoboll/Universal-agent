import path from "path";
import { LocalDataError } from "@/lib/localData/errors";
import { getLocalDataRoot } from "@/lib/localData/root";
import {
  isDataZone,
  isWritableZone,
  PROJECT_KEY_PATTERN,
  READ_ONLY_ZONE,
  type DataZone,
  type WritableZone,
} from "@/lib/localData/zones";

function assertSafeSegment(segment: string, label: string): string {
  if (!segment || segment.includes("\0")) {
    throw new LocalDataError("PATH_ESCAPE", `Ungültiges Pfadsegment (${label}).`);
  }
  if (segment === "." || segment === "..") {
    throw new LocalDataError(
      "PATH_ESCAPE",
      `Pfadsegment "${segment}" ist nicht erlaubt (${label}).`,
    );
  }
  if (segment.includes("/") || segment.includes("\\")) {
    throw new LocalDataError(
      "PATH_ESCAPE",
      `Pfadsegment darf keine Trennzeichen enthalten (${label}): "${segment}"`,
    );
  }
  return segment;
}

export function assertProjectKey(projectKey: string): string {
  const key = projectKey.trim();
  if (!PROJECT_KEY_PATTERN.test(key)) {
    throw new LocalDataError(
      "INVALID_PROJECT",
      `Ungültiger Projekt-Schlüssel "${projectKey}". Erlaubt: Buchstaben, Ziffern, _ und - (z. B. P01).`,
    );
  }
  return key;
}

/** True if candidate is root or a path strictly inside root. */
export function isPathInsideRoot(root: string, candidate: string): boolean {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  const relative = path.relative(resolvedRoot, resolvedCandidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

export function assertPathWithinRoot(
  absoluteOrResolved: string,
  root = getLocalDataRoot(),
): string {
  const resolved = path.resolve(absoluteOrResolved);
  if (!isPathInsideRoot(root, resolved)) {
    throw new LocalDataError(
      "PATH_ESCAPE",
      `Pfad liegt außerhalb von LOCAL_DATA_ROOT.\n  Root: ${root}\n  Pfad: ${resolved}`,
    );
  }
  return resolved;
}

/**
 * Resolve path segments under LOCAL_DATA_ROOT.
 * Rejects absolute segments and `..` escapes.
 */
export function resolveLocalPath(...segments: string[]): string {
  const root = getLocalDataRoot();
  for (const segment of segments) {
    if (path.isAbsolute(segment)) {
      throw new LocalDataError(
        "PATH_ESCAPE",
        `Absolute Pfadsegmente sind nicht erlaubt: "${segment}"`,
      );
    }
  }

  const joined = path.resolve(root, ...segments);
  return assertPathWithinRoot(joined, root);
}

export function resolveProjectZonePath(
  projectKey: string,
  zone: DataZone,
  ...relativeParts: string[]
): string {
  const key = assertProjectKey(projectKey);
  if (!isDataZone(zone)) {
    throw new LocalDataError(
      "INVALID_ZONE",
      `Unbekannte Daten-Zone "${zone}". Erlaubt: raw, canonical, analyses, embeddings, indexes, logs.`,
    );
  }

  const safeParts = relativeParts.map((part, index) => {
    // Allow nested relative paths as one string ("a/b"), but validate each piece.
    return path
      .normalize(part)
      .split(path.sep)
      .filter((p) => p.length > 0 && p !== ".")
      .map((p) => assertSafeSegment(p, `relativ[${index}]`));
  });

  return resolveLocalPath(key, zone, ...safeParts.flat());
}

export function resolveRawPath(
  projectKey: string,
  ...relativeParts: string[]
): string {
  return resolveProjectZonePath(projectKey, READ_ONLY_ZONE, ...relativeParts);
}

export function resolveWritablePath(
  projectKey: string,
  zone: WritableZone,
  ...relativeParts: string[]
): string {
  if (!isWritableZone(zone)) {
    throw new LocalDataError(
      "INVALID_ZONE",
      `Zone "${zone}" ist nicht beschreibbar. Schreiben nur unter: canonical, analyses, embeddings, indexes, logs.`,
    );
  }
  return resolveProjectZonePath(projectKey, zone, ...relativeParts);
}

export type LocatedLocalPath = {
  absolutePath: string;
  relativeFromRoot: string;
  projectKey: string;
  zone: DataZone;
  rest: string[];
};

/**
 * Parse an absolute path that must live under LOCAL_DATA_ROOT/{project}/{zone}/...
 */
export function locateUnderRoot(absolutePath: string): LocatedLocalPath {
  const root = getLocalDataRoot();
  const absolute = assertPathWithinRoot(absolutePath, root);
  const relativeFromRoot = path.relative(root, absolute);
  const parts = relativeFromRoot.split(path.sep).filter(Boolean);

  if (parts.length < 2) {
    throw new LocalDataError(
      "INVALID_ZONE",
      `Pfad muss unter {Projekt}/{Zone}/… liegen: ${absolute}`,
    );
  }

  const [projectKey, zone, ...rest] = parts;
  assertProjectKey(projectKey);
  if (!isDataZone(zone)) {
    throw new LocalDataError(
      "INVALID_ZONE",
      `Unbekannte Zone "${zone}" in Pfad: ${absolute}`,
    );
  }

  return {
    absolutePath: absolute,
    relativeFromRoot,
    projectKey,
    zone,
    rest,
  };
}

export function assertRawReadPath(absolutePath: string): string {
  const located = locateUnderRoot(absolutePath);
  if (located.zone !== READ_ONLY_ZONE) {
    throw new LocalDataError(
      "INVALID_ZONE",
      `Rohdaten-Lesezugriff nur unter "${READ_ONLY_ZONE}/", erhalten: ${located.relativeFromRoot}`,
    );
  }
  return located.absolutePath;
}

export function assertWritablePath(absolutePath: string): string {
  const located = locateUnderRoot(absolutePath);
  if (!isWritableZone(located.zone)) {
    throw new LocalDataError(
      "RAW_WRITE_FORBIDDEN",
      `Schreiben unter "${READ_ONLY_ZONE}/" ist verboten. Erlaubt: canonical, analyses, embeddings, indexes, logs.\n  Pfad: ${located.relativeFromRoot}`,
    );
  }
  return located.absolutePath;
}
