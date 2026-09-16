import { z } from "../openapi";

export const checkInstanceStorageSchema = z.object({
  backend: z.enum(["local", "s3"]).openapi({
    description: "The storage backend to test ('local' or 's3').",
    example: "local",
  }),
});

export const updateInstanceStorageSchema = z.object({
  backend: z.enum(["local", "s3", "default"]).nullable().openapi({
    description:
      "The storage backend to save ('local' or 's3'), or 'default' / null to restore deployment default.",
    example: "local",
  }),
  version: z.number().int().min(0).openapi({
    description: "Current settings version for optimistic concurrency control.",
    example: 1,
  }),
});

export type CheckInstanceStorageInput = z.infer<
  typeof checkInstanceStorageSchema
>;
export type UpdateInstanceStorageInput = z.infer<
  typeof updateInstanceStorageSchema
>;
