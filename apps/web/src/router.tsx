import { createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
import { Shell } from './components/Shell';
import { Dashboard } from './pages/Dashboard';
import { Wallets } from './pages/Wallets';
import { WalletDetail } from './pages/WalletDetail';
import { Screener } from './pages/Screener';
import { TokenCheck } from './pages/TokenCheck';
import { Recs } from './pages/Recs';
import { Funding } from './pages/Funding';
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
export const tokenCheckRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/token-check',
  component: TokenCheck,
  validateSearch: (search: Record<string, unknown>): { mint?: string } =>
    typeof search.mint === 'string' ? { mint: search.mint } : {},
});
export const recsRoute = createRoute({ getParentRoute: () => rootRoute, path: '/recs', component: Recs });
export const fundingRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/funding',
  component: Funding,
  validateSearch: (search: Record<string, unknown>): { address?: string } =>
    typeof search.address === 'string' ? { address: search.address } : {},
});
export const executorRoute = createRoute({ getParentRoute: () => rootRoute, path: '/executor', component: Executor });

const routeTree = rootRoute.addChildren([dashboardRoute, walletsRoute, walletDetailRoute, recsRoute, fundingRoute, screenerRoute, tokenCheckRoute, executorRoute]);

export const router = createRouter({ routeTree });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
