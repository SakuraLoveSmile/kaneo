import { AlertCircle, CheckCircle2, Clock, XCircle } from "lucide-react";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/cn";
import { formatDateMedium } from "@/lib/format";
import type { MilestoneStatus, MilestoneSummary } from "@/types/milestone";
import {
  isMilestoneOverdue,
  parseDateSafe,
  sortMilestones,
} from "./roadmap-date-utils";

type RoadmapListProps = {
  milestones: MilestoneSummary[];
  searchQuery: string;
  statusFilter: string;
  onSelectMilestone: (id: string) => void;
  isLoading?: boolean;
};

export default function RoadmapList({
  milestones,
  searchQuery,
  statusFilter,
  onSelectMilestone,
  isLoading = false,
}: RoadmapListProps) {
  const { t } = useTranslation();

  const filteredAndSorted = useMemo(() => {
    let list = [...milestones];

    // Status filter
    if (statusFilter && statusFilter !== "all") {
      list = list.filter((m) => m.status === statusFilter);
    }

    // Search query
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase().trim();
      list = list.filter((m) => m.name.toLowerCase().includes(q));
    }

    // Sort by targetDate asc, nulls last, stable tie-breaker by createdAt asc, then id
    return sortMilestones(list);
  }, [milestones, statusFilter, searchQuery]);

  if (isLoading && milestones.length === 0) {
    return (
      <div className="flex h-64 items-center justify-center text-xs text-muted-foreground">
        {t("common:loading", { defaultValue: "Loading milestones..." })}
      </div>
    );
  }

  if (filteredAndSorted.length === 0) {
    return (
      <div className="flex h-64 flex-col items-center justify-center gap-1 text-center">
        <p className="text-sm font-medium text-foreground">
          {t("roadmap:noMilestonesFound", {
            defaultValue: "No milestones found",
          })}
        </p>
        <p className="text-xs text-muted-foreground">
          {searchQuery || statusFilter !== "all"
            ? t("roadmap:tryAdjustingFilters", {
                defaultValue: "Try adjusting your search or status filter.",
              })
            : t("roadmap:createFirstMilestone", {
                defaultValue:
                  "Create your first milestone to start tracking goals.",
              })}
        </p>
      </div>
    );
  }

  const getStatusBadge = (status: MilestoneStatus) => {
    switch (status) {
      case "planned":
        return (
          <Badge
            variant="outline"
            className="gap-1 text-[11px] font-normal text-muted-foreground"
          >
            <Clock className="size-3 text-muted-foreground" />
            {t("roadmap:status.planned", { defaultValue: "Planned" })}
          </Badge>
        );
      case "active":
        return (
          <Badge
            variant="outline"
            className="gap-1 text-[11px] font-medium border-blue-500/30 bg-blue-500/10 text-blue-600 dark:text-blue-400"
          >
            <span className="size-1.5 rounded-full bg-blue-500 animate-pulse" />
            {t("roadmap:status.active", { defaultValue: "In Progress" })}
          </Badge>
        );
      case "completed":
        return (
          <Badge
            variant="outline"
            className="gap-1 text-[11px] font-medium border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
          >
            <CheckCircle2 className="size-3 text-emerald-500" />
            {t("roadmap:status.completed", { defaultValue: "Completed" })}
          </Badge>
        );
      case "canceled":
        return (
          <Badge
            variant="outline"
            className="gap-1 text-[11px] font-normal border-border bg-muted/50 text-muted-foreground"
          >
            <XCircle className="size-3 text-muted-foreground" />
            {t("roadmap:status.canceled", { defaultValue: "Canceled" })}
          </Badge>
        );
    }
  };

  return (
    <div className="w-full overflow-x-auto">
      <div className="min-w-[700px] divide-y divide-border/60">
        {/* Header */}
        <div className="grid grid-cols-12 gap-4 px-4 py-2.5 text-xs font-medium text-muted-foreground">
          <div className="col-span-4">
            {t("roadmap:fields.name", { defaultValue: "Name" })}
          </div>
          <div className="col-span-2">
            {t("roadmap:fields.status", { defaultValue: "Status" })}
          </div>
          <div className="col-span-3">
            {t("roadmap:fields.schedule", { defaultValue: "Schedule" })}
          </div>
          <div className="col-span-3">
            {t("roadmap:progress.title", { defaultValue: "Progress" })}
          </div>
        </div>

        {/* Rows */}
        {filteredAndSorted.map((milestone) => {
          const isOverdue = isMilestoneOverdue(milestone);
          const start = parseDateSafe(milestone.startDate);
          const target = parseDateSafe(milestone.targetDate);
          const total = milestone.totalTasks ?? 0;
          const completed = milestone.completedTasks ?? 0;
          const progress = milestone.progress ?? 0;

          return (
            <button
              type="button"
              key={milestone.id}
              onClick={() => onSelectMilestone(milestone.id)}
              className="w-full text-left grid grid-cols-12 gap-4 px-4 py-3 text-xs items-center hover:bg-muted/40 transition-colors cursor-pointer focus-visible:outline-none focus-visible:bg-muted/50"
            >
              {/* Name & Overdue */}
              <div className="col-span-4 flex items-center gap-2 min-w-0">
                <span className="font-medium text-foreground truncate">
                  {milestone.name}
                </span>
                {isOverdue && (
                  <Badge
                    variant="destructive"
                    className="h-4 px-1 text-[10px] shrink-0 font-normal"
                  >
                    <AlertCircle className="size-2.5 mr-0.5" />
                    {t("roadmap:overdue", { defaultValue: "Overdue" })}
                  </Badge>
                )}
              </div>

              {/* Status */}
              <div className="col-span-2">
                {getStatusBadge(milestone.status)}
              </div>

              {/* Schedule */}
              <div className="col-span-3 text-muted-foreground truncate">
                {start && target ? (
                  <span>
                    {formatDateMedium(start)} – {formatDateMedium(target)}
                  </span>
                ) : target ? (
                  <span>
                    {t("roadmap:due", { defaultValue: "Due" })}{" "}
                    {formatDateMedium(target)}
                  </span>
                ) : start ? (
                  <span>
                    {t("roadmap:starts", { defaultValue: "Starts" })}{" "}
                    {formatDateMedium(start)}
                  </span>
                ) : (
                  <span className="text-muted-foreground/60 italic">
                    {t("roadmap:unscheduled", { defaultValue: "Unscheduled" })}
                  </span>
                )}
              </div>

              {/* Progress */}
              <div className="col-span-3 space-y-1">
                <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                  <span>
                    {completed}/{total}
                  </span>
                  <span className="font-medium">{progress}%</span>
                </div>
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                  <div
                    className={cn(
                      "h-full transition-all duration-200",
                      milestone.status === "completed"
                        ? "bg-emerald-500"
                        : milestone.status === "canceled"
                          ? "bg-muted-foreground"
                          : "bg-primary",
                    )}
                    style={{ width: `${progress}%` }}
                  />
                </div>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
