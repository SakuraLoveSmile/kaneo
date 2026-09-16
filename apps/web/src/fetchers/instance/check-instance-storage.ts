import { client } from "@kaneo/libs";
import type { InferResponseType } from "hono/client";

export type InstanceStorageCheckResult = InferResponseType<
  (typeof client)["instance"]["storage"]["check"]["$post"],
  200
>;

export async function checkInstanceStorage(
  backend: "local" | "s3",
): Promise<InstanceStorageCheckResult> {
  const response = await client.instance.storage.check.$post({
    json: { backend },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(error);
  }

  return response.json();
}
