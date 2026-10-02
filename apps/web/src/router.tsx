import { createBrowserRouter } from 'react-router';
import { Hello } from './pages/Hello';
import { NotFound } from './pages/NotFound';

export const router = createBrowserRouter([
  { path: '/', element: <Hello /> },
  { path: '*', element: <NotFound /> },
]);
