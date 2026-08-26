import { createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
import { Shell } from './components/Shell';
import { Dashboard } from './pages/Dashboard';
import { Wallets } from './pages/Wallets';
import { WalletDetail } from './pages/WalletDetail';
import { Screener } from './pages/Screener';
import { Executor } from './pages/Executor';

const rootRoute = createRootRoute({ component: Shell });

export const dashboardRoute = createRoute({ getParentRoute: () => rootRoute, path: '/', component: Dashboard });
export const walletsRoute = createRoute({ getParentRoute: () => rootRoute, path: '/wallets', component: Wallets });
export const walletDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/wallets/$address',
  component: WalletDetail,
});
export const screenerRoute = createRoute({ getParentRoute: () => rootRoute, path: '/screener', component: Screener });
export const executorRoute = createRoute({ getParentRoute: () => rootRoute, path: '/executor', component: Executor });

const routeTree = rootRoute.addChildren([dashboardRoute, walletsRoute, walletDetailRoute, screenerRoute, executorRoute]);

export const router = createRouter({ routeTree });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
