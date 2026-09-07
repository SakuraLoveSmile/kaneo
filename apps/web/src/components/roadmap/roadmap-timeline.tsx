import {
  ArrowLeft,
  ArrowRight,
  Calendar as CalendarIcon,
  ChevronLeft,
  ChevronRight,
  Flag,
} from "lucide-react";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { formatDateMedium } from "@/lib/format";
import { useUserPreferencesStore } from "@/store/user-preferences";
import type { MilestoneSummary } from "@/types/milestone";
import {
  calculateMilestoneVisual,
  formatDateToIsoDay,
  getMilestoneStatusLabel,
  getShiftedDate,
  getTimelinePeriod,
  isMilestoneOverdue,
  parseDateSafe,
  type RoadmapScale,
  sortMilestones,
} from "./roadmap-date-utils";

type RoadmapTimelineProps = {
  milestones: MilestoneSummary[];
  currentDate: Date;
  scale: RoadmapScale;
  searchQuery: string;
  statusFilter: string;
  onSelectMilestone: (id: string) => void;
  onNavigateDate: (nextDate: Date) => void;
  isLoading?: boolean;
};

export default function RoadmapTimeline({
  milestones,
  currentDate,
  scale,
  searchQuery,
  statusFilter,
  onSelectMilestone,
  onNavigateDate,
  isLoading = false,
}: RoadmapTimelineProps) {
  const { t } = useTranslation();
  const weekStartsOn = useUserPreferencesStore((state) => state.weekStartsOn);

  // Compute period boundaries
  const period = useMemo(() => {
    return getTimelinePeriod(currentDate, scale, weekStartsOn as 0 | 1 | 6);
  }, [currentDate, scale, weekStartsOn]);

  // Filter milestones by status and search
  const filteredMilestones = useMemo(() => {
    let list = [...milestones];
    if (statusFilter && statusFilter !== "all") {
      list = list.filter((m) => m.status === statusFilter);
    }
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase().trim();
      list = list.filter((m) => m.name.toLowerCase().includes(q));
    }
    return sortMilestones(list);
  }, [milestones, statusFilter, searchQuery]);

  // Separate scheduled (in-range or clipped) vs unscheduled vs out-of-range
  const { scheduled, unscheduled } = useMemo(() => {
    const scheduledList: Array<{
      milestone: MilestoneSummary;
      visual: ReturnType<typeof calculateMilestoneVisual>;
    }> = [];
    const unscheduledList: MilestoneSummary[] = [];

    for (const m of filteredMilestones) {
      const visual = calculateMilestoneVisual(m, period);
      if (visual.type === "unscheduled") {
        unscheduledList.push(m);
      } else if (visual.type !== "out-of-range") {
        scheduledList.push({ milestone: m, visual });
      }
      // "out-of-range" milestones are excluded from timeline view according to F05
    }

    return { scheduled: scheduledList, unscheduled: unscheduledList };
  }, [filteredMilestones, period]);

  // Period title (e.g., "June 2026" or "Q2 2026")
  const periodTitle = useMemo(() => {
    if (scale === "quarter") {
      const quarterNum = Math.floor(currentDate.getMonth() / 3) + 1;
      return `Q${quarterNum} ${currentDate.getFullYear()}`;
    }
    return currentDate.toLocaleDateString(undefined, {
      month: "long",
      year: "numeric",
    });
  }, [currentDate, scale]);

  if (isLoading && milestones.length === 0) {
    return (
      <div className="flex h-64 items-center justify-center text-xs text-muted-foreground">
        {t("common:loading", { defaultValue: "Loading milestones..." })}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background">
      {/* Timeline Controls */}
      <div className="flex items-center justify-between border-b border-border/80 px-4 py-2 bg-muted/20 shrink-0">
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="xs"
            onClick={() =>
              onNavigateDate(getShiftedDate(currentDate, scale, "today"))
            }
            className="h-7 text-xs font-medium"
          >
            {t("roadmap:today", { defaultValue: "Today" })}
          </Button>
          <div className="flex items-center gap-0.5">
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={() =>
                onNavigateDate(getShiftedDate(currentDate, scale, "prev"))
              }
              className="h-7 w-7 text-muted-foreground hover:text-foreground"
              aria-label={t("common:previous", { defaultValue: "Previous" })}
              title={t("common:previous", { defaultValue: "Previous" })}
            >
              <ChevronLeft className="size-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={() =>
                onNavigateDate(getShiftedDate(currentDate, scale, "next"))
              }
              className="h-7 w-7 text-muted-foreground hover:text-foreground"
              aria-label={t("common:next", { defaultValue: "Next" })}
              title={t("common:next", { defaultValue: "Next" })}
            >
              <ChevronRight className="size-4" />
            </Button>
          </div>
          <span className="text-xs font-semibold text-foreground ml-1">
            {periodTitle}
          </span>
        </div>

        <div className="text-[11px] text-muted-foreground">
          {scheduled.length}{" "}
          {t("roadmap:scheduledCount", { defaultValue: "scheduled" })}
          {unscheduled.length > 0 &&
            ` · ${unscheduled.length} ${t("roadmap:unscheduledCount", { defaultValue: "unscheduled" })}`}
        </div>
      </div>

      {/* Unified 2D Scroll Container */}
      <div className="flex-1 min-h-0 overflow-auto relative bg-background">
        <div
          className="flex flex-col min-w-full"
          style={{
            minWidth: scale === "quarter" ? "950px" : "1200px",
          }}
        >
          {/* Header Row (sticky top-0 z-20) */}
          <div className="sticky top-0 z-20 flex h-10 border-b border-border/80 bg-background/95 backdrop-blur shrink-0 select-none">
            {/* Top-Left Corner (sticky left-0 z-30) */}
            <div className="sticky left-0 z-30 w-72 shrink-0 border-r border-border/80 bg-background px-3 flex items-center text-xs font-medium text-muted-foreground shadow-[1px_0_0_0_hsl(var(--border))]">
              {t("roadmap:milestones", { defaultValue: "Milestones" })}
            </div>

            {/* Date Header Columns */}
            <div className="flex-1 flex items-stretch bg-muted/10">
              {scale === "quarter"
                ? period.weeks.map((w) => (
                    <div
                      key={w.startDate.toISOString()}
                      style={{
                        width: `${(w.actualDays / period.totalDays) * 100}%`,
                      }}
                      className="border-r border-border/40 flex flex-col justify-center items-center text-[10px] text-muted-foreground px-1 shrink-0 overflow-hidden"
                    >
                      <span className="font-semibold text-foreground truncate">
                        {w.label}
                      </span>
                      <span className="text-[9px] truncate">
                        {w.startDate.getDate()} - {w.endDate.getDate()}{" "}
                        {w.endDate.toLocaleDateString(undefined, {
                          month: "short",
                        })}
                      </span>
                    </div>
                  ))
                : period.days.map((d) => {
                    const isToday =
                      formatDateToIsoDay(d) === formatDateToIsoDay(new Date());
                    return (
                      <div
                        key={d.toISOString()}
                        style={{
                          width: `${(1 / period.totalDays) * 100}%`,
                        }}
                        className={cn(
                          "border-r border-border/40 flex flex-col justify-center items-center text-[10px] text-muted-foreground px-0.5 shrink-0 overflow-hidden",
                          isToday && "bg-primary/5 font-semibold text-primary",
                        )}
                      >
                        <span className="text-[9px]">
                          {d.toLocaleDateString(undefined, {
                            weekday: "narrow",
                          })}
                        </span>
                        <span>{d.getDate()}</span>
                      </div>
                    );
                  })}
            </div>
          </div>

          {/* Timeline Rows: One unified container, each row has left info cell + right track */}
          <div className="divide-y divide-border/40">
            {scheduled.map(({ milestone: m, visual }) => {
              const isOverdue = isMilestoneOverdue(m);
              const progress = m.progress ?? 0;

              return (
                <div
                  key={m.id}
                  className="flex h-14 relative hover:bg-muted/10 transition-colors group"
                >
                  {/* Left Column Cell: Sticky at left-0, z-10 */}
                  <button
                    type="button"
                    onClick={() => onSelectMilestone(m.id)}
                    className="sticky left-0 z-10 w-72 shrink-0 border-r border-border/80 bg-background px-3 flex flex-col justify-center gap-1 text-left cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary shadow-[1px_0_0_0_hsl(var(--border))]"
                  >
                    <div className="flex items-center justify-between gap-1 min-w-0">
                      <span className="truncate text-xs font-medium text-foreground group-hover:text-primary transition-colors">
                        {m.name}
                      </span>
                      {isOverdue && (
                        <Badge
                          variant="destructive"
                          className="h-4 px-1 text-[9px] shrink-0 font-normal"
                        >
                          {t("roadmap:overdue", { defaultValue: "Overdue" })}
                        </Badge>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] text-muted-foreground uppercase font-medium">
                        {getMilestoneStatusLabel(m.status, t)}
                      </span>
                      <span className="text-[10px] text-muted-foreground">
                        ·
                      </span>
                      <div className="flex items-center gap-1 flex-1 min-w-0">
                        <div className="h-1 w-16 overflow-hidden rounded-full bg-muted">
                          <div
                            className="h-full bg-primary"
                            style={{ width: `${progress}%` }}
                          />
                        </div>
                        <span className="text-[10px] text-muted-foreground">
                          {progress}%
                        </span>
                      </div>
                    </div>
                  </button>

                  {/* Right Track Cell */}
                  <div className="flex-1 relative flex items-center min-w-0">
                    {/* Background Grid Guidelines */}
                    <div className="absolute inset-0 flex pointer-events-none">
                      {scale === "quarter"
                        ? period.weeks.map((w) => (
                            <div
                              key={w.startDate.toISOString()}
                              style={{
                                width: `${(w.actualDays / period.totalDays) * 100}%`,
                              }}
                              className="border-r border-border/30 shrink-0"
                            />
                          ))
                        : period.days.map((d) => {
                            const isToday =
                              formatDateToIsoDay(d) ===
                              formatDateToIsoDay(new Date());
                            return (
                              <div
                                key={d.toISOString()}
                                style={{
                                  width: `${(1 / period.totalDays) * 100}%`,
                                }}
                                className={cn(
                                  "border-r border-border/30 shrink-0",
                                  isToday && "bg-primary/5",
                                )}
                              />
                            );
                          })}
                    </div>

                    {/* Milestone Bar (interval) */}
                    {visual.type === "interval" && (
                      <button
                        type="button"
                        onClick={() => onSelectMilestone(m.id)}
                        className={cn(
                          "absolute h-7 rounded-md px-2 flex items-center text-xs font-medium cursor-pointer transition-all border shadow-xs hover:brightness-105 select-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary",
                          m.status === "completed"
                            ? "bg-emerald-500/20 border-emerald-500/40 text-emerald-700 dark:text-emerald-300"
                            : m.status === "active"
                              ? "bg-blue-500/20 border-blue-500/40 text-blue-700 dark:text-blue-300"
                              : m.status === "canceled"
                                ? "bg-muted border-border text-muted-foreground"
                                : "bg-primary/20 border-primary/40 text-primary",
                        )}
                        style={{
                          left: `${visual.leftPercent}%`,
                          width: `${visual.widthPercent}%`,
                          minWidth: "24px",
                        }}
                      >
                        {visual.clippedLeft ? (
                          <ArrowLeft className="size-3 shrink-0 text-muted-foreground mr-1" />
                        ) : (
                          <span className="truncate">{m.name}</span>
                        )}
                        {visual.clippedRight && (
                          <ArrowRight className="size-3 shrink-0 text-muted-foreground ml-1" />
                        )}
                      </button>
                    )}

                    {/* Single Point: target-only */}
                    {visual.type === "target-only" &&
                      (() => {
                        const targetDateObj = parseDateSafe(m.targetDate);
                        const targetDateLabel = targetDateObj
                          ? formatDateMedium(targetDateObj)
                          : "";
                        const dueLabel = t("roadmap:timeline.due", {
                          date: targetDateLabel,
                          defaultValue: `Due ${targetDateLabel}`,
                        });
                        return (
                          <button
                            type="button"
                            onClick={() => onSelectMilestone(m.id)}
                            className="absolute -translate-x-1/2 flex items-center gap-1.5 cursor-pointer hover:scale-110 transition-transform select-none bg-transparent border-0 p-0 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded-xs"
                            style={{ left: `${visual.leftPercent}%` }}
                            title={`${m.name} (${dueLabel})`}
                            aria-label={`${m.name} ${dueLabel}`}
                          >
                            <div
                              className={cn(
                                "size-5 rotate-45 rounded-xs flex items-center justify-center border shadow-xs",
                                m.status === "completed"
                                  ? "bg-emerald-500 border-emerald-600 text-white"
                                  : "bg-primary border-primary text-primary-foreground",
                              )}
                            >
                              <Flag className="size-2.5 -rotate-45" />
                            </div>
                            <span className="text-[11px] font-medium text-foreground truncate max-w-[120px]">
                              {m.name}
                            </span>
                          </button>
                        );
                      })()}

                    {/* Single Point: start-only */}
                    {visual.type === "start-only" &&
                      (() => {
                        const startDateObj = parseDateSafe(m.startDate);
                        const startDateLabel = startDateObj
                          ? formatDateMedium(startDateObj)
                          : "";
                        const startsLabel = t("roadmap:timeline.starts", {
                          date: startDateLabel,
                          defaultValue: `Starts ${startDateLabel}`,
                        });
                        return (
                          <button
                            type="button"
                            onClick={() => onSelectMilestone(m.id)}
                            className="absolute -translate-x-1/2 flex items-center gap-1.5 cursor-pointer hover:scale-110 transition-transform select-none bg-transparent border-0 p-0 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded-full"
                            style={{ left: `${visual.leftPercent}%` }}
                            title={`${m.name} (${startsLabel})`}
                            aria-label={`${m.name} ${startsLabel}`}
                          >
                            <div className="size-4 rounded-full bg-secondary border border-border flex items-center justify-center shadow-xs">
                              <span className="size-1.5 rounded-full bg-foreground" />
                            </div>
                            <span className="text-[11px] font-medium text-foreground truncate max-w-[120px]">
                              {m.name}
                            </span>
                          </button>
                        );
                      })()}
                  </div>
                </div>
              );
            })}

            {scheduled.length === 0 && unscheduled.length === 0 && (
              <div className="p-8 text-center text-xs text-muted-foreground">
                {t("roadmap:noMilestonesInPeriod", {
                  defaultValue: "No milestones in this period",
                })}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Independent Unscheduled Section at Bottom */}
      {unscheduled.length > 0 && (
        <div className="border-t border-border/80 bg-muted/20 p-3 shrink-0">
          <div className="flex items-center gap-2 mb-2">
            <CalendarIcon className="size-3.5 text-muted-foreground" />
            <h4 className="text-xs font-semibold text-foreground">
              {t("roadmap:unscheduled", {
                defaultValue: "Unscheduled Milestones",
              })}{" "}
              ({unscheduled.length})
            </h4>
          </div>
          <div className="flex flex-wrap gap-2">
            {unscheduled.map((m) => (
              <Button
                key={m.id}
                variant="outline"
                size="xs"
                onClick={() => onSelectMilestone(m.id)}
                className="h-6 text-xs gap-1.5 bg-background"
              >
                <span className="truncate max-w-[160px]">{m.name}</span>
                <span className="text-[10px] text-muted-foreground">
                  {m.progress ?? 0}%
                </span>
              </Button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
