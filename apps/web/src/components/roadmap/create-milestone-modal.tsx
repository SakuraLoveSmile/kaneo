import { AlertCircle, Calendar as CalendarIcon, Loader2 } from "lucide-react";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
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
import { Textarea } from "@/components/ui/textarea";
import { useCreateMilestone } from "@/hooks/mutations/milestone/use-create-milestone";
import { cn } from "@/lib/cn";
import { formatDateMedium } from "@/lib/format";
import { toast } from "@/lib/toast";
import type { MilestoneStatus } from "@/types/milestone";
import { formatDateToIsoDay } from "./roadmap-date-utils";

type CreateMilestoneModalProps = {
  open: boolean;
  projectId: string;
  onClose: () => void;
  onSuccess?: (milestoneId: string) => void;
};

const STATUS_CONFIG: Record<
  MilestoneStatus,
  { labelKey: string; defaultLabel: string; dotClass: string }
> = {
  planned: {
    labelKey: "roadmap:status.planned",
    defaultLabel: "Planned",
    dotClass: "bg-zinc-400 dark:bg-zinc-500",
  },
  active: {
    labelKey: "roadmap:status.active",
    defaultLabel: "In Progress",
    dotClass: "bg-blue-500",
  },
  completed: {
    labelKey: "roadmap:status.completed",
    defaultLabel: "Completed",
    dotClass: "bg-emerald-500",
  },
  canceled: {
    labelKey: "roadmap:status.canceled",
    defaultLabel: "Canceled",
    dotClass: "bg-rose-500",
  },
};

const STATUS_KEYS: MilestoneStatus[] = [
  "planned",
  "active",
  "completed",
  "canceled",
];

function isAfterDay(a: Date, b: Date): boolean {
  const d1 = new Date(a.getFullYear(), a.getMonth(), a.getDate()).getTime();
  const d2 = new Date(b.getFullYear(), b.getMonth(), b.getDate()).getTime();
  return d1 > d2;
}

function isBeforeDay(a: Date, b: Date): boolean {
  const d1 = new Date(a.getFullYear(), a.getMonth(), a.getDate()).getTime();
  const d2 = new Date(b.getFullYear(), b.getMonth(), b.getDate()).getTime();
  return d1 < d2;
}

