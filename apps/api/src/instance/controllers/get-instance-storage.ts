import {
  getInstanceStorageStatus,
  type InstanceStorageStatus,
} from "../../storage";

export default async function getInstanceStorage(): Promise<InstanceStorageStatus> {
  return getInstanceStorageStatus();
}
