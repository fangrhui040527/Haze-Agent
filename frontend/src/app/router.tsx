import { createBrowserRouter } from 'react-router';
import { lazy, Suspense } from 'react';
import { DashboardPage } from '../features/dashboard/DashboardPage.tsx';
import { DemoDataPage } from '../features/demo-data/DemoDataPage.tsx';
import { LandingPage } from '../features/landing/LandingPage.tsx';
import { DetailPage } from '../features/detail/DetailPage.tsx';
import { TaskPage } from '../features/task-report/TaskPage.tsx';
import { AppLayout, NotFoundPage, RouteErrorPage } from './AppLayout.tsx';

const DemosPage = lazy(() =>
  import('../features/demos/DemosPage.tsx').then((module) => ({
    default: module.DemosPage,
  })),
);
const DamageAccountDemoPage = lazy(() =>
  import('../features/demos/DamageAccountDemoPage.tsx').then((module) => ({
    default: module.DamageAccountDemoPage,
  })),
);
const DamageReductionDemoPage = lazy(() =>
  import('../features/demos/DamageReductionDemoPage.tsx').then((module) => ({
    default: module.DamageReductionDemoPage,
  })),
);

const DamageAccountPage = lazy(() =>
  import('../features/damage-account/DamageAccountPage.tsx').then((module) => ({
    default: module.DamageAccountPage,
  })),
);
const DamageReductionPage = lazy(() =>
  import('../features/damage-reduction/DamageReductionPage.tsx').then(
    (module) => ({ default: module.DamageReductionPage }),
  ),
);
const ReductionProgrammePage = lazy(() =>
  import('../features/damage-reduction/ProgrammePage.tsx').then((module) => ({
    default: module.ReductionProgrammePage,
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

const NightshiftPage = lazy(() =>
  import('../features/nightshift/NightshiftPage.tsx').then((module) => ({
    default: module.NightshiftPage,
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
        path: 'demos',
        element: (
          <Suspense fallback={<p role="status">Opening demos...</p>}>
            <DemosPage />
          </Suspense>
        ),
      },
      ...[
        'demos/damage-account',
        'demos/damage-account/artifacts/:artifactId',
      ].map((path) => ({
        path,
        element: (
          <Suspense fallback={<p role="status">Opening the account demo...</p>}>
            <DamageAccountDemoPage />
          </Suspense>
        ),
      })),
      {
        path: 'demos/damage-reduction',
        element: (
          <Suspense
            fallback={<p role="status">Opening the reduction demo...</p>}
          >
            <DamageReductionDemoPage />
          </Suspense>
        ),
      },
      {
        path: 'nightshift/:jobId?',
        element: (
          <Suspense fallback={<p role="status">Opening Nightshift jobs...</p>}>
            <NightshiftPage />
          </Suspense>
        ),
      },
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
      ...['damage-reduction', 'damage-reduction/tasks/:taskId'].map((path) => ({
        path,
        element: (
          <Suspense
            fallback={
              <p role="status">Opening conditional planning preview...</p>
            }
          >
            <DamageReductionPage />
          </Suspense>
        ),
      })),
      {
        path: 'damage-reduction/programmes/:programmeId',
        element: (
          <Suspense
            fallback={<p role="status">Opening programme coordination…</p>}
          >
            <ReductionProgrammePage />
          </Suspense>
        ),
      },
      { path: 'task/:id', element: <TaskPage /> },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
]);
