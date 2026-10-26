import { createBrowserRouter } from 'react-router';
import { lazy, Suspense } from 'react';
import { DashboardPage } from '../features/dashboard/DashboardPage.tsx';
import { DemoDataPage } from '../features/demo-data/DemoDataPage.tsx';
import { LandingPage } from '../features/landing/LandingPage.tsx';
import { DetailPage } from '../features/detail/DetailPage.tsx';
import { TaskPage } from '../features/task-report/TaskPage.tsx';
import { AppLayout, NotFoundPage, RouteErrorPage } from './AppLayout.tsx';

const DamageAccountPage = lazy(() =>
  import('../features/damage-account/DamageAccountPage.tsx').then((module) => ({
    default: module.DamageAccountPage,
  })),
);

const ManagerPage = lazy(() =>
  import('../features/manager/ManagerPage.tsx').then((module) => ({
    default: module.ManagerPage,
  })),
);

const WorldModelPage = lazy(() =>
  import('../features/world-model/WorldModelPage.tsx').then((module) => ({
    default: module.WorldModelPage,
  })),
);

const MemoryPage = lazy(() =>
  import('../features/memory/MemoryPage.tsx').then((module) => ({
    default: module.MemoryPage,
  })),
);

/**
 * All pages. To add a page: create src/features/<name>/<Name>Page.tsx and add a route here
 * (plus a NavLink in AppLayout.tsx if it belongs in the header).
 */
export const router = createBrowserRouter([
  { path: '/', element: <LandingPage />, errorElement: <RouteErrorPage /> },
  {
    element: <AppLayout />,
    errorElement: <RouteErrorPage />,
    children: [
      { path: 'dashboard', element: <DashboardPage /> },
      { path: 'item/:id', element: <DetailPage /> },
      { path: 'demo-data', element: <DemoDataPage /> },
      {
        path: 'world-model',
        element: (
          <Suspense fallback={<p role="status">Opening World Model...</p>}>
            <WorldModelPage />
          </Suspense>
        ),
      },
      {
        path: 'memory',
        element: (
          <Suspense fallback={<p role="status">Opening Memory...</p>}>
            <MemoryPage />
          </Suspense>
        ),
      },
      {
        path: 'manager/:taskId?',
        element: (
          <Suspense
            fallback={<p role="status">Opening Manager workspace...</p>}
          >
            <ManagerPage />
          </Suspense>
        ),
      },
      {
        path: 'damage-account/:taskId?',
        element: (
          <Suspense fallback={<p role="status">Opening damage appraisal...</p>}>
            <DamageAccountPage />
          </Suspense>
        ),
      },
      { path: 'task/:id', element: <TaskPage /> },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
]);
