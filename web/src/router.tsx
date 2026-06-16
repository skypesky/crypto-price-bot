import { createHashRouter, Navigate, Outlet } from 'react-router-dom';
import { MainLayout } from './layouts/MainLayout';
import { Login } from './pages/Login';
import { Dashboard } from './pages/Dashboard';
import { Coins } from './pages/Coins';
import { Settings } from './pages/Settings';
import { Reports } from './pages/Reports';
import { Account } from './pages/Account';
import { ProtectedRoute } from './components/ProtectedRoute';

export const router = createHashRouter([
  { path: '/login', element: <Login /> },
  {
    path: '/',
    element: (
      <ProtectedRoute>
        <MainLayout />
      </ProtectedRoute>
    ),
    children: [
      { index: true, element: <Navigate to="/dashboard" replace /> },
      { path: 'dashboard', element: <Dashboard /> },
      { path: 'coins', element: <Coins /> },
      { path: 'settings', element: <Settings /> },
      { path: 'reports', element: <Reports /> },
      { path: 'account', element: <Account /> },
      { path: '*', element: <Outlet /> },
    ],
  },
]);