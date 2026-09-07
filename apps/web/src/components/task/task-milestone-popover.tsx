import { Check, Milestone as MilestoneIcon } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { getMilestoneStatusLabel } from "@/components/roadmap/roadmap-date-utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useUpdateTaskMilestone } from "@/hooks/mutations/task/use-update-task-milestone";
import { useGetMilestones } from "@/hooks/queries/milestone/use-get-milestones";
import { useWorkspacePermission } from "@/hooks/use-workspace-permission";
import { cn } from "@/lib/cn";
import { toast } from "@/lib/toast";
import type Task from "@/types/task";

type TaskMilestonePopoverProps = {
  task: Task | undefined;
  projectId: string;
};

export default function TaskMilestonePopover({
  task,
  projectId,
}: TaskMilestonePopoverProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const { canUpdateTasks } = useWorkspacePermission();

  const {
    data: milestones = [],
    isLoading,
    isError,
  } = useGetMilestones(projectId);

  const updateTaskMilestoneMutation = useUpdateTaskMilestone();

  const currentMilestoneId = task?.milestoneId;
  const currentMilestone = milestones.find((m) => m.id === currentMilestoneId);

  const handleSelectMilestone = async (milestoneId: string | null) => {
    if (!task || !canUpdateTasks()) return;

    try {
      await updateTaskMilestoneMutation.mutateAsync({
        taskId: task.id,
        milestoneId,
        projectId,
      });

      toast.success(
        milestoneId
          ? t("roadmap:linkTask.linkSuccess", {
              defaultValue: "Task linked to milestone",
            })
          : t("roadmap:taskUnlinked", {
              defaultValue: "Milestone removed from task",
            }),
      );
      setOpen(false);
    } catch (error: unknown) {
      toast.error(
        error instanceof Error ? error.message : "Failed to update milestone",
      );
    }
  };

  // Determine display label
  const displayLabel = (() => {
    if (isLoading && currentMilestoneId) {
      return t("common:loading", { defaultValue: "Loading..." });
    }
    if (isError && currentMilestoneId) {
      return t("roadmap:loadErrorRetained", {
        defaultValue: "Milestone (error loading)",
      });
    }
    if (currentMilestone) {
      return currentMilestone.name;
    }
    if (currentMilestoneId) {
      // Retain the ID if options not yet resolved
      return currentMilestoneId;
    }
    return t("roadmap:noMilestone", { defaultValue: "No milestone" });
  })();

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          disabled={!canUpdateTasks()}
          className={cn(
            "h-7 w-full justify-between gap-1.5 px-2 text-xs font-normal",
            currentMilestoneId
              ? "text-foreground font-medium"
              : "text-muted-foreground",
          )}
        >
          <div className="flex items-center gap-2 truncate">
            <MilestoneIcon className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate">{displayLabel}</span>
          </div>
          {currentMilestone && (
            <Badge
              variant="outline"
              className={cn(
                "h-4 px-1 text-[9px] uppercase font-normal shrink-0",
                currentMilestone.status === "completed"
                  ? "border-emerald-500/30 text-emerald-600 dark:text-emerald-400"
                  : currentMilestone.status === "active"
                    ? "border-blue-500/30 text-blue-600 dark:text-blue-400"
                    : "text-muted-foreground",
              )}
            >
              {getMilestoneStatusLabel(currentMilestone.status, t)}
            </Badge>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-1" align="start">
        <div className="space-y-1">
          <p className="px-2 py-1 text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
            {t("roadmap:selectMilestone", { defaultValue: "Select Milestone" })}
          </p>

          {/* Unlink / None Option */}
          <button
            type="button"
            className={cn(
              "w-full flex items-center justify-between px-2 py-1.5 text-xs rounded-sm hover:bg-accent text-left transition-colors",
              !currentMilestoneId && "bg-accent/50 font-medium",
            )}
            onClick={() => handleSelectMilestone(null)}
          >
            <span className="text-muted-foreground">
              {t("roadmap:noMilestone", { defaultValue: "No milestone" })}
            </span>
            {!currentMilestoneId && <Check className="size-3.5" />}
          </button>

          {/* Milestones list */}
          {isLoading ? (
            <p className="p-2 text-center text-xs text-muted-foreground">
              {t("common:loading", { defaultValue: "Loading..." })}
            </p>
          ) : isError ? (
            <p className="p-2 text-center text-xs text-destructive">
              {t("common:errorLoading", {
                defaultValue: "Error loading options",
              })}
            </p>
          ) : milestones.length === 0 ? (
            <p className="p-2 text-center text-xs text-muted-foreground">
              {t("roadmap:noMilestonesInProject", {
                defaultValue: "No milestones in this project",
              })}
            </p>
          ) : (
            milestones.map((m) => {
              const isSelected = m.id === currentMilestoneId;
              return (
                <button
                  key={m.id}
                  type="button"
                  className={cn(
                    "w-full flex items-center justify-between gap-2 px-2 py-1.5 text-xs rounded-sm hover:bg-accent text-left transition-colors",
                    isSelected && "bg-accent/50 font-medium",
                  )}
                  onClick={() => handleSelectMilestone(m.id)}
                >
                  <span className="truncate flex-1 text-foreground">
                    {m.name}
                  </span>
                  <div className="flex items-center gap-1 shrink-0">
                    <span className="text-[10px] text-muted-foreground uppercase">
                      {getMilestoneStatusLabel(m.status, t)}
                    </span>
                    {isSelected && (
                      <Check className="size-3.5 text-primary ml-1" />
                    )}
                  </div>
                </button>
              );
            })
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
