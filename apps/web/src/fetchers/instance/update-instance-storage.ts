import { client } from "@kaneo/libs";
import type { InferResponseType } from "hono/client";

export type UpdateInstanceStoragePayload = {
  backend: "local" | "s3" | "default" | null;
  version: number;
};

export type UpdatedInstanceStorageResponse = InferResponseType<
  (typeof client)["instance"]["storage"]["$put"],
  200
>;

export async function updateInstanceStorage(
  payload: UpdateInstanceStoragePayload,
): Promise<UpdatedInstanceStorageResponse> {
  const response = await client.instance.storage.$put({
    json: payload,
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(error);
  }

  return response.json();
}
