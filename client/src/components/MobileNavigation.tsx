
import { useLocation } from "wouter";
import { cn } from "@/lib/utils";

export function MobileNavigation() {
  const [location, navigate] = useLocation();

  const navItems = [
    { 
      path: "/", 
      icon: "fas fa-home", 
      label: "Home",
      isActive: location === "/"
    },
    { 
      path: "/events", 
      icon: "fas fa-calendar", 
      label: "Events",
      isActive: location.startsWith("/events")
    },
    { 
      path: "/challenges", 
      icon: "fas fa-swords", 
      label: "Challenges",
      isActive: location.startsWith("/challenges")
    },
    { 
      path: "/friends", 
      icon: "fas fa-users", 
      label: "Friends",
      isActive: location.startsWith("/friends")
    },
    { 
      path: "/profile", 
      icon: "fas fa-user", 
      label: "Profile",
      isActive: location.startsWith("/profile")
    },
  ];

  const handleNavigation = (path: string) => {
    navigate(path);
  };

  return (
    <div className="fixed bottom-0 left-0 right-0 bg-background/95 backdrop-blur-sm border-t border-border md:hidden z-50">
      <div className="flex items-center justify-around px-2 py-2">
        {navItems.map((item) => (
          <button
            key={item.path}
            onClick={() => handleNavigation(item.path)}
            className={cn(
              "flex flex-col items-center justify-center p-2 rounded-lg transition-all duration-200 ease-in-out min-w-[60px]",
              "hover:bg-accent/50 active:scale-95",
              item.isActive 
                ? "text-primary bg-primary/10 scale-105" 
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            <i 
              className={cn(
                item.icon, 
                "text-lg mb-1 transition-transform duration-200",
                item.isActive && "scale-110"
              )} 
            />
            <span className={cn(
              "text-xs font-medium transition-all duration-200",
              item.isActive && "font-semibold"
            )}>
              {item.label}
            </span>
            {item.isActive && (
              <div className="absolute -top-0.5 left-1/2 transform -translate-x-1/2 w-8 h-0.5 bg-primary rounded-full" />
            )}
          </button>
        ))}
      </div>
    </div>
  );
}
