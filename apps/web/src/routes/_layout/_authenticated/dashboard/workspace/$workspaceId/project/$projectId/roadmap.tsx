import { createFileRoute, useNavigate } from "@tanstack/react-router";
import {
  AlertTriangle,
  CalendarRange,
  List,
  Plus,
  RefreshCw,
  Search,
} from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import ProjectLayout from "@/components/common/project-layout";
import PageTitle from "@/components/page-title";
import CreateMilestoneModal from "@/components/roadmap/create-milestone-modal";
import MilestoneDetailsSheet from "@/components/roadmap/milestone-details-sheet";
import {
  formatDateToIsoDay,
  parseDateSafe,
  parseUrlDateOrToday,
  type RoadmapScale,
} from "@/components/roadmap/roadmap-date-utils";
import RoadmapList from "@/components/roadmap/roadmap-list";
import RoadmapTimeline from "@/components/roadmap/roadmap-timeline";
import CreateTaskModal from "@/components/shared/modals/create-task-modal";
import TaskDetailsSheet from "@/components/task/task-details-sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useGetMilestones } from "@/hooks/queries/milestone/use-get-milestones";
import useGetProject from "@/hooks/queries/project/use-get-project";
import { useIsMobile } from "@/hooks/use-mobile";
import { useWorkspacePermission } from "@/hooks/use-workspace-permission";
import { cn } from "@/lib/cn";

export type RoadmapSearchParams = {
  view?: "timeline" | "list";
  scale?: "month" | "quarter";
  date?: string;
  status?: "all" | "planned" | "active" | "completed" | "canceled";
  q?: string;
  milestoneId?: string;
  taskId?: string;
};

const VALID_VIEWS = ["timeline", "list"] as const;
const VALID_SCALES = ["month", "quarter"] as const;
const VALID_STATUSES = [
  "all",
  "planned",
  "active",
  "completed",
  "canceled",
] as const;

export const Route = createFileRoute(
  "/_layout/_authenticated/dashboard/workspace/$workspaceId/project/$projectId/roadmap",
)({
  component: RouteComponent,
  validateSearch: (search: Record<string, unknown>): RoadmapSearchParams => {
    const rawView = typeof search.view === "string" ? search.view : undefined;
    const view =
      rawView && (VALID_VIEWS as readonly string[]).includes(rawView)
        ? (rawView as "timeline" | "list")
        : undefined;

    const rawScale =
      typeof search.scale === "string" ? search.scale : undefined;
    const scale =
      rawScale && (VALID_SCALES as readonly string[]).includes(rawScale)
        ? (rawScale as "month" | "quarter")
        : "month";

    const rawDate = typeof search.date === "string" ? search.date : undefined;
    const validDate = rawDate && parseDateSafe(rawDate) ? rawDate : undefined;

    const rawStatus =
      typeof search.status === "string" ? search.status : undefined;
    const status =
      rawStatus && (VALID_STATUSES as readonly string[]).includes(rawStatus)
        ? (rawStatus as RoadmapSearchParams["status"])
        : "all";

    const q = typeof search.q === "string" ? search.q : undefined;
    const milestoneId =
      typeof search.milestoneId === "string" ? search.milestoneId : undefined;
    const taskId =
      typeof search.taskId === "string" ? search.taskId : undefined;

    return {
      view,
      scale,
      date: validDate,
      status,
      q,
      milestoneId,
      taskId,
    };
  },
});

