import {
  AlertTriangle,
  Calendar as CalendarIcon,
  ChevronLeft,
  ChevronRight,
  Plus,
  RefreshCw,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { useDeleteMilestone } from "@/hooks/mutations/milestone/use-delete-milestone";
import { useUpdateMilestone } from "@/hooks/mutations/milestone/use-update-milestone";
import { useUpdateTaskMilestone } from "@/hooks/mutations/task/use-update-task-milestone";
import { useGetMilestone } from "@/hooks/queries/milestone/use-get-milestone";
import { useGetMilestoneTasks } from "@/hooks/queries/milestone/use-get-milestone-tasks";
import { useWorkspacePermission } from "@/hooks/use-workspace-permission";
import { cn } from "@/lib/cn";
import { formatDateMedium } from "@/lib/format";
import { HttpError } from "@/lib/http-error";
import { toast } from "@/lib/toast";
import type { MilestoneStatus } from "@/types/milestone";
import LinkTaskPopover from "./link-task-popover";
import {
  formatDateToIsoDay,
  isMilestoneOverdue,
  parseDateSafe,
} from "./roadmap-date-utils";

type MilestoneDetailsSheetProps = {
  projectId: string;
  milestoneId: string | undefined;
  onClose: () => void;
  onSelectTask: (taskId: string) => void;
  onCreateTask: (milestoneId: string) => void;
};

export type MilestoneDraft = {
  name: string;
  description: string;
  status: MilestoneStatus;
  startDate: Date | undefined;
  targetDate: Date | undefined;
};

export type MilestoneDraftKey = keyof MilestoneDraft;

function isFieldDifferent(
  field: MilestoneDraftKey,
  valA: unknown,
  valB: unknown,
): boolean {
  if (field === "name") {
    return ((valA as string) || "").trim() !== ((valB as string) || "").trim();
  }
  if (field === "description") {
    return ((valA as string) || "").trim() !== ((valB as string) || "").trim();
  }
  if (field === "status") {
    return valA !== valB;
  }
  if (field === "startDate" || field === "targetDate") {
    const dayA = valA instanceof Date ? formatDateToIsoDay(valA) : null;
    const dayB = valB instanceof Date ? formatDateToIsoDay(valB) : null;
    return dayA !== dayB;
  }
  return valA !== valB;
}

export default function MilestoneDetailsSheet({
  projectId,
  milestoneId,
  onClose,
  onSelectTask,
  onCreateTask,
}: MilestoneDetailsSheetProps) {
  const { t } = useTranslation();
  const { canCreateTasks, canUpdateTasks, canDeleteTasks } =
    useWorkspacePermission();

  const {
    data: milestone,
    isLoading: isMilestoneLoading,
    error: milestoneError,
    refetch: refetchMilestone,
  } = useGetMilestone(projectId, milestoneId);

  const isProjectMismatch = Boolean(
    milestone && projectId && milestone.projectId !== projectId,
  );

  const [taskPage, setTaskPage] = useState(1);
  const {
    data: tasksData,
    isLoading: isTasksLoading,
    error: tasksError,
    refetch: refetchTasks,
  } = useGetMilestoneTasks(
    projectId,
    isProjectMismatch ? undefined : milestoneId,
    taskPage,
  );

  const updateMilestoneMutation = useUpdateMilestone();
  const deleteMilestoneMutation = useDeleteMilestone();
  const updateTaskMilestoneMutation = useUpdateTaskMilestone();

  // Tracking active milestone and edit session to avoid stale save overwrites
  const activeMilestoneIdRef = useRef<string | null>(milestoneId);
  const editSessionRef = useRef(0);

  useEffect(() => {
    activeMilestoneIdRef.current = milestoneId;
  }, [milestoneId]);

  // Three-layer state: draftId, baseline (server snapshot), draft (local input), dirtyFields
  const [draftId, setDraftId] = useState<string | null>(null);
  const [baseline, setBaseline] = useState<MilestoneDraft | null>(null);
  const [draft, setDraft] = useState<MilestoneDraft>({
    name: "",
    description: "",
    status: "planned",
    startDate: undefined,
    targetDate: undefined,
  });
  const [dirtyFields, setDirtyFields] = useState<Set<MilestoneDraftKey>>(
    new Set(),
  );
  const [conflicts, setConflicts] = useState<MilestoneDraftKey[]>([]);

  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [isConfirmCloseOpen, setIsConfirmCloseOpen] = useState(false);
  const [isResourceDeleted, setIsResourceDeleted] = useState(false);

  // Sync server data to draft / baseline with conflict detection
  // biome-ignore lint/correctness/useExhaustiveDependencies: Sync on remote milestone change only
  useEffect(() => {
    if (!milestone) return;

    const serverDraft: MilestoneDraft = {
      name: milestone.name,
      description: milestone.description || "",
      status: milestone.status,
      startDate: parseDateSafe(milestone.startDate) || undefined,
      targetDate: parseDateSafe(milestone.targetDate) || undefined,
    };

    if (milestone.id !== draftId) {
      editSessionRef.current += 1;
      setDraftId(milestone.id);
      setBaseline(serverDraft);
      setDraft(serverDraft);
      setDirtyFields(new Set());
      setConflicts([]);
      setTaskPage(1);
      setIsResourceDeleted(false);
      return;
    }

    // Same milestone refetched:
    if (dirtyFields.size === 0) {
      setBaseline(serverDraft);
      setDraft(serverDraft);
      setConflicts([]);
    } else if (baseline) {
      const detectedConflicts: MilestoneDraftKey[] = [];
      const updatedDraft = { ...draft };
      let hasCleanUpdated = false;

      (Object.keys(serverDraft) as MilestoneDraftKey[]).forEach((key) => {
        const serverChanged = isFieldDifferent(
          key,
          serverDraft[key],
          baseline[key],
        );
        if (serverChanged) {
          if (dirtyFields.has(key)) {
            detectedConflicts.push(key);
          } else {
            (updatedDraft as Record<string, unknown>)[key] = serverDraft[key];
            hasCleanUpdated = true;
          }
        }
      });

      if (detectedConflicts.length > 0) {
        setConflicts((prev) =>
          Array.from(new Set([...prev, ...detectedConflicts])),
        );
      }
      if (hasCleanUpdated) {
        setDraft(updatedDraft);
      }
      setBaseline(serverDraft);
    }
  }, [milestone, draftId]);

  const getErrorCode = (err: unknown): number | null => {
    if (!err) return null;
    if (err instanceof HttpError) return err.status;
    if (typeof err === "object" && err !== null && "status" in err) {
      return Number((err as { status: unknown }).status) || null;
    }
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("404") || msg.includes("not found")) return 404;
    if (msg.includes("403") || msg.includes("forbidden")) return 403;
    return null;
  };

  const milestoneErrorCode = getErrorCode(milestoneError);
  const isNotFound = milestoneErrorCode === 404 || isResourceDeleted;
  const isForbidden = milestoneErrorCode === 403;
  const isMilestoneFetchError =
    Boolean(milestoneError) && !isNotFound && !isForbidden;

  const totalTasks = milestone?.totalTasks ?? 0;
  const completedTasks = milestone?.completedTasks ?? 0;
  const remainingTasks = Math.max(0, totalTasks - completedTasks);
  const progressPercent = milestone?.progress ?? 0;
  const isOverdue = milestone ? isMilestoneOverdue(milestone) : false;

  const updateField = <K extends MilestoneDraftKey>(
    field: K,
    value: MilestoneDraft[K],
  ) => {
    setDraft((prev) => ({ ...prev, [field]: value }));
    setDirtyFields((prev) => {
      const next = new Set(prev);
      if (!baseline || isFieldDifferent(field, value, baseline[field])) {
        next.add(field);
      } else {
        next.delete(field);
      }
      return next;
    });
    if (conflicts.includes(field)) {
      setConflicts((prev) => prev.filter((c) => c !== field));
    }
  };

  const handleAcceptRemoteConflicts = () => {
    if (!milestone) return;
    const serverDraft: MilestoneDraft = {
      name: milestone.name,
      description: milestone.description || "",
      status: milestone.status,
      startDate: parseDateSafe(milestone.startDate) || undefined,
      targetDate: parseDateSafe(milestone.targetDate) || undefined,
    };

    setDraft((prev) => {
      const next = { ...prev };
      for (const field of conflicts) {
        (next as Record<string, unknown>)[field] = serverDraft[field];
      }
      return next;
    });

    setDirtyFields((prev) => {
      const next = new Set(prev);
      for (const field of conflicts) {
        next.delete(field);
      }
      return next;
    });

    setConflicts([]);
  };

  const handleKeepLocalConflicts = () => {
    setConflicts([]);
  };

  const handleResetDraft = () => {
    if (baseline) {
      setDraft(baseline);
      setDirtyFields(new Set());
      setConflicts([]);
    }
  };

  // Recover current page if totalPages shrinks
  useEffect(() => {
    if (
      tasksData?.pagination?.totalPages &&
      taskPage > tasksData.pagination.totalPages
    ) {
      setTaskPage(Math.max(1, tasksData.pagination.totalPages));
    }
  }, [tasksData?.pagination?.totalPages, taskPage]);

  const isSaving = updateMilestoneMutation.isPending;
  const hasChanges = dirtyFields.size > 0;

  const handleSave = async () => {
    if (!milestoneId || !milestone || isSaving) return;

    if (isProjectMismatch) {
      toast.error(
        t("roadmap:errors.projectMismatch", {
          defaultValue: "This milestone belongs to another project.",
        }),
      );
      return;
    }

    if (conflicts.length > 0) {
      toast.error(
        t("roadmap:conflict.unresolved", {
          defaultValue: "Please resolve remote edit conflicts before saving.",
        }),
      );
      return;
    }

    if (isResourceDeleted) {
      toast.error(
        t("roadmap:errors.resourceUnavailable", {
          defaultValue: "This milestone is no longer available.",
        }),
      );
      return;
    }

    const trimmedName = draft.name.trim();
    if (dirtyFields.has("name") && !trimmedName) {
      toast.error(
        t("roadmap:form.nameRequired", { defaultValue: "Name is required" }),
      );
      return;
    }

    if (
      draft.startDate &&
      draft.targetDate &&
      draft.startDate > draft.targetDate
    ) {
      toast.error(
        t("roadmap:form.invalidDateRange", {
          defaultValue: "Start date must be on or before target date",
        }),
      );
      return;
    }

    if (dirtyFields.size === 0) {
      return;
    }

    // Build diff payload: ONLY fields in dirtyFields are submitted
    const payload: Record<string, unknown> = {};
    if (dirtyFields.has("name")) {
      payload.name = trimmedName;
    }
    if (dirtyFields.has("description")) {
      payload.description = draft.description.trim() || null;
    }
    if (dirtyFields.has("status")) {
      payload.status = draft.status;
    }
    if (dirtyFields.has("startDate")) {
      payload.startDate = draft.startDate
        ? formatDateToIsoDay(draft.startDate)
        : null;
    }
    if (dirtyFields.has("targetDate")) {
      payload.targetDate = draft.targetDate
        ? formatDateToIsoDay(draft.targetDate)
        : null;
    }

    const savingMilestoneId = milestoneId;
    const savingSession = editSessionRef.current;

    try {
      const updated = await updateMilestoneMutation.mutateAsync({
        id: milestoneId,
        projectId,
        payload,
      });

      // Stale response check: If the sheet closed or user switched to another milestone,
      // React Query cache has already been invalidated by the mutation, but we must NOT
      // overwrite the current draft/baseline of the newly selected milestone.
      if (
        activeMilestoneIdRef.current !== savingMilestoneId ||
        editSessionRef.current !== savingSession
      ) {
        return;
      }

      const nextBaseline: MilestoneDraft = {
        name: updated.name,
        description: updated.description || "",
        status: updated.status,
        startDate: parseDateSafe(updated.startDate) || undefined,
        targetDate: parseDateSafe(updated.targetDate) || undefined,
      };
      setBaseline(nextBaseline);
      setDraft(nextBaseline);
      setDirtyFields(new Set());
      setConflicts([]);

      toast.success(
        t("roadmap:form.saveSuccess", {
          defaultValue: "Milestone updated successfully",
        }),
      );
    } catch (err: unknown) {
      if (
        activeMilestoneIdRef.current !== savingMilestoneId ||
        editSessionRef.current !== savingSession
      ) {
        return;
      }
      const code = getErrorCode(err);
      if (code === 404) {
        setIsResourceDeleted(true);
      }
      const msg =
        err instanceof Error ? err.message : "Failed to update milestone";
      toast.error(msg);
    }
  };

  const handleDelete = async () => {
    if (!milestoneId || isSaving || isProjectMismatch) return;
    try {
      await deleteMilestoneMutation.mutateAsync({
        id: milestoneId,
        projectId,
      });
      toast.success(
        t("roadmap:deleteSuccess", {
          defaultValue: "Milestone deleted. Associated tasks were preserved.",
        }),
      );
      setIsDeleteDialogOpen(false);
      handleCloseClean();
    } catch (err: unknown) {
      const msg =
        err instanceof Error ? err.message : "Failed to delete milestone";
      toast.error(msg);
    }
  };

  const handleUnlinkTask = async (taskId: string) => {
    if (isProjectMismatch) return;
    try {
      await updateTaskMilestoneMutation.mutateAsync({
        taskId,
        milestoneId: null,
        projectId,
      });
      if (tasksData && tasksData.tasks.length === 1 && taskPage > 1) {
        setTaskPage((p) => Math.max(1, p - 1));
      }
      toast.success(
        t("roadmap:taskUnlinked", { defaultValue: "Task unlinked" }),
      );
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Failed to unlink task");
    }
  };

  const handleRequestClose = () => {
    if (isSaving) {
      return;
    }
    if (dirtyFields.size > 0) {
      setIsConfirmCloseOpen(true);
    } else {
      handleCloseClean();
    }
  };

  const handleCloseClean = () => {
    editSessionRef.current += 1;
    setDraftId(null);
    setDirtyFields(new Set());
    setConflicts([]);
    onClose();
  };

  const handleConfirmDiscardClose = () => {
    if (isSaving) return;
    setIsConfirmCloseOpen(false);
    handleResetDraft();
    handleCloseClean();
  };

  const statusColor = {
    planned: "bg-muted text-muted-foreground",
    active:
      "bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/20",
    completed:
      "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20",
    canceled: "bg-destructive/10 text-destructive border-destructive/20",
  }[draft.status];

  return (
    <>
      <Sheet
        open={Boolean(milestoneId)}
        onOpenChange={(open) => !open && handleRequestClose()}
      >
        <SheetContent className="w-full sm:max-w-xl flex flex-col p-0 overflow-hidden">
          <SheetHeader className="p-4 border-b border-border/80 flex flex-row items-center justify-between space-y-0">
            <div className="flex items-center gap-2 min-w-0">
              <SheetTitle className="text-base font-semibold truncate">
                {milestone?.name ||
                  t("roadmap:milestoneDetails", {
                    defaultValue: "Milestone Details",
                  })}
              </SheetTitle>
              {isOverdue && (
                <Badge variant="destructive" className="h-5 px-1.5 text-[10px]">
                  {t("roadmap:overdue", { defaultValue: "Overdue" })}
                </Badge>
              )}
            </div>
            <div className="flex items-center gap-1">
              {canDeleteTasks() && !isProjectMismatch && (
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="text-muted-foreground hover:text-destructive"
                  onClick={() => setIsDeleteDialogOpen(true)}
                  disabled={isNotFound || isMilestoneLoading || isSaving}
                  aria-label={t("common:delete", { defaultValue: "Delete" })}
                  title={t("common:delete", { defaultValue: "Delete" })}
                >
                  <Trash2 className="size-4" />
                </Button>
              )}
            </div>
          </SheetHeader>

          {isNotFound ? (
            <div className="p-6 text-center space-y-3">
              <AlertTriangle className="size-8 text-amber-500 mx-auto" />
              <p className="text-sm text-muted-foreground">
                {t("roadmap:errors.resourceUnavailable", {
                  defaultValue:
                    "This milestone is no longer available or was deleted.",
                })}
              </p>
              <Button variant="outline" size="sm" onClick={handleCloseClean}>
                {t("common:close", { defaultValue: "Close" })}
              </Button>
            </div>
          ) : isForbidden ? (
            <div className="p-6 text-center space-y-3">
              <AlertTriangle className="size-8 text-destructive mx-auto" />
              <p className="text-sm text-muted-foreground">
                {t("roadmap:errors.permissionDenied", {
                  defaultValue:
                    "You do not have permission to view or edit this milestone.",
                })}
              </p>
              <Button variant="outline" size="sm" onClick={handleCloseClean}>
                {t("common:close", { defaultValue: "Close" })}
              </Button>
            </div>
          ) : isProjectMismatch ? (
            <div className="p-6 text-center space-y-3">
              <AlertTriangle className="size-8 text-amber-500 mx-auto" />
              <p className="text-sm font-semibold text-foreground">
                {t("roadmap:errors.projectMismatch", {
                  defaultValue: "This milestone belongs to another project.",
                })}
              </p>
              <p className="text-xs text-muted-foreground">
                {t("roadmap:errors.projectMismatchDesc", {
                  defaultValue:
                    "Editing, deleting, and linking tasks are disabled for milestones from another project.",
                })}
              </p>
              <Button variant="outline" size="sm" onClick={handleCloseClean}>
                {t("common:close", { defaultValue: "Close" })}
              </Button>
            </div>
          ) : isMilestoneFetchError ? (
            <div className="p-6 text-center space-y-3">
              <AlertTriangle className="size-8 text-destructive mx-auto" />
              <p className="text-sm text-muted-foreground">
                {milestoneError instanceof Error
                  ? milestoneError.message
                  : t("roadmap:errors.loadFailed", {
                      defaultValue: "Failed to load milestone details.",
                    })}
              </p>
              <div className="flex items-center justify-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => refetchMilestone()}
                >
                  <RefreshCw className="mr-1.5 size-3.5" />
                  {t("common:retry", { defaultValue: "Retry" })}
                </Button>
                <Button variant="ghost" size="sm" onClick={handleCloseClean}>
                  {t("common:close", { defaultValue: "Close" })}
                </Button>
              </div>
            </div>
          ) : isMilestoneLoading && !milestone ? (
            <div className="p-6 text-center text-xs text-muted-foreground">
              {t("common:loading", { defaultValue: "Loading..." })}
            </div>
          ) : (
            <div className="flex-1 overflow-y-auto p-4 space-y-6">
              {/* Conflict Banner */}
              {conflicts.length > 0 && (
                <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 space-y-2">
                  <div className="flex items-start gap-2">
                    <AlertTriangle className="size-4 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
                    <div className="text-xs text-amber-900 dark:text-amber-200">
                      <p className="font-semibold">
                        {t("roadmap:conflict.title", {
                          defaultValue: "Remote changes detected",
                        })}
                      </p>
                      <p className="text-[11px] text-amber-800 dark:text-amber-300 mt-0.5">
                        {t("roadmap:conflict.desc", {
                          fields: conflicts
                            .map((key) => {
                              switch (key) {
                                case "name":
                                  return t("roadmap:fields.name", {
                                    defaultValue: "Name",
                                  });
                                case "description":
                                  return t("roadmap:fields.description", {
                                    defaultValue: "Description",
                                  });
                                case "status":
                                  return t("roadmap:fields.status", {
                                    defaultValue: "Status",
                                  });
                                case "startDate":
                                  return t("roadmap:fields.startDate", {
                                    defaultValue: "Start date",
                                  });
                                case "targetDate":
                                  return t("roadmap:fields.targetDate", {
                                    defaultValue: "Target date",
                                  });
                                default:
                                  return key;
                              }
                            })
                            .join(", "),
                          defaultValue:
                            "Another window or user updated some fields. You can adopt remote values or keep your draft to overwrite upon save.",
                        })}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center justify-end gap-2 pt-1">
                    <Button
                      variant="outline"
                      size="xs"
                      className="h-6 text-[11px]"
                      onClick={handleAcceptRemoteConflicts}
                    >
                      {t("roadmap:conflict.acceptRemote", {
                        defaultValue: "Adopt remote",
                      })}
                    </Button>
                    <Button
                      variant="secondary"
                      size="xs"
                      className="h-6 text-[11px]"
                      onClick={handleKeepLocalConflicts}
                    >
                      {t("roadmap:conflict.keepLocal", {
                        defaultValue: "Keep my edits",
                      })}
                    </Button>
                  </div>
                </div>
              )}

              {/* Progress Card */}
              <div className="rounded-lg border border-border/80 bg-card p-3 space-y-2">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-medium text-foreground">
                    {t("roadmap:progress.title", { defaultValue: "Progress" })}
                  </span>
                  <span className="text-muted-foreground">
                    {completedTasks} / {totalTasks}{" "}
                    {t("roadmap:progress.tasksCompleted", {
                      defaultValue: "tasks completed",
                    })}{" "}
                    ({progressPercent}%)
                  </span>
                </div>
                <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                  <div
                    className={cn(
                      "h-full transition-all duration-300",
                      draft.status === "completed"
                        ? "bg-emerald-500"
                        : draft.status === "canceled"
                          ? "bg-muted-foreground"
                          : "bg-primary",
                    )}
                    style={{ width: `${progressPercent}%` }}
                  />
                </div>
                {draft.status !== "completed" && remainingTasks > 0 && (
                  <p className="text-[11px] text-muted-foreground">
                    {t("roadmap:progress.remaining", {
                      count: remainingTasks,
                      defaultValue: `${remainingTasks} tasks remaining`,
                    })}
                  </p>
                )}
              </div>

              {/* Editable Fields */}
              <div className="space-y-4">
                <div className="space-y-1.5">
                  <label
                    htmlFor="milestone-detail-name"
                    className="text-xs font-medium text-foreground"
                  >
                    {t("roadmap:fields.name", { defaultValue: "Name" })}
                  </label>
                  <Input
                    id="milestone-detail-name"
                    value={draft.name}
                    disabled={!canUpdateTasks() || isSaving}
                    onChange={(e) => updateField("name", e.target.value)}
                    className="text-xs"
                    maxLength={200}
                  />
                </div>

                <div className="space-y-1.5">
                  <label
                    htmlFor="milestone-detail-desc"
                    className="text-xs font-medium text-foreground"
                  >
                    {t("roadmap:fields.description", {
                      defaultValue: "Description",
                    })}
                  </label>
                  <Textarea
                    id="milestone-detail-desc"
                    value={draft.description}
                    disabled={!canUpdateTasks() || isSaving}
                    onChange={(e) => updateField("description", e.target.value)}
                    placeholder={t("roadmap:fields.descriptionPlaceholder", {
                      defaultValue:
                        "Add details or goals for this milestone...",
                    })}
                    rows={3}
                    className="text-xs"
                  />
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <span className="text-xs font-medium text-foreground">
                      {t("roadmap:fields.status", { defaultValue: "Status" })}
                    </span>
                    <Select
                      value={draft.status}
                      disabled={!canUpdateTasks() || isSaving}
                      onValueChange={(val) =>
                        updateField("status", val as MilestoneStatus)
                      }
                    >
                      <SelectTrigger
                        className={cn(
                          "w-full text-xs font-medium",
                          statusColor,
                        )}
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="planned">
                          {t("roadmap:status.planned", {
                            defaultValue: "Planned",
                          })}
                        </SelectItem>
                        <SelectItem value="active">
                          {t("roadmap:status.active", {
                            defaultValue: "In Progress",
                          })}
                        </SelectItem>
                        <SelectItem value="completed">
                          {t("roadmap:status.completed", {
                            defaultValue: "Completed",
                          })}
                        </SelectItem>
                        <SelectItem value="canceled">
                          {t("roadmap:status.canceled", {
                            defaultValue: "Canceled",
                          })}
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-1.5">
                    <span className="text-xs font-medium text-foreground">
                      {t("roadmap:fields.startDate", {
                        defaultValue: "Start date",
                      })}
                    </span>
                    <Popover>
                      <PopoverTrigger asChild>
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={!canUpdateTasks() || isSaving}
                          className="w-full justify-start text-left text-xs font-normal"
                        >
                          <CalendarIcon className="mr-1.5 h-3.5 w-3.5 text-muted-foreground" />
                          {draft.startDate ? (
                            formatDateMedium(draft.startDate)
                          ) : (
                            <span className="text-muted-foreground">
                              {t("roadmap:fields.pickDate", {
                                defaultValue: "Pick date",
                              })}
                            </span>
                          )}
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent className="w-auto p-0" align="start">
                        <Calendar
                          mode="single"
                          selected={draft.startDate}
                          onSelect={(d) => updateField("startDate", d)}
                        />
                        {draft.startDate && (
                          <div className="border-t border-border p-2">
                            <Button
                              type="button"
                              variant="ghost"
                              size="xs"
                              className="w-full text-xs text-muted-foreground"
                              onClick={() =>
                                updateField("startDate", undefined)
                              }
                            >
                              {t("roadmap:fields.clearDate", {
                                defaultValue: "Clear",
                              })}
                            </Button>
                          </div>
                        )}
                      </PopoverContent>
                    </Popover>
                  </div>
                </div>

                <div className="space-y-1.5">
                  <span className="text-xs font-medium text-foreground">
                    {t("roadmap:fields.targetDate", {
                      defaultValue: "Target date",
                    })}
                  </span>
                  <Popover>
                    <PopoverTrigger asChild>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={!canUpdateTasks() || isSaving}
                        className="w-full justify-start text-left text-xs font-normal"
                      >
                        <CalendarIcon className="mr-1.5 h-3.5 w-3.5 text-muted-foreground" />
                        {draft.targetDate ? (
                          formatDateMedium(draft.targetDate)
                        ) : (
                          <span className="text-muted-foreground">
                            {t("roadmap:fields.pickDate", {
                              defaultValue: "Pick date",
                            })}
                          </span>
                        )}
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-auto p-0" align="start">
                      <Calendar
                        mode="single"
                        selected={draft.targetDate}
                        onSelect={(d) => updateField("targetDate", d)}
                      />
                      {draft.targetDate && (
                        <div className="border-t border-border p-2">
                          <Button
                            type="button"
                            variant="ghost"
                            size="xs"
                            className="w-full text-xs text-muted-foreground"
                            onClick={() => updateField("targetDate", undefined)}
                          >
                            {t("roadmap:fields.clearDate", {
                              defaultValue: "Clear",
                            })}
                          </Button>
                        </div>
                      )}
                    </PopoverContent>
                  </Popover>
                </div>

                {canUpdateTasks() && hasChanges && (
                  <div className="flex items-center justify-end gap-2 pt-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleResetDraft}
                      disabled={isSaving}
                    >
                      {t("common:discard", { defaultValue: "Discard" })}
                    </Button>
                    <Button
                      size="sm"
                      onClick={handleSave}
                      disabled={isSaving || conflicts.length > 0}
                    >
                      {isSaving
                        ? t("common:saving", { defaultValue: "Saving..." })
                        : t("common:saveChanges", {
                            defaultValue: "Save changes",
                          })}
                    </Button>
                  </div>
                )}
              </div>

              {/* Linked Tasks Section */}
              <div className="space-y-3 pt-2 border-t border-border/80">
                <div className="flex items-center justify-between">
                  <div className="space-y-0.5">
                    <h4 className="text-xs font-semibold text-foreground">
                      {t("roadmap:linkedTasks.title", {
                        defaultValue: "Linked tasks",
                      })}
                    </h4>
                    <p className="text-[11px] text-muted-foreground">
                      {t("roadmap:linkedTasks.subtitle", {
                        defaultValue:
                          "Tasks contributing to this milestone's completion.",
                      })}
                    </p>
                  </div>
                  {!isProjectMismatch && milestoneId && (
                    <div className="flex items-center gap-1.5">
                      {canUpdateTasks() && (
                        <LinkTaskPopover
                          projectId={projectId}
                          milestoneId={milestoneId}
                        />
                      )}
                      {canCreateTasks() && (
                        <Button
                          variant="secondary"
                          size="xs"
                          className="h-7 text-xs gap-1"
                          onClick={() => onCreateTask(milestoneId)}
                        >
                          <Plus className="size-3.5" />
                          {t("roadmap:linkedTasks.createTask", {
                            defaultValue: "New task",
                          })}
                        </Button>
                      )}
                    </div>
                  )}
                </div>

                {isTasksLoading && !tasksData ? (
                  <p
                    className="p-4 text-center text-xs text-muted-foreground"
                    role="status"
                  >
                    {t("common:loading", { defaultValue: "Loading tasks..." })}
                  </p>
                ) : tasksError ? (
                  <div className="p-4 text-center space-y-2" role="alert">
                    <p className="text-xs text-destructive">
                      {t("roadmap:errors.tasksLoadFailed", {
                        defaultValue: "Failed to load linked tasks.",
                      })}
                    </p>
                    <Button
                      variant="outline"
                      size="xs"
                      className="text-xs"
                      onClick={() => refetchTasks()}
                    >
                      <RefreshCw className="mr-1.5 size-3.5" />
                      {t("common:retry", { defaultValue: "Retry" })}
                    </Button>
                  </div>
                ) : !tasksData || tasksData.tasks.length === 0 ? (
                  <div className="rounded-md border border-dashed border-border/80 p-6 text-center space-y-1">
                    <p className="text-xs font-medium text-foreground">
                      {t("roadmap:linkedTasks.noTasks", {
                        defaultValue: "No tasks yet",
                      })}
                    </p>
                    <p className="text-[11px] text-muted-foreground">
                      {t("roadmap:linkedTasks.noTasksDesc", {
                        defaultValue:
                          "Link existing tasks or create new ones to track progress.",
                      })}
                    </p>
                  </div>
                ) : (
                  <div className="space-y-1.5">
                    {tasksData.tasks.map((task) => (
                      <div
                        key={task.id}
                        className="group flex items-center justify-between gap-2 rounded-md border border-border/60 p-2 hover:bg-muted/40 transition-colors"
                      >
                        <button
                          type="button"
                          onClick={() => onSelectTask(task.id)}
                          className="flex items-center gap-2 min-w-0 flex-1 text-left"
                        >
                          <span className="truncate text-xs font-medium text-foreground group-hover:text-primary transition-colors">
                            {task.title}
                          </span>
                          <span className="shrink-0 text-[10px] text-muted-foreground">
                            {task.status}
                          </span>
                        </button>
                        {canUpdateTasks() && (
                          <Button
                            variant="ghost"
                            size="icon-xs"
                            className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive transition-opacity"
                            onClick={() => handleUnlinkTask(task.id)}
                            aria-label={t("roadmap:linkTask.unlinkAction", {
                              defaultValue: "Unlink from milestone",
                            })}
                            title={t("roadmap:linkTask.unlinkAction", {
                              defaultValue: "Unlink from milestone",
                            })}
                          >
                            <X className="size-3.5" />
                          </Button>
                        )}
                      </div>
                    ))}

                    {tasksData.pagination.totalPages > 1 && (
                      <div className="flex items-center justify-between pt-2 text-xs text-muted-foreground">
                        <span>
                          {t("common:page", { defaultValue: "Page" })}{" "}
                          {taskPage} / {tasksData.pagination.totalPages}
                        </span>
                        <div className="flex items-center gap-1">
                          <Button
                            variant="outline"
                            size="icon-xs"
                            disabled={taskPage <= 1 || isTasksLoading}
                            onClick={() => setTaskPage((p) => p - 1)}
                            aria-label={t("common:previous", {
                              defaultValue: "Previous",
                            })}
                            title={t("common:previous", {
                              defaultValue: "Previous",
                            })}
                          >
                            <ChevronLeft className="size-3.5" />
                          </Button>
                          <Button
                            variant="outline"
                            size="icon-xs"
                            disabled={
                              taskPage >= tasksData.pagination.totalPages ||
                              isTasksLoading
                            }
                            onClick={() => setTaskPage((p) => p + 1)}
                            aria-label={t("common:next", {
                              defaultValue: "Next",
                            })}
                            title={t("common:next", {
                              defaultValue: "Next",
                            })}
                          >
                            <ChevronRight className="size-3.5" />
                          </Button>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}
        </SheetContent>
      </Sheet>

      {/* Delete Confirmation Dialog */}
      <Dialog open={isDeleteDialogOpen} onOpenChange={setIsDeleteDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {t("roadmap:deleteConfirm.title", {
                defaultValue: "Delete milestone?",
              })}
            </DialogTitle>
            <DialogDescription>
              {t("roadmap:deleteConfirm.desc", {
                defaultValue:
                  "Deleting this milestone will not delete associated tasks. Tasks will simply be unlinked and preserved in the project.",
              })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setIsDeleteDialogOpen(false)}
              disabled={deleteMilestoneMutation.isPending}
            >
              {t("common:cancel", { defaultValue: "Cancel" })}
            </Button>
            <Button
              variant="destructive"
              onClick={handleDelete}
              disabled={deleteMilestoneMutation.isPending}
            >
              {deleteMilestoneMutation.isPending
                ? t("common:deleting", { defaultValue: "Deleting..." })
                : t("common:delete", { defaultValue: "Delete milestone" })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Unsaved Changes Dialog */}
      <Dialog open={isConfirmCloseOpen} onOpenChange={setIsConfirmCloseOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>
              {t("common:unsavedChanges.title", {
                defaultValue: "Discard changes?",
              })}
            </DialogTitle>
            <DialogDescription>
              {t("common:unsavedChanges.desc", {
                defaultValue:
                  "You have unsaved edits. Are you sure you want to discard them?",
              })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setIsConfirmCloseOpen(false)}
            >
              {t("common:continueEditing", {
                defaultValue: "Continue editing",
              })}
            </Button>
            <Button variant="destructive" onClick={handleConfirmDiscardClose}>
              {t("common:discard", { defaultValue: "Discard" })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
