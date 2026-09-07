import {
  ChevronLeft,
  ChevronRight,
  Link as LinkIcon,
  RefreshCw,
  Search,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useUpdateTaskMilestone } from "@/hooks/mutations/task/use-update-task-milestone";
import { useGetMilestoneTaskOptions } from "@/hooks/queries/milestone/use-get-milestone-task-options";
import { useGetMilestones } from "@/hooks/queries/milestone/use-get-milestones";
import { useWorkspacePermission } from "@/hooks/use-workspace-permission";
import { cn } from "@/lib/cn";
import { toast } from "@/lib/toast";

type LinkTaskPopoverProps = {
  projectId: string;
  milestoneId: string;
};

export default function LinkTaskPopover({
  projectId,
  milestoneId,
}: LinkTaskPopoverProps) {
  const { t } = useTranslation();
  const { canUpdateTasks } = useWorkspacePermission();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [page, setPage] = useState(1);

  // Reset search, page, and popover when project changes
  useEffect(() => {
    if (projectId) {
      setSearch("");
      setDebouncedSearch("");
      setPage(1);
      setOpen(false);
    }
  }, [projectId]);

  // Debounce search input by 250ms and reset to page 1 on search change
  useEffect(() => {
    const handler = setTimeout(() => {
      setDebouncedSearch(search.trim());
      setPage(1);
    }, 250);
    return () => clearTimeout(handler);
  }, [search]);

  const {
    data: taskData,
    isLoading,
    isFetching,
    isPlaceholderData,
    isError,
    error,
    refetch,
  } = useGetMilestoneTaskOptions(projectId, page, debouncedSearch);

  const { data: milestones = [] } = useGetMilestones(projectId);
  const updateMilestoneMutation = useUpdateTaskMilestone();

  const milestoneMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of milestones) {
      map.set(m.id, m.name);
    }
    return map;
  }, [milestones]);

  const tasks = taskData?.tasks || [];
  const totalPages = taskData?.totalPages ?? 1;

  // Auto-recover current page when totalPages shrinks (e.g. tasks deleted/moved in another window)
  useEffect(() => {
    if (taskData?.totalPages && page > taskData.totalPages) {
      setPage(Math.max(1, taskData.totalPages));
    }
  }, [taskData?.totalPages, page]);

  // Prevent operating on stale results when search keyword changed or while fetching with placeholderData
  const isSearchStale =
    search.trim() !== debouncedSearch.trim() ||
    (isFetching && isPlaceholderData && debouncedSearch.trim() !== "");
  const isPageFetching = isFetching && isPlaceholderData;
  const isStaleOrFetching = isSearchStale || isPageFetching;

  const handleLinkTask = async (
    taskId: string,
    isAlreadyLinkedToOther: boolean,
  ) => {
    if (!canUpdateTasks() || isStaleOrFetching) return;
    try {
      await updateMilestoneMutation.mutateAsync({
        taskId,
        milestoneId,
        projectId,
      });

      toast.success(
        isAlreadyLinkedToOther
          ? t("roadmap:linkTask.switchSuccess", {
              defaultValue: "Task association switched successfully",
            })
          : t("roadmap:linkTask.linkSuccess", {
              defaultValue: "Task linked successfully",
            }),
      );
      setOpen(false);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to link task";
      toast.error(msg);
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="xs"
          className="h-7 gap-1.5 text-xs"
          disabled={!canUpdateTasks()}
        >
          <LinkIcon className="size-3.5 text-muted-foreground" />
          {t("roadmap:linkTask.button", { defaultValue: "Link task" })}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-2" align="end">
        <div className="space-y-2">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value.slice(0, 200))}
              placeholder={t("roadmap:linkTask.searchPlaceholder", {
                defaultValue: "Search tasks...",
              })}
              maxLength={200}
              className="h-8 pl-8 text-xs"
            />
          </div>

          <div
            className={cn(
              "max-h-60 overflow-y-auto space-y-1 transition-opacity",
              isStaleOrFetching && "opacity-60",
            )}
          >
            {isError ? (
              <div className="p-3 text-center space-y-2" role="alert">
                <p className="text-xs text-destructive">
                  {error instanceof Error
                    ? error.message
                    : t("roadmap:linkTask.loadError", {
                        defaultValue: "Failed to load tasks",
                      })}
                </p>
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  className="h-6 text-[11px] gap-1"
                  onClick={() => refetch()}
                >
                  <RefreshCw className="size-3" />
                  {t("common:retry", { defaultValue: "Retry" })}
                </Button>
              </div>
            ) : isLoading && !taskData ? (
              <p
                className="p-3 text-center text-xs text-muted-foreground"
                role="status"
              >
                {t("common:loading", { defaultValue: "Loading..." })}
              </p>
            ) : tasks.length === 0 ? (
              <p className="p-3 text-center text-xs text-muted-foreground">
                {t("roadmap:linkTask.noTasksFound", {
                  defaultValue: "No tasks found",
                })}
              </p>
            ) : (
              tasks.map((task) => {
                const isCurrent = task.milestoneId === milestoneId;
                const isOther = Boolean(task.milestoneId && !isCurrent);
                const otherMilestoneName =
                  isOther && task.milestoneId
                    ? milestoneMap.get(task.milestoneId) ||
                      t("roadmap:unknownMilestone", {
                        defaultValue: "Another milestone",
                      })
                    : null;

                return (
                  <div
                    key={task.id}
                    className="flex items-center justify-between gap-2 rounded-md p-1.5 text-xs hover:bg-muted/60 transition-colors"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium text-foreground">
                        {task.title}
                      </p>
                      {isCurrent ? (
                        <p className="text-[10px] text-emerald-600 dark:text-emerald-400">
                          {t("roadmap:linkTask.alreadyLinked", {
                            defaultValue: "Already linked to this milestone",
                          })}
                        </p>
                      ) : isOther ? (
                        <p className="text-[10px] text-amber-600 dark:text-amber-400 truncate">
                          {t("roadmap:linkTask.linkedToOther", {
                            name: otherMilestoneName,
                            defaultValue: `Currently in: ${otherMilestoneName}`,
                          })}
                        </p>
                      ) : null}
                    </div>

                    {!isCurrent && canUpdateTasks() && (
                      <Button
                        type="button"
                        variant={isOther ? "secondary" : "ghost"}
                        size="xs"
                        disabled={
                          updateMilestoneMutation.isPending || isStaleOrFetching
                        }
                        onClick={() => handleLinkTask(task.id, isOther)}
                        className="shrink-0 h-6 text-[11px] gap-1"
                      >
                        {isOther ? (
                          <>
                            <RefreshCw className="size-3" />
                            {t("roadmap:linkTask.switchAction", {
                              defaultValue: "Switch",
                            })}
                          </>
                        ) : (
                          t("roadmap:linkTask.linkAction", {
                            defaultValue: "Link",
                          })
                        )}
                      </Button>
                    )}
                  </div>
                );
              })
            )}
          </div>

          {totalPages > 1 && (
            <div className="flex items-center justify-between pt-1 border-t border-border/60 text-xs text-muted-foreground">
              <span>
                {t("common:page", { defaultValue: "Page" })} {page} /{" "}
                {totalPages}
              </span>
              <div className="flex items-center gap-1">
                <Button
                  variant="outline"
                  size="icon-xs"
                  className="h-6 w-6"
                  disabled={page <= 1 || isFetching}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  aria-label={t("common:previous", {
                    defaultValue: "Previous",
                  })}
                  title={t("common:previous", {
                    defaultValue: "Previous",
                  })}
                >
                  <ChevronLeft className="size-3" />
                </Button>
                <Button
                  variant="outline"
                  size="icon-xs"
                  className="h-6 w-6"
                  disabled={page >= totalPages || isFetching}
                  onClick={() => setPage((p) => p + 1)}
                  aria-label={t("common:next", {
                    defaultValue: "Next",
                  })}
                  title={t("common:next", {
                    defaultValue: "Next",
                  })}
                >
                  <ChevronRight className="size-3" />
                </Button>
              </div>
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