export default function CreateMilestoneModal({
  open,
  projectId,
  onClose,
  onSuccess,
}: CreateMilestoneModalProps) {
  const { t } = useTranslation();
  const createMilestoneMutation = useCreateMilestone();
  const isPending = createMilestoneMutation.isPending;

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [status, setStatus] = useState<MilestoneStatus>("planned");
  const [startDate, setStartDate] = useState<Date | undefined>(undefined);
  const [targetDate, setTargetDate] = useState<Date | undefined>(undefined);

  const [nameError, setNameError] = useState<string | null>(null);
  const [descError, setDescError] = useState<string | null>(null);
  const [dateError, setDateError] = useState<string | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);

  const nameInputRef = useRef<HTMLInputElement>(null);

  const resetForm = () => {
    setName("");
    setDescription("");
    setStatus("planned");
    setStartDate(undefined);
    setTargetDate(undefined);
    setNameError(null);
    setDescError(null);
    setDateError(null);
    setServerError(null);
  };

  const handleClose = () => {
    if (isPending) return;
    resetForm();
    onClose();
  };

  const handleOpenChange = (isOpen: boolean) => {
    if (isPending) return;
    if (!isOpen) {
      handleClose();
    }
  };

  const statusItems: Record<MilestoneStatus, React.ReactNode> = {
    planned: (
      <span className="inline-flex items-center gap-2">
        <span
          className={cn(
            "size-2 shrink-0 rounded-full",
            STATUS_CONFIG.planned.dotClass,
          )}
          aria-hidden="true"
        />
        <span>
          {t(STATUS_CONFIG.planned.labelKey, {
            defaultValue: STATUS_CONFIG.planned.defaultLabel,
          })}
        </span>
      </span>
    ),
    active: (
      <span className="inline-flex items-center gap-2">
        <span
          className={cn(
            "size-2 shrink-0 rounded-full",
            STATUS_CONFIG.active.dotClass,
          )}
          aria-hidden="true"
        />
        <span>
          {t(STATUS_CONFIG.active.labelKey, {
            defaultValue: STATUS_CONFIG.active.defaultLabel,
          })}
        </span>
      </span>
    ),
    completed: (
      <span className="inline-flex items-center gap-2">
        <span
          className={cn(
            "size-2 shrink-0 rounded-full",
            STATUS_CONFIG.completed.dotClass,
          )}
          aria-hidden="true"
        />
        <span>
          {t(STATUS_CONFIG.completed.labelKey, {
            defaultValue: STATUS_CONFIG.completed.defaultLabel,
          })}
        </span>
      </span>
    ),
    canceled: (
      <span className="inline-flex items-center gap-2">
        <span
          className={cn(
            "size-2 shrink-0 rounded-full",
            STATUS_CONFIG.canceled.dotClass,
          )}
          aria-hidden="true"
        />
        <span>
          {t(STATUS_CONFIG.canceled.labelKey, {
            defaultValue: STATUS_CONFIG.canceled.defaultLabel,
          })}
        </span>
      </span>
    ),
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isPending) return;

    let hasValidationError = false;
    let firstErrorField: "name" | "date" | "desc" | null = null;

    const trimmedName = name.trim();
    if (!trimmedName) {
      setNameError(
        t("roadmap:form.nameRequired", { defaultValue: "Name is required" }),
      );
      hasValidationError = true;
      firstErrorField = "name";
    } else {
      setNameError(null);
    }

    if (description.length > 20000) {
      setDescError(
        t("roadmap:form.invalidDescriptionLength", {
          defaultValue: "Description must be 20,000 characters or less",
        }),
      );
      hasValidationError = true;
      if (!firstErrorField) firstErrorField = "desc";
    } else {
      setDescError(null);
    }

    if (startDate && targetDate && isAfterDay(startDate, targetDate)) {
      setDateError(
        t("roadmap:form.invalidDateRange", {
          defaultValue: "Start date must be on or before target date",
        }),
      );
      hasValidationError = true;
      if (!firstErrorField) firstErrorField = "date";
    } else {
      setDateError(null);
    }

    if (hasValidationError) {
      if (firstErrorField === "name") {
        nameInputRef.current?.focus();
      }
      return;
    }

    setServerError(null);

    try {
      const created = await createMilestoneMutation.mutateAsync({
        projectId,
        payload: {
          name: trimmedName,
          description: description.trim() || null,
          status,
          startDate: startDate ? formatDateToIsoDay(startDate) : null,
          targetDate: targetDate ? formatDateToIsoDay(targetDate) : null,
        },
      });

      toast.success(
        t("roadmap:form.createSuccess", {
          defaultValue: "Milestone created successfully",
        }),
      );
      resetForm();
      onClose();
      onSuccess?.(created.id);
    } catch (err: unknown) {
      const msg =
        err instanceof Error ? err.message : "Failed to create milestone";
      setServerError(msg);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogPopup
        className="sm:max-w-[520px] max-h-[90dvh] flex flex-col"
        showCloseButton={!isPending}
      >
        <form onSubmit={handleSubmit} noValidate className="contents">
          <DialogHeader className="gap-1.5 p-6 pb-2 max-sm:p-4 max-sm:pb-2">
            <DialogTitle className="font-semibold text-xl leading-7">
              {t("roadmap:createMilestone", {
                defaultValue: "Create milestone",
              })}
            </DialogTitle>
            <DialogDescription className="text-sm text-muted-foreground leading-5">
              {t("roadmap:createMilestoneDesc", {
                defaultValue:
                  "Plan major project goals, deliverables, and timelines.",
              })}
            </DialogDescription>
          </DialogHeader>

          <DialogPanel className="p-6 pt-2 pb-6 max-sm:p-4 max-sm:pt-2 space-y-5">
            {serverError && (
              <div
                role="alert"
                className="flex items-start gap-2.5 rounded-lg border border-destructive/20 bg-destructive/10 p-3 text-xs text-destructive"
              >
                <AlertCircle
                  className="size-4 shrink-0 mt-0.5"
                  aria-hidden="true"
                />
                <div className="flex-1 leading-relaxed">{serverError}</div>
              </div>
            )}

            <div className="space-y-2">
              <label
                htmlFor="milestone-name"
                className="text-sm font-medium text-foreground block"
              >
                {t("roadmap:fields.name", { defaultValue: "Name" })}{" "}
                <span className="text-destructive">*</span>
              </label>
              <Input
                id="milestone-name"
                ref={nameInputRef}
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  if (nameError) setNameError(null);
                  if (serverError) setServerError(null);
                }}
                placeholder={t("roadmap:fields.namePlaceholder", {
                  defaultValue: "e.g., v1.0 Launch, Beta Release",
                })}
                maxLength={200}
                required
                disabled={isPending}
                autoFocus
                aria-invalid={!!nameError}
                aria-describedby={
                  nameError ? "milestone-name-error" : undefined
                }
                className="h-10 max-sm:h-11 items-center [&_input]:h-full text-sm"
              />
              {nameError && (
                <p
                  id="milestone-name-error"
                  role="alert"
                  className="text-xs text-destructive"
                >
                  {nameError}
                </p>
              )}
            </div>

            <div className="space-y-2">
              <label
                htmlFor="milestone-desc"
                className="text-sm font-medium text-foreground block"
              >
                {t("roadmap:fields.description", {
                  defaultValue: "Description",
                })}{" "}
                <span className="font-normal text-muted-foreground text-xs">
                  {t("roadmap:fields.optional", { defaultValue: "(optional)" })}
                </span>
              </label>
              <Textarea
                id="milestone-desc"
                value={description}
                onChange={(e) => {
                  setDescription(e.target.value);
                  if (descError) setDescError(null);
                  if (serverError) setServerError(null);
                }}
                placeholder={t("roadmap:fields.descriptionPlaceholder", {
                  defaultValue:
                    "Briefly describe what this milestone will achieve...",
                })}
                maxLength={20000}
                disabled={isPending}
                aria-invalid={!!descError}
                aria-describedby={
                  descError ? "milestone-desc-error" : undefined
                }
                className="min-h-24 [&_textarea]:min-h-24 [&_textarea]:resize-y text-sm"
              />
              {descError && (
                <p
                  id="milestone-desc-error"
                  role="alert"
                  className="text-xs text-destructive"
                >
                  {descError}
                </p>
              )}
            </div>

            <div className="space-y-2">
              <label
                htmlFor="milestone-status"
                className="text-sm font-medium text-foreground block"
              >
                {t("roadmap:fields.status", { defaultValue: "Status" })}
              </label>
              <Select
                items={statusItems}
                value={status}
                onValueChange={(val) => {
                  setStatus(val as MilestoneStatus);
                  if (serverError) setServerError(null);
                }}
                disabled={isPending}
              >
                <SelectTrigger
                  id="milestone-status"
                  className="h-10 sm:h-10 max-sm:h-11 w-full text-sm"
                >
                  <SelectValue>
                    <span className="inline-flex items-center gap-2">
                      <span
                        className={cn(
                          "size-2 shrink-0 rounded-full",
                          STATUS_CONFIG[status].dotClass,
                        )}
                        aria-hidden="true"
                      />
                      <span>
                        {t(STATUS_CONFIG[status].labelKey, {
                          defaultValue: STATUS_CONFIG[status].defaultLabel,
                        })}
                      </span>
                    </span>
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {STATUS_KEYS.map((s) => (
                    <SelectItem key={s} value={s}>
                      <span className="inline-flex items-center gap-2">
                        <span
                          className={cn(
                            "size-2 shrink-0 rounded-full",
                            STATUS_CONFIG[s].dotClass,
                          )}
                          aria-hidden="true"
                        />
                        <span>
                          {t(STATUS_CONFIG[s].labelKey, {
                            defaultValue: STATUS_CONFIG[s].defaultLabel,
                          })}
                        </span>
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-2">
                  <span className="text-sm font-medium text-foreground block">
                    {t("roadmap:fields.startDate", {
                      defaultValue: "Start date",
                    })}{" "}
                    <span className="font-normal text-muted-foreground text-xs">
                      {t("roadmap:fields.optional", {
                        defaultValue: "(optional)",
                      })}
                    </span>
                  </span>
                  <Popover>
                    <PopoverTrigger asChild>
                      <Button
                        type="button"
                        variant="outline"
                        disabled={isPending}
                        aria-invalid={!!dateError}
                        aria-describedby={
                          dateError ? "milestone-dates-error" : undefined
                        }
                        className={cn(
                          "h-10 max-sm:h-11 w-full justify-start text-left font-normal text-sm",
                          dateError && "border-destructive/60",
                        )}
                      >
                        <CalendarIcon className="mr-2 size-4 text-muted-foreground shrink-0" />
                        {startDate ? (
                          <span>{formatDateMedium(startDate)}</span>
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
                        selected={startDate}
                        onSelect={(d) => {
                          setStartDate(d);
                          if (dateError) setDateError(null);
                          if (serverError) setServerError(null);
                        }}
                        disabled={(d) =>
                          targetDate ? isAfterDay(d, targetDate) : false
                        }
                      />
                      {startDate && (
                        <div className="border-t border-border p-2">
                          <Button
                            type="button"
                            variant="ghost"
                            size="xs"
                            className="w-full text-xs text-muted-foreground"
                            onClick={() => {
                              setStartDate(undefined);
                              if (dateError) setDateError(null);
                              if (serverError) setServerError(null);
                            }}
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

                <div className="space-y-2">
                  <span className="text-sm font-medium text-foreground block">
                    {t("roadmap:fields.targetDate", {
                      defaultValue: "Target date",
                    })}{" "}
                    <span className="font-normal text-muted-foreground text-xs">
                      {t("roadmap:fields.optional", {
                        defaultValue: "(optional)",
                      })}
                    </span>
                  </span>
                  <Popover>
                    <PopoverTrigger asChild>
                      <Button
                        type="button"
                        variant="outline"
                        disabled={isPending}
                        aria-invalid={!!dateError}
                        aria-describedby={
                          dateError ? "milestone-dates-error" : undefined
                        }
                        className={cn(
                          "h-10 max-sm:h-11 w-full justify-start text-left font-normal text-sm",
                          dateError && "border-destructive/60",
                        )}
                      >
                        <CalendarIcon className="mr-2 size-4 text-muted-foreground shrink-0" />
                        {targetDate ? (
                          <span>{formatDateMedium(targetDate)}</span>
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
                        selected={targetDate}
                        onSelect={(d) => {
                          setTargetDate(d);
                          if (dateError) setDateError(null);
                          if (serverError) setServerError(null);
                        }}
                        disabled={(d) =>
                          startDate ? isBeforeDay(d, startDate) : false
                        }
                      />
                      {targetDate && (
                        <div className="border-t border-border p-2">
                          <Button
                            type="button"
                            variant="ghost"
                            size="xs"
                            className="w-full text-xs text-muted-foreground"
                            onClick={() => {
                              setTargetDate(undefined);
                              if (dateError) setDateError(null);
                              if (serverError) setServerError(null);
                            }}
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
              {dateError && (
                <p
                  id="milestone-dates-error"
                  role="alert"
                  className="text-xs text-destructive"
                >
                  {dateError}
                </p>
              )}
            </div>
          </DialogPanel>

          <DialogFooter className="border-t bg-muted/72 px-6 py-4 max-sm:px-4 max-sm:py-3 flex flex-row justify-end gap-2.5">
            <Button
              type="button"
              variant="outline"
              onClick={handleClose}
              disabled={isPending}
              className="h-10 max-sm:h-11 px-4 text-sm font-medium"
            >
              {t("common:actions.cancel", { defaultValue: "Cancel" })}
            </Button>
            <Button
              type="submit"
              disabled={isPending}
              className="h-10 max-sm:h-11 px-4 text-sm font-medium min-w-[108px]"
            >
              {isPending ? (
                <span className="inline-flex items-center gap-2">
                  <Loader2
                    className="size-4 animate-spin shrink-0"
                    aria-hidden="true"
                  />
                  <span>
                    {t("roadmap:form.creatingButton", {
                      defaultValue: "Creating...",
                    })}
                  </span>
                </span>
              ) : (
                t("roadmap:form.createButton", {
                  defaultValue: "Create milestone",
                })
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
