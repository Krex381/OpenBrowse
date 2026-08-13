import { registerSessionInspectionRoutes } from "./sessions/inspection.js";
import { registerSessionInteractionRoutes } from "./sessions/interaction.js";
import {
  registerSessionLifecycleRoutes,
  type SessionRouteDeps,
} from "./sessions/lifecycle.js";

export function registerSessionRoutes(input: SessionRouteDeps): void {
  registerSessionLifecycleRoutes(input);
  registerSessionInspectionRoutes(input);
  registerSessionInteractionRoutes(input);
}
