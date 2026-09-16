import { z } from "../openapi";

export const instanceStorageStatusResponseSchema = z
  .object({
    backend: z.enum(["local", "s3"]).openapi({
      description: "Currently active storage backend for new uploads.",
      example: "local",
    }),
    source: z.enum(["database", "environment", "default"]).openapi({
      description:
        "Source of active storage configuration: 'database' (saved in web UI), 'environment' (STORAGE_BACKEND env), or 'default' (S3 fallback).",
      example: "database",
    }),
    version: z.number().int().openapi({
      description: "Current settings version counter.",
      example: 1,
    }),
    localConfigured: z.boolean().openapi({
      description:
        "Whether local storage has valid directory configuration in environment.",
      example: true,
    }),
    s3Configured: z.boolean().openapi({
      description:
        "Whether S3 has required bucket, endpoint and credentials in environment.",
      example: false,
    }),
    localReason: z.string().nullable().optional().openapi({
      description:
        "Configuration guidance if local storage is missing required settings.",
      example: null,
    }),
    s3Reason: z.string().nullable().optional().openapi({
      description: "Configuration guidance if S3 is missing required settings.",
      example: "S3_ENDPOINT and S3_BUCKET must be configured in environment.",
    }),
  })
  .openapi("InstanceStorageStatus");

export const instanceStorageCheckResponseSchema = z
  .object({
    backend: z.enum(["local", "s3"]).openapi({
      description: "The tested backend.",
      example: "local",
    }),
    success: z.boolean().openapi({
      description: "Whether the write/read/delete probe succeeded.",
      example: true,
    }),
    checkedAt: z.string().openapi({
      description: "ISO timestamp when the probe ran.",
      example: "2026-09-16T12:00:00.000Z",
    }),
    error: z.string().nullable().openapi({
      description: "Safe, actionable error description if the probe failed.",
      example: null,
    }),
  })
  .openapi("InstanceStorageCheckResult");
