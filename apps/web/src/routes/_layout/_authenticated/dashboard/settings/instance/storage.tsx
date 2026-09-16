import { createFileRoute } from "@tanstack/react-router";
import {
  AlertCircle,
  CheckCircle2,
  Database,
  HardDrive,
  Info,
  RefreshCw,
  RotateCcw,
  Save,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import PageTitle from "@/components/page-title";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Separator } from "@/components/ui/separator";
import useCheckInstanceStorage from "@/hooks/mutations/instance/use-check-instance-storage";
import useUpdateInstanceStorage from "@/hooks/mutations/instance/use-update-instance-storage";
import useGetInstanceStorage from "@/hooks/queries/instance/use-get-instance-storage";
import { toast } from "@/lib/toast";

export const Route = createFileRoute(
  "/_layout/_authenticated/dashboard/settings/instance/storage",
)({
  component: StorageSettingsPage,
});

type CheckResultState = {
  backend: "local" | "s3";
  success: boolean;
  checkedAt: string;
  error: string | null;
};

function StorageSettingsPage() {
  const { t } = useTranslation();
  const {
    data: storageStatus,
    isLoading,
    isError,
    isRefetching,
    refetch,
  } = useGetInstanceStorage();

  const [selectedBackend, setSelectedBackend] = useState<"local" | "s3">("s3");
  const [checkResult, setCheckResult] = useState<CheckResultState | null>(null);
  const checkRequestIdRef = useRef(0);

  useEffect(() => {
    if (storageStatus?.backend && storageStatus.version !== undefined) {
      checkRequestIdRef.current += 1;
      setCheckResult(null);
      setSelectedBackend(storageStatus.backend);
    }
  }, [storageStatus?.backend, storageStatus?.version]);

  useEffect(
    () => () => {
      checkRequestIdRef.current += 1;
    },
    [],
  );

  const checkMutation = useCheckInstanceStorage();
  const updateMutation = useUpdateInstanceStorage();

  const isSaving = updateMutation.isPending;
  const isChecking = checkMutation.isPending;

  const isLocalConfigured = Boolean(storageStatus?.localConfigured);
  const isS3Configured = Boolean(storageStatus?.s3Configured);
  const hasAnyConfigured = isLocalConfigured || isS3Configured;
  const isSelectedConfigured =
    selectedBackend === "local" ? isLocalConfigured : isS3Configured;

  const handleSelectBackend = (val: "local" | "s3") => {
    if (val === selectedBackend) return;
    checkRequestIdRef.current += 1;
    setSelectedBackend(val);
    setCheckResult(null);
  };

  const handleCheckConnection = async () => {
    if (!storageStatus) return;
    const currentRequestId = ++checkRequestIdRef.current;
    const targetBackend = selectedBackend;

    try {
      const result = await checkMutation.mutateAsync(targetBackend);
      if (
        checkRequestIdRef.current === currentRequestId &&
        selectedBackend === targetBackend
      ) {
        setCheckResult({
          backend: targetBackend,
          success: result.success,
          checkedAt: result.checkedAt,
          error: result.error,
        });

        if (result.success) {
          toast.success(t("settings:storage.checkResult.success"));
        } else {
          toast.error(
            t("settings:storage.checkResult.failed", {
              error: result.error ?? "Unknown probe failure",
            }),
          );
        }
      }
    } catch (err) {
      if (
        checkRequestIdRef.current === currentRequestId &&
        selectedBackend === targetBackend
      ) {
        const msg = err instanceof Error ? err.message : String(err);
        setCheckResult({
          backend: targetBackend,
          success: false,
          checkedAt: new Date().toISOString(),
          error: msg,
        });
        toast.error(
          t("settings:storage.checkResult.failed", {
            error: msg,
          }),
        );
      }
    }
  };

  const handleSave = async () => {
    if (!storageStatus) return;
    try {
      await updateMutation.mutateAsync({
        backend: selectedBackend,
        version: storageStatus.version,
      });
      toast.success(t("settings:storage.toasts.saveSuccess"));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("409") || msg.includes("another administrator")) {
        toast.error(t("settings:storage.toasts.conflict"));
        void refetch();
      } else if (msg.includes("probe failed") || msg.includes("Probe failed")) {
        toast.error(t("settings:storage.toasts.probeFailed"));
      } else {
        toast.error(`${t("settings:storage.toasts.saveError")}: ${msg}`);
      }
    }
  };

  const handleRestoreDefault = async () => {
    if (!storageStatus) return;
    try {
      await updateMutation.mutateAsync({
        backend: "default",
        version: storageStatus.version,
      });
      toast.success(t("settings:storage.toasts.restoreSuccess"));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("409") || msg.includes("another administrator")) {
        toast.error(t("settings:storage.toasts.conflict"));
        void refetch();
      } else {
        toast.error(`${t("settings:storage.toasts.restoreError")}: ${msg}`);
      }
    }
  };

  const getSourceLabel = (source: string | undefined) => {
    switch (source) {
      case "database":
        return t("settings:storage.sourceDatabase");
      case "environment":
        return t("settings:storage.sourceEnvironment");
      default:
        return t("settings:storage.sourceDefault");
    }
  };

  if (isLoading && !storageStatus) {
    return (
      <>
        <PageTitle title={t("settings:storage.title")} />
        <div className="flex h-full flex-col gap-6 p-4 sm:p-6 max-w-4xl">
          <div>
            <h2 className="text-2xl font-bold tracking-tight">
              {t("settings:storage.title")}
            </h2>
            <p className="text-sm text-muted-foreground mt-1">
              {t("settings:storage.description")}
            </p>
          </div>
          <Separator />
          <Card className="p-12 flex flex-col items-center justify-center gap-3">
            <RefreshCw className="size-6 animate-spin text-muted-foreground" />
            <p className="text-sm text-muted-foreground">
              {t("settings:storage.actions.checking")}
            </p>
          </Card>
        </div>
      </>
    );
  }

  if (isError && !storageStatus) {
    return (
      <>
        <PageTitle title={t("settings:storage.title")} />
        <div className="flex h-full flex-col gap-6 p-4 sm:p-6 max-w-4xl">
          <div>
            <h2 className="text-2xl font-bold tracking-tight">
              {t("settings:storage.title")}
            </h2>
            <p className="text-sm text-muted-foreground mt-1">
              {t("settings:storage.description")}
            </p>
          </div>
          <Separator />
          <Alert variant="error">
            <AlertCircle className="size-4" />
            <AlertTitle>{t("settings:storage.loadError.title")}</AlertTitle>
            <AlertDescription className="mt-2 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
              <span>{t("settings:storage.loadError.description")}</span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => refetch()}
                className="gap-2 shrink-0"
              >
                <RefreshCw className="size-3.5" />
                {t("settings:storage.loadError.retry")}
              </Button>
            </AlertDescription>
          </Alert>
        </div>
      </>
    );
  }

  return (
    <>
      <PageTitle title={t("settings:storage.title")} />

      <div className="flex h-full flex-col gap-6 p-4 sm:p-6 max-w-4xl">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">
            {t("settings:storage.title")}
          </h2>
          <p className="text-sm text-muted-foreground mt-1">
            {t("settings:storage.description")}
          </p>
        </div>

        <Separator />

        {/* Background refresh failure banner */}
        {isError && storageStatus && (
          <Alert variant="error">
            <AlertCircle className="size-4" />
            <AlertTitle>{t("settings:storage.refreshFailed.title")}</AlertTitle>
            <AlertDescription className="mt-2 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
              <span>{t("settings:storage.refreshFailed.description")}</span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => refetch()}
                disabled={isRefetching}
                className="gap-2 shrink-0"
              >
                <RefreshCw
                  className={`size-3.5 ${isRefetching ? "animate-spin" : ""}`}
                />
                {t("settings:storage.loadError.retry")}
              </Button>
            </AlertDescription>
          </Alert>
        )}

        {/* Notice on switching / migration */}
        <Alert variant="warning">
          <Info className="size-4" />
          <AlertTitle>
            {t("settings:storage.migrationWarning.title")}
          </AlertTitle>
          <AlertDescription>
            {t("settings:storage.migrationWarning.description")}
          </AlertDescription>
        </Alert>

        {/* Current status overview */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {t("settings:storage.effectiveBackend")}
            </CardTitle>
            <CardDescription>
              {t("settings:storage.effectiveBackendDescription")}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className="flex size-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
                {storageStatus?.backend === "local" ? (
                  <HardDrive className="size-5" />
                ) : (
                  <Database className="size-5" />
                )}
              </div>
              <div>
                <p className="font-semibold text-base">
                  {storageStatus?.backend === "local"
                    ? t("settings:storage.backends.local")
                    : t("settings:storage.backends.s3")}
                </p>
                <p className="text-xs text-muted-foreground">
                  {t("settings:storage.source")}:{" "}
                  <span className="font-medium text-foreground">
                    {getSourceLabel(storageStatus?.source)}
                  </span>
                </p>
              </div>
            </div>

            <Button
              variant="outline"
              size="sm"
              onClick={() => refetch()}
              disabled={isLoading || isRefetching}
              className="self-start sm:self-auto gap-2"
            >
              <RefreshCw
                className={`size-3.5 ${isRefetching ? "animate-spin" : ""}`}
              />
              {t("settings:storage.actions.refresh")}
            </Button>
          </CardContent>
        </Card>

        {/* Backend selection */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {t("settings:storage.backends.title")}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-6">
            <RadioGroup
              value={selectedBackend}
              onValueChange={(val) =>
                handleSelectBackend(val as "local" | "s3")
              }
              disabled={isChecking || isSaving}
              className="gap-4"
            >
              {/* Local option */}
              <div
                className={`flex items-start space-x-3 rounded-lg border p-4 transition-colors ${
                  !isLocalConfigured
                    ? "opacity-60 bg-muted/20 border-border"
                    : selectedBackend === "local"
                      ? "border-primary bg-primary/5"
                      : "border-border hover:bg-muted/30"
                }`}
              >
                <RadioGroupItem
                  value="local"
                  id="storage-local"
                  disabled={isChecking || isSaving || !isLocalConfigured}
                  className="mt-1"
                />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <Label
                      htmlFor="storage-local"
                      className={`font-medium ${isLocalConfigured ? "cursor-pointer" : "cursor-not-allowed"}`}
                    >
                      {t("settings:storage.backends.local")}
                    </Label>
                    <Badge
                      variant={isLocalConfigured ? "outline" : "secondary"}
                      className={`text-xs font-normal ${!isLocalConfigured ? "text-muted-foreground" : ""}`}
                    >
                      {isLocalConfigured
                        ? t("settings:storage.status.configured")
                        : t("settings:storage.status.notConfigured")}
                    </Badge>
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">
                    {t("settings:storage.backends.localDescription")}
                  </p>
                  {!isLocalConfigured && (
                    <div className="mt-2 text-xs text-muted-foreground bg-muted/50 p-2 rounded border border-border/60">
                      {t("settings:storage.notConfigured.local")}
                    </div>
                  )}
                </div>
              </div>

              {/* S3 option */}
              <div
                className={`flex items-start space-x-3 rounded-lg border p-4 transition-colors ${
                  !isS3Configured
                    ? "opacity-60 bg-muted/20 border-border"
                    : selectedBackend === "s3"
                      ? "border-primary bg-primary/5"
                      : "border-border hover:bg-muted/30"
                }`}
              >
                <RadioGroupItem
                  value="s3"
                  id="storage-s3"
                  disabled={isChecking || isSaving || !isS3Configured}
                  className="mt-1"
                />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <Label
                      htmlFor="storage-s3"
                      className={`font-medium ${isS3Configured ? "cursor-pointer" : "cursor-not-allowed"}`}
                    >
                      {t("settings:storage.backends.s3")}
                    </Label>
                    <Badge
                      variant={isS3Configured ? "outline" : "secondary"}
                      className={`text-xs font-normal ${!isS3Configured ? "text-muted-foreground" : ""}`}
                    >
                      {isS3Configured
                        ? t("settings:storage.status.configured")
                        : t("settings:storage.status.notConfigured")}
                    </Badge>
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">
                    {t("settings:storage.backends.s3Description")}
                  </p>
                  {!isS3Configured && (
                    <div className="mt-2 text-xs text-muted-foreground bg-muted/50 p-2 rounded border border-border/60">
                      {t("settings:storage.notConfigured.s3")}
                    </div>
                  )}
                </div>
              </div>
            </RadioGroup>

            {/* Probe check feedback banner */}
            {checkResult && (
              <div
                role="status"
                className={`rounded-md p-3 text-sm flex items-start gap-2 border ${
                  checkResult.success
                    ? "bg-success/10 border-success/20 text-success"
                    : "bg-destructive/10 border-destructive/20 text-destructive"
                }`}
              >
                {checkResult.success ? (
                  <CheckCircle2 className="size-4 shrink-0 mt-0.5" />
                ) : (
                  <AlertCircle className="size-4 shrink-0 mt-0.5" />
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="outline" className="text-xs font-medium">
                      {checkResult.backend === "local"
                        ? t("settings:storage.backends.local")
                        : t("settings:storage.backends.s3")}
                    </Badge>
                    <span className="font-medium">
                      {checkResult.success
                        ? t("settings:storage.checkResult.success")
                        : t("settings:storage.checkResult.failed", {
                            error: checkResult.error,
                          })}
                    </span>
                  </div>
                  <p className="text-xs opacity-80 mt-1">
                    {t("settings:storage.checkResult.testedAt", {
                      time: new Date(
                        checkResult.checkedAt,
                      ).toLocaleTimeString(),
                    })}
                  </p>
                </div>
              </div>
            )}

            {/* Action buttons */}
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pt-2">
              <Button
                type="button"
                variant="outline"
                onClick={handleCheckConnection}
                disabled={
                  isChecking ||
                  isSaving ||
                  !isSelectedConfigured ||
                  !storageStatus
                }
                className="w-full sm:w-auto gap-2"
              >
                <RefreshCw
                  className={`size-4 ${isChecking ? "animate-spin" : ""}`}
                />
                {isChecking
                  ? t("settings:storage.actions.checking")
                  : t("settings:storage.actions.checkConnection")}
              </Button>

              <div className="flex flex-wrap items-center gap-2 w-full sm:w-auto">
                <Button
                  type="button"
                  variant="ghost"
                  onClick={handleRestoreDefault}
                  disabled={
                    isSaving ||
                    isChecking ||
                    !hasAnyConfigured ||
                    !storageStatus ||
                    isError
                  }
                  className="flex-1 sm:flex-none gap-2"
                >
                  <RotateCcw className="size-4" />
                  {t("settings:storage.actions.restoreDefault")}
                </Button>

                <Button
                  type="button"
                  onClick={handleSave}
                  disabled={
                    isSaving ||
                    isChecking ||
                    !isSelectedConfigured ||
                    !storageStatus ||
                    isError
                  }
                  className="flex-1 sm:flex-none gap-2"
                >
                  <Save className="size-4" />
                  {isSaving
                    ? t("settings:storage.actions.saving")
                    : t("settings:storage.actions.save")}
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