function RouteComponent() {
  const { t } = useTranslation();
  const { projectId, workspaceId } = Route.useParams();
  const searchParams = Route.useSearch();
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const { canCreateTasks } = useWorkspacePermission();

  const { data: project } = useGetProject({ id: projectId, workspaceId });
  const {
    data: milestones = [],
    isLoading,
    error: milestonesError,
    refetch: refetchMilestones,
  } = useGetMilestones(projectId);

  // Resolved view: URL param takes precedence; fallback to desktop=timeline, mobile=list
  const currentView = searchParams.view ?? (isMobile ? "list" : "timeline");
  const currentScale: RoadmapScale = searchParams.scale ?? "month";
  const currentStatus = searchParams.status ?? "all";
  const searchQuery = searchParams.q ?? "";
  const activeMilestoneId = searchParams.milestoneId;
  const activeTaskId = searchParams.taskId;

  const currentDate = useMemo(() => {
    return parseUrlDateOrToday(searchParams.date);
  }, [searchParams.date]);

  const [isCreateMilestoneOpen, setIsCreateMilestoneOpen] = useState(false);
  const [createTaskMilestoneId, setCreateTaskMilestoneId] = useState<
    string | undefined
  >(undefined);
  const [isCreateTaskOpen, setIsCreateTaskOpen] = useState(false);

  // View switch: normal navigation to support browser back button
  const handleViewChange = (view: "timeline" | "list") => {
    navigate({
      to: ".",
      search: (prev: RoadmapSearchParams) => ({ ...prev, view }),
      replace: false,
    });
  };

  // Scale switch
  const handleScaleChange = (scale: RoadmapScale) => {
    navigate({
      to: ".",
      search: (prev: RoadmapSearchParams) => ({ ...prev, scale }),
      replace: false,
    });
  };

  // Date navigation
  const handleDateChange = (nextDate: Date) => {
    navigate({
      to: ".",
      search: (prev: RoadmapSearchParams) => ({
        ...prev,
        date: formatDateToIsoDay(nextDate),
      }),
      replace: false,
    });
  };

  // Status filter
  const handleStatusChange = (status: string) => {
    navigate({
      to: ".",
      search: (prev: RoadmapSearchParams) => ({
        ...prev,
        status: status as RoadmapSearchParams["status"],
      }),
      replace: false,
    });
  };

  // Search input: uses replace: true so typing doesn't create thousands of history entries
  const handleSearchChange = (q: string) => {
    navigate({
      to: ".",
      search: (prev: RoadmapSearchParams) => ({
        ...prev,
        q: q || undefined,
      }),
      replace: true,
    });
  };

  // Select milestone: normal navigation to support browser history
  const handleSelectMilestone = useCallback(
    (milestoneId: string) => {
      navigate({
        to: ".",
        search: (prev: RoadmapSearchParams) => ({
          ...prev,
          milestoneId,
        }),
        replace: false,
      });
    },
    [navigate],
  );

  // Close milestone details
  const handleCloseMilestone = useCallback(() => {
    navigate({
      to: ".",
      search: (prev: RoadmapSearchParams) => ({
        ...prev,
        milestoneId: undefined,
      }),
      replace: true,
    });
  }, [navigate]);

  // Select task: opens TaskDetailsSheet on top, preserves milestoneId
  const handleSelectTask = useCallback(
    (taskId: string) => {
      navigate({
        to: ".",
        search: (prev: RoadmapSearchParams) => ({
          ...prev,
          taskId,
        }),
        replace: false,
      });
    },
    [navigate],
  );

  // Close task details: returns to milestone details sheet
  const handleCloseTask = useCallback(() => {
    navigate({
      to: ".",
      search: (prev: RoadmapSearchParams) => ({
        ...prev,
        taskId: undefined,
      }),
      replace: true,
    });
  }, [navigate]);

  const handleOpenCreateTask = (milestoneId: string) => {
    setCreateTaskMilestoneId(milestoneId);
    setIsCreateTaskOpen(true);
  };

  return (
    <ProjectLayout
      projectId={projectId}
      workspaceId={workspaceId}
      activeView="roadmap"
    >
      <PageTitle
        title={`${project?.name || "Project"} · ${t("roadmap:title", { defaultValue: "Roadmap" })}`}
        hideAppName
      />

      <div className="flex h-full flex-col overflow-hidden">
        {/* Toolbar Header */}
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/80 px-4 py-2 shrink-0 bg-background">
          <div className="flex flex-wrap items-center gap-2">
            {/* View Switcher: Timeline | List */}
            <div className="inline-flex rounded-lg border border-border/80 bg-background p-0.5">
              <Button
                variant={currentView === "timeline" ? "secondary" : "ghost"}
                size="xs"
                onClick={() => handleViewChange("timeline")}
                className={cn(
                  "h-6 gap-1 px-2 text-xs",
                  currentView !== "timeline" && "text-muted-foreground",
                )}
              >
                <CalendarRange className="size-3.5" />
                {t("roadmap:views.timeline", { defaultValue: "Timeline" })}
              </Button>
              <Button
                variant={currentView === "list" ? "secondary" : "ghost"}
                size="xs"
                onClick={() => handleViewChange("list")}
                className={cn(
                  "h-6 gap-1 px-2 text-xs",
                  currentView !== "list" && "text-muted-foreground",
                )}
              >
                <List className="size-3.5" />
                {t("roadmap:views.list", { defaultValue: "List" })}
              </Button>
            </div>

            {/* Scale Switcher: Month | Quarter (shown when in timeline view) */}
            {currentView === "timeline" && (
              <div className="inline-flex rounded-lg border border-border/80 bg-background p-0.5">
                <Button
                  variant={currentScale === "month" ? "secondary" : "ghost"}
                  size="xs"
                  onClick={() => handleScaleChange("month")}
                  className={cn(
                    "h-6 px-2 text-xs",
                    currentScale !== "month" && "text-muted-foreground",
                  )}
                >
                  {t("roadmap:scale.month", { defaultValue: "Month" })}
                </Button>
                <Button
                  variant={currentScale === "quarter" ? "secondary" : "ghost"}
                  size="xs"
                  onClick={() => handleScaleChange("quarter")}
                  className={cn(
                    "h-6 px-2 text-xs",
                    currentScale !== "quarter" && "text-muted-foreground",
                  )}
                >
                  {t("roadmap:scale.quarter", { defaultValue: "Quarter" })}
                </Button>
              </div>
            )}

            {/* Status Filter */}
            <Select value={currentStatus} onValueChange={handleStatusChange}>
              <SelectTrigger className="h-7 w-[120px] text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">
                  {t("roadmap:status.all", { defaultValue: "All statuses" })}
                </SelectItem>
                <SelectItem value="planned">
                  {t("roadmap:status.planned", { defaultValue: "Planned" })}
                </SelectItem>
                <SelectItem value="active">
                  {t("roadmap:status.active", { defaultValue: "In Progress" })}
                </SelectItem>
                <SelectItem value="completed">
                  {t("roadmap:status.completed", { defaultValue: "Completed" })}
                </SelectItem>
                <SelectItem value="canceled">
                  {t("roadmap:status.canceled", { defaultValue: "Canceled" })}
                </SelectItem>
              </SelectContent>
            </Select>

            {/* Search Input */}
            <div className="relative w-48 sm:w-60">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
              <Input
                value={searchQuery}
                onChange={(e) => handleSearchChange(e.target.value)}
                placeholder={t("roadmap:searchPlaceholder", {
                  defaultValue: "Filter milestones...",
                })}
                className="h-7 pl-8 text-xs"
              />
            </div>
          </div>

          {/* Action Button: Create Milestone */}
          {canCreateTasks() && (
            <Button
              size="xs"
              onClick={() => setIsCreateMilestoneOpen(true)}
              className="h-7 gap-1 text-xs"
            >
              <Plus className="size-3.5" />
              {t("roadmap:createMilestone", { defaultValue: "New milestone" })}
            </Button>
          )}
        </div>

        {/* View Content: Timeline or List */}
        <div className="flex-1 min-h-0 overflow-hidden">
          {milestonesError ? (
            <div className="flex h-64 flex-col items-center justify-center gap-3 p-6 text-center">
              <AlertTriangle className="size-8 text-destructive" />
              <p className="text-sm font-medium text-foreground">
                {milestonesError instanceof Error
                  ? milestonesError.message
                  : t("roadmap:errors.loadMilestonesFailed", {
                      defaultValue: "Failed to load milestones",
                    })}
              </p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => refetchMilestones()}
                className="gap-1.5 text-xs"
              >
                <RefreshCw className="size-3.5" />
                {t("common:retry", { defaultValue: "Retry" })}
              </Button>
            </div>
          ) : currentView === "timeline" ? (
            <RoadmapTimeline
              milestones={milestones}
              currentDate={currentDate}
              scale={currentScale}
              searchQuery={searchQuery}
              statusFilter={currentStatus}
              onSelectMilestone={handleSelectMilestone}
              onNavigateDate={handleDateChange}
              isLoading={isLoading}
            />
          ) : (
            <div className="h-full overflow-y-auto">
              <RoadmapList
                milestones={milestones}
                searchQuery={searchQuery}
                statusFilter={currentStatus}
                onSelectMilestone={handleSelectMilestone}
                isLoading={isLoading}
              />
            </div>
          )}
        </div>

        {/* Create Milestone Modal */}
        <CreateMilestoneModal
          open={isCreateMilestoneOpen}
          projectId={projectId}
          onClose={() => setIsCreateMilestoneOpen(false)}
          onSuccess={(newId) => handleSelectMilestone(newId)}
        />

        {/* Milestone Details Sheet */}
        <MilestoneDetailsSheet
          projectId={projectId}
          milestoneId={activeMilestoneId}
          onClose={handleCloseMilestone}
          onSelectTask={handleSelectTask}
          onCreateTask={handleOpenCreateTask}
        />

        {/* Task Details Sheet on top if taskId is present */}
        <TaskDetailsSheet
          taskId={activeTaskId}
          projectId={projectId}
          workspaceId={workspaceId}
          onClose={handleCloseTask}
        />

        {/* Create Task Modal with preselected milestone */}
        <CreateTaskModal
          open={isCreateTaskOpen}
          projectId={projectId}
          initialMilestoneId={createTaskMilestoneId}
          onClose={() => {
            setIsCreateTaskOpen(false);
            setCreateTaskMilestoneId(undefined);
          }}
        />
      </div>
    </ProjectLayout>
  );
}
