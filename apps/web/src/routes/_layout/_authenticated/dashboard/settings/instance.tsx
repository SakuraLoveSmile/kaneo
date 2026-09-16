import {
  createFileRoute,
  Link,
  Outlet,
  redirect,
  useLocation,
} from "@tanstack/react-router";
import { Database, Server } from "lucide-react";
import { useTranslation } from "react-i18next";
import SettingsSidebar from "@/components/SettingsSidebar";
import { Button } from "@/components/ui/button";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { authClient } from "@/lib/auth-client";
import { cn } from "@/lib/cn";

export const Route = createFileRoute(
  "/_layout/_authenticated/dashboard/settings/instance",
)({
  beforeLoad: async () => {
    let role: string | undefined;
    try {
      const { data } = await authClient.getSession();
      role = (data?.user as { role?: string } | undefined)?.role;
    } catch {}

    if (role !== "admin") {
      throw redirect({
        to: "/dashboard/settings/account/information",
      });
    }
  },
  component: RouteComponent,
});

function RouteComponent() {
  const { t } = useTranslation();
  const location = useLocation();
  const isActivePath = (path: string) => location.pathname === path;

  const menuItems = [
    {
      title: t("settings:instance.storage"),
      url: "/dashboard/settings/instance/storage",
      icon: Database,
    },
  ];

  return (
    <div className="flex gap-6 h-full">
      <SettingsSidebar>
        <div className="p-2">
          <div className="mb-2 flex items-center gap-2.5 rounded-md px-2 py-2 border border-border/40 bg-muted/30">
            <div className="flex size-8 items-center justify-center rounded bg-primary/10 text-primary">
              <Server className="size-4" />
            </div>
            <div className="flex min-w-0 flex-col">
              <p className="truncate text-sm font-medium">
                {t("settings:instance.title")}
              </p>
              <p className="truncate text-xs text-muted-foreground">
                {t("settings:instance.tab")}
              </p>
            </div>
          </div>

          <SidebarGroup className="gap-1 p-1">
            <SidebarGroupLabel className="h-7 px-2 text-xs uppercase tracking-wide text-sidebar-foreground/70">
              {t("settings:instance.title")}
            </SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu className="gap-0.5">
                {menuItems.map((item) => (
                  <SidebarMenuItem key={item.title}>
                    <Button
                      render={<Link to={item.url} />}
                      variant="ghost"
                      size="sm"
                      className={cn(
                        "h-8 w-full justify-start gap-2 rounded-lg px-2 text-sm font-normal text-sidebar-foreground/80",
                        isActivePath(item.url) &&
                          "bg-sidebar-accent text-sidebar-accent-foreground",
                      )}
                    >
                      <item.icon className="h-4 w-4" />
                      <span>{item.title}</span>
                    </Button>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </div>
      </SettingsSidebar>

      <div className="flex-1 min-w-0 overflow-y-auto">
        <Outlet />
      </div>
    </div>
  );
}
