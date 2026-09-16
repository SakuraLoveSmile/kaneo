import {
  checkStorageBackend,
  type StorageBackend,
  type StorageCheckResult,
} from "../../storage";

export default async function checkInstanceStorage(
  backend: StorageBackend,
): Promise<StorageCheckResult> {
  return checkStorageBackend(backend);
}
