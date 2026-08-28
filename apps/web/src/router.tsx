import { createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
import { Shell } from './components/Shell';
import { Dashboard } from './pages/Dashboard';
import { Wallets } from './pages/Wallets';
import { WalletDetail } from './pages/WalletDetail';
import { Screener } from './pages/Screener';
import { TokenCheck } from './pages/TokenCheck';
import { Recs } from './pages/Recs';
import { Funding } from './pages/Funding';
import { Discover } from './pages/Discover';
import { Gems } from './pages/Gems';
import { Crawler } from './pages/Crawler';
import { Copyability } from './pages/Copyability';
import { Live } from './pages/Live';
import { Opportunities } from './pages/Opportunities';
import { Tokens } from './pages/Tokens';
import { TokenDetail } from './pages/TokenDetail';
import { Executor } from './pages/Executor';

const rootRoute = createRootRoute({ component: Shell });

export const dashboardRoute = createRoute({ getParentRoute: () => rootRoute, path: '/', component: Dashboard });
export const walletsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/wallets',
  component: Wallets,
  validateSearch: (search: Record<string, unknown>): { sort?: string; dir?: 'asc' | 'desc' } => ({
    ...(typeof search.sort === 'string' ? { sort: search.sort } : {}),
    ...(search.dir === 'asc' || search.dir === 'desc' ? { dir: search.dir } : {}),
  }),
});
export const walletDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/wallets/$address',
  component: WalletDetail,
  validateSearch: (search: Record<string, unknown>): { sort?: string; dir?: 'asc' | 'desc' } => ({
    ...(typeof search.sort === 'string' ? { sort: search.sort } : {}),
    ...(search.dir === 'asc' || search.dir === 'desc' ? { dir: search.dir } : {}),
  }),
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
export const opportunitiesRoute = createRoute({ getParentRoute: () => rootRoute, path: '/opportunities', component: Opportunities });
export const liveRoute = createRoute({ getParentRoute: () => rootRoute, path: '/live', component: Live });
export const crawlerRoute = createRoute({ getParentRoute: () => rootRoute, path: '/crawler', component: Crawler });
export const tokensRoute = createRoute({ getParentRoute: () => rootRoute, path: '/tokens', component: Tokens });
export const tokenDetailRoute = createRoute({ getParentRoute: () => rootRoute, path: '/tokens/$mint', component: TokenDetail });
export const gemsRoute = createRoute({ getParentRoute: () => rootRoute, path: '/gems', component: Gems });
export const discoverRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/discover',
  component: Discover,
  validateSearch: (search: Record<string, unknown>): { mint?: string } =>
    typeof search.mint === 'string' ? { mint: search.mint } : {},
});
export const fundingRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/funding',
  component: Funding,
  validateSearch: (search: Record<string, unknown>): { address?: string } =>
    typeof search.address === 'string' ? { address: search.address } : {},
});
export const copyabilityRoute = createRoute({ getParentRoute: () => rootRoute, path: '/copyability', component: Copyability });
export const executorRoute = createRoute({ getParentRoute: () => rootRoute, path: '/executor', component: Executor });

const routeTree = rootRoute.addChildren([dashboardRoute, walletsRoute, walletDetailRoute, tokensRoute, tokenDetailRoute, recsRoute, fundingRoute, discoverRoute, gemsRoute, opportunitiesRoute, liveRoute, crawlerRoute, screenerRoute, tokenCheckRoute, executorRoute, copyabilityRoute]);

export const router = createRouter({ routeTree });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
