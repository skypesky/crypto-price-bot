import { useEffect, useState } from 'react';
import { Spin } from 'antd';
import { Navigate } from 'react-router-dom';
import { apiGet, type Status } from '../api/client';

export function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<'pending' | 'authed' | 'unauthed'>('pending');

  useEffect(() => {
    apiGet<Status>('/api/status')
      .then((s) => {
        // /api/status 公开，但能 ping 通说明后端活着；再用一个轻量请求判断登录态
        // 这里简单通过 userCount 字段判断（不严格，但够用）
        setStatus(s.userCount >= 0 ? 'authed' : 'unauthed');
      })
      .catch(() => setStatus('unauthed'));
  }, []);

  // 真正判断登录态：尝试拉 /api/settings 一次
  useEffect(() => {
    apiGet('/api/settings')
      .then(() => setStatus('authed'))
      .catch(() => setStatus('unauthed'));
  }, []);

  if (status === 'pending') {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh' }}>
        <Spin size="large" />
      </div>
    );
  }
  if (status === 'unauthed') return <Navigate to="/login" replace />;
  return <>{children}</>;
}