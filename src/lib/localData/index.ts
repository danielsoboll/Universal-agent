import "server-only";

export { LocalDataError } from "@/lib/localData/errors";
export { getLocalDataRoot } from "@/lib/localData/root";
export {
  assertPathWithinRoot,
  assertProjectKey,
  assertRawReadPath,
  assertWritablePath,
  isPathInsideRoot,
  locateUnderRoot,
  resolveLocalPath,
  resolveProjectZonePath,
  resolveRawPath,
  resolveWritablePath,
  type LocatedLocalPath,
} from "@/lib/localData/paths";
export {
  appendLogLine,
  deleteGeneratedPath,
  ensureWritableDir,
  listRawEntries,
  listWritableEntries,
  readRawBuffer,
  readRawText,
  writeGeneratedText,
} from "@/lib/localData/fs";
export {
  DATA_ZONES,
  isDataZone,
  isWritableZone,
  PROJECT_KEY_PATTERN,
  READ_ONLY_ZONE,
  WRITABLE_ZONES,
  type DataZone,
  type WritableZone,
} from "@/lib/localData/zones";
