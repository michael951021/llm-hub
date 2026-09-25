import {
  createRootRoute, createRoute, createRouter, Outlet,
} from "@tanstack/react-router";
import { RootLayout } from "./routes/root.js";
import { SignInRoute, SignUpRoute } from "./routes/auth.js";
import { FleetRoute } from "./routes/fleet.js";

const rootRoute = createRootRoute({ component: Outlet });

const signInRoute = createRoute({
  getParentRoute: () => rootRoute, path: "/sign-in", component: SignInRoute,
});
const signUpRoute = createRoute({
  getParentRoute: () => rootRoute, path: "/sign-up", component: SignUpRoute,
});
const appRoute = createRoute({
  getParentRoute: () => rootRoute, id: "app", component: RootLayout,
});
const fleetRoute = createRoute({
  getParentRoute: () => appRoute, path: "/", component: FleetRoute,
});

const routeTree = rootRoute.addChildren([
  signInRoute, signUpRoute, appRoute.addChildren([fleetRoute]),
]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register { router: typeof router }
}
