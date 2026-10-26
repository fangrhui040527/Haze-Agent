import { createBrowserRouter } from 'react-router';
import { lazy, Suspense } from 'react';
import { DashboardPage } from '../features/dashboard/DashboardPage.tsx';
import { DemoDataPage } from '../features/demo-data/DemoDataPage.tsx';
import { DetailPage } from '../features/detail/DetailPage.tsx';
import {
  DashboardReportPage,
  TaskPage,
} from '../features/task-report/TaskPage.tsx';
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

/**
 * All pages. To add a page: create src/features/<name>/<Name>Page.tsx and add a route here
 * (plus a NavLink in AppLayout.tsx if it belongs in the header).
 */
export const router = createBrowserRouter([
  {
    element: <AppLayout />,
    errorElement: <RouteErrorPage />,
    children: [
      { index: true, element: <DashboardPage /> },
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
          <Suspense
            fallback={<p role="status">Opening damage accounting...</p>}
          >
            <DamageAccountPage />
          </Suspense>
        ),
      },
      { path: 'task/:id', element: <TaskPage /> },
      { path: 'report/:id', element: <DashboardReportPage /> },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
]);
