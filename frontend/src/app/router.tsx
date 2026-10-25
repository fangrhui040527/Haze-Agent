import { createBrowserRouter } from 'react-router';
import { DashboardPage } from '../features/dashboard/DashboardPage.tsx';
import { DemoDataPage } from '../features/demo-data/DemoDataPage.tsx';
import { DetailPage } from '../features/detail/DetailPage.tsx';
import { TaskPage } from '../features/task-report/TaskPage.tsx';
import { AppLayout, NotFoundPage, RouteErrorPage } from './AppLayout.tsx';

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
      { path: 'task/:id', element: <TaskPage /> },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
]);
