import { client } from "@kaneo/libs";
import type { InferResponseType } from "hono/client";

export type InstanceStorageStatus = InferResponseType<
  (typeof client)["instance"]["storage"]["$get"],
  200
>;

export async function getInstanceStorage(): Promise<InstanceStorageStatus> {
  const response = await client.instance.storage.$get();

  if (!response.ok) {
    const error = await response.text();
    throw new Error(error);
  }

  return response.json();
}
